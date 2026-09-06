// From the CONTRACT, not from the sender module: this file is published, and that module reaches the database
// package on its second line. See the header of `sender-contract.ts`.
import type { MessageSender, SendArgs, SendResult, UploadMediaResult } from "../sender-contract";
import { type FetchLike, type RawFetchLike, defaultFetch, defaultRawFetch, postJson, postMultipart } from "./http";

// The WhatsApp Cloud API adapter. Implements `MessageSender`: free text while the 24-hour service window is
// open, an approved template once it has closed. It does not resolve which number belongs to which tenant —
// the phone number id comes from the environment, and multi-number routing is deliberately elsewhere. `fetch`
// is injectable so tests never touch the network. A non-2xx throws, and the caller backs off toward the
// dead-letter queue.

export interface MetaSenderOpts {
  fetch?: FetchLike;
  rawFetch?: RawFetchLike; // used only by `uploadMedia`, which is multipart — injectable for tests, defaults to the global fetch
  accessToken?: string;
  phoneNumberId?: string;
  graphVersion?: string;
  defaultLanguage?: string; // language code of the template (defaults to Spanish)
}

function readText(variables: unknown): string | undefined {
  return (variables as { text?: string } | null | undefined)?.text;
}

// A button value that is really a URL. Meta CONCATENATES the base it has stored with whatever you send, so a
// whole URL produces `example.org/pay/https://example.org/pay/a3f9x2`. And it does not fail on send: Meta
// accepts the message, the row goes to 'sent', the thread shows it delivered, and the link only breaks when the
// customer TAPS it. It is cut here because this is the last point where the mistake is still visible to us.
const PARECE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:)?\/\/|^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i;

/**
 * The components of a template message. Two kinds of parameter, with different DESTINATIONS:
 *   · the body parameters   → the `body` block, in placeholder order.
 *   · the button parameter  → its OWN `{type:"button", sub_type:"url", index}` block, carrying only the suffix.
 *
 * This used to take a flat list of strings and map all of it onto `body.parameters`: there was nowhere to put
 * the button's parameter, and nine of the thirteen templates have one. With neither present there are no
 * components at all, which is valid — a template without variables is a legitimate template.
 */
function buildTemplate(name: string, variables: unknown, language: string): Record<string, unknown> {
  const v = variables as { params?: string[]; buttonParam?: { index: number; value: string } } | null | undefined;
  const params = v?.params;
  const boton = v?.buttonParam;
  const components: Record<string, unknown>[] = [];

  if (params && params.length > 0) {
    components.push({ type: "body", parameters: params.map((text) => ({ type: "text", text })) });
  }

  // An empty token produces NO block: better a button that leads to the base URL than one that leads nowhere.
  // (The real case — the value could not be resolved — is already cut upstream; this is the last net.)
  if (boton && boton.value) {
    if (PARECE_URL_RE.test(boton.value)) {
      throw new Error(
        `metaSender: the button parameter must be the link SUFFIX, not the whole URL (received: ${boton.value})`,
      );
    }
    // `index` goes as a STRING: Meta rejects the numeric one. And it is emitted WHENEVER there is a button — an
    // `if (button.index)` would swallow index 0, which is also the most common case: a single dynamic URL, first.
    components.push({
      type: "button",
      sub_type: "url",
      index: String(boton.index),
      parameters: [{ type: "text", text: boton.value }],
    });
  }

  return { name, language: { code: language }, components };
}

export function makeMetaSender(opts: MetaSenderOpts = {}): MessageSender {
  const fetchFn = opts.fetch ?? defaultFetch;
  const rawFetchFn = opts.rawFetch ?? defaultRawFetch;
  const token = opts.accessToken ?? process.env.META_WA_ACCESS_TOKEN ?? "";
  const phoneNumberId = opts.phoneNumberId ?? process.env.META_WA_PHONE_NUMBER_ID ?? "";
  const version = opts.graphVersion ?? process.env.META_WA_GRAPH_VERSION ?? "v21.0";
  const language = opts.defaultLanguage ?? "es";

  return {
    async send(args: SendArgs): Promise<SendResult> {
      if (!token || !phoneNumberId) {
        throw new Error("metaSender: missing META_WA_ACCESS_TOKEN / META_WA_PHONE_NUMBER_ID");
      }
      const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
      const headers = { authorization: `Bearer ${token}` };

      // A discriminated union at the payload level: `media` present means a media send, with `type:<kind>` carrying
      // `id`, `caption` and `filename`; the ordinary template and text branches are left UNTOUCHED.
      // A fourth branch: `interactive` present means a button message. `body.text` is the prompt, and each option
      // becomes a `reply` button with its opaque `id` — which the webhook parses when the tap arrives, never a model.
      let payload: Record<string, unknown>;
      if (args.media) {
        const { mediaId, kind, caption, filename } = args.media;
        const mediaObj: Record<string, unknown> = { id: mediaId };
        if (caption) mediaObj.caption = caption;
        if (kind === "document" && filename) mediaObj.filename = filename; // filename only applies to a document
        payload = { messaging_product: "whatsapp", to: args.identifier, type: kind, [kind]: mediaObj };
      } else if (args.interactive) {
        const { body, options } = args.interactive;
        payload = {
          messaging_product: "whatsapp",
          to: args.identifier,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: body },
            action: { buttons: options.map((o) => ({ type: "reply", reply: { id: o.id, title: o.title } })) },
          },
        };
      } else if (args.templateKey) {
        payload = {
          messaging_product: "whatsapp",
          to: args.identifier,
          type: "template",
          template: buildTemplate(args.templateKey, args.variables, args.language ?? language), // per-message language, falling back to the sender's default
        };
      } else {
        const text = readText(args.variables);
        if (!text) throw new Error("metaSender: text message with no body (variables.text)");
        payload = { messaging_product: "whatsapp", to: args.identifier, type: "text", text: { body: text } };
      }

      const json = (await postJson(fetchFn, "meta", url, headers, payload)) as { messages?: { id: string }[] };
      const wamid = json.messages?.[0]?.id;
      if (!wamid) throw new Error("metaSender: response carried no wamid");
      return { providerMessageId: wamid };
    },

    // Uploads BYTES the caller has already read out of storage to Meta's media API: a multipart POST to
    // `/{phoneNumberId}/media`, which is why it uses the multipart helper and not the JSON one. It returns the
    // `mediaId` that `send({ media: { mediaId, ... } })` refers to. An error 190 here is classified as a revoked
    // token by the same helper as everywhere else, because it throws the same error shape.
    async uploadMedia(bytes: Uint8Array, mimeType: string): Promise<UploadMediaResult> {
      if (!token || !phoneNumberId) {
        throw new Error("metaSender: missing META_WA_ACCESS_TOKEN / META_WA_PHONE_NUMBER_ID");
      }
      const url = `https://graph.facebook.com/${version}/${phoneNumberId}/media`;
      const form = new FormData();
      form.set("messaging_product", "whatsapp");
      form.set("type", mimeType);
      // The copy is NOT an oversight and must not be optimised away: `new Blob([bytes])` does not compile against
      // `@types/node` 22 and later, where `BlobPart` requires a `Uint8Array<ArrayBuffer>` and this one arrives as
      // `Uint8Array<ArrayBufferLike>` — which could be backed by shared memory. Inside the monorepo this went
      // unnoticed because the version is pinned there; anyone installing the published package gets the current
      // one and it does not build. Copying anchors it to an `ArrayBuffer` of its own, and an attachment goes
      // through memory once more — which is nothing next to the network call right behind it.
      form.set("file", new Blob([new Uint8Array(bytes)], { type: mimeType }));

      const json = (await postMultipart(rawFetchFn, "meta", url, { authorization: `Bearer ${token}` }, form)) as { id?: string };
      if (!json.id) throw new Error("metaSender: uploadMedia response carried no id");
      return { mediaId: json.id };
    },
  };
}
