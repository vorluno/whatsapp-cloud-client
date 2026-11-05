/**
 * THE SENDER CONTRACT — **zero imports, and that is its entire property.**
 *
 * WHY IT EXISTS. The provider adapters in this package are what gets published, and they could not be: the
 * WhatsApp adapter imported its types from the sender module, and that module imports a type from the database
 * package. **Two hops, and both of them TYPES** — the dependency you cannot see by reading the code that runs,
 * and that still stops `tsc` from building the tree outside the monorepo it came from. Checking direct imports
 * said everything was clean; following the chain is what found it.
 *
 * THE RULE, and there is only one: **this file imports nothing.** Not from the workspace, not from `node:`, not
 * from npm, not from the file next door. The moment it imports something it stops being good for the only thing
 * it does.
 *
 * WHAT IS NOT DONE HERE: duplicating a database type. `InteractiveMessage` is the shape the sender needs to
 * know, and the module that owns the database type **checks at compile time that the two are still identical**.
 * If they ever drift, what breaks is the private side — which is the side that can still fix it.
 */

/**
 * The channels. `inapp` is the in-product support widget: there is no external provider, the drain materialises
 * it straight onto the thread, and neither the 24-hour window nor external-channel consent applies, because the
 * person asking is already in a contractual relationship.
 */
export type Channel = "whatsapp" | "email" | "inapp";

/**
 * Outgoing media that has ALREADY been uploaded to the provider's media API by `uploadMedia`. `kind` reuses the
 * vocabulary of inbound attachments; `caption` is the message text; `filename` only applies to a document.
 */
export interface SendMedia {
  mediaId: string;
  kind: "image" | "document" | "audio" | "video";
  caption?: string;
  filename?: string;
}

/**
 * An interactive WhatsApp message (at most 3 buttons). `options[].id` is a deterministic token that the caller
 * parses when the tap comes back, **with no model in the loop** — which is what makes a button press a fact
 * rather than something to be interpreted.
 *
 * Graph API limits, which are Meta's and not ours: `title` at most 20 characters, `id` at most 256.
 */
export type InteractiveMessage =
  | { type: "button"; body: string; options: { id: string; title: string }[] }
  | { type: "cta_url"; body: string; label: string; url: string };

/** An email attachment. `content` is the raw bytes; the adapter encodes them however the provider wants. */
export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface SendArgs {
  contactId: string;
  channel: Channel;
  /** E.164 number or email address of the recipient. */
  identifier: string;
  templateKey?: string | null;
  variables?: unknown;
  /** Template language resolved per message; defaults to Spanish. */
  language?: string;
  /**
  * A discriminated union at the PAYLOAD level: with `media` this is a media send and the `caption` replaces the
  * free text; without it, the ordinary text-or-template flow. **Never both at once**: one send is one or the
  * other, never two messages out of a single queue row.
  */
  media?: SendMedia;
  /**
  * Same "never both at once" discipline as `media`: an interactive message carries neither media nor a template.
  * Unlike `media`, which needs a `mediaId` already resolved by `uploadMedia`, the shape here is the SAME one the
  * queue persists — no translation layer — because nothing has to be resolved externally first.
  */
  interactive?: InteractiveMessage;
  /**
  * Email attachments, on the email channel only. The BYTES travel in the body of the call to the provider,
  * **never a URL**: a URL would expose the document behind a link the provider can follow, and these documents
  * carry customer data.
  */
  attachments?: EmailAttachment[];
}

export interface SendResult {
  providerMessageId: string;
}

export interface UploadMediaResult {
  mediaId: string;
}

export interface MessageSender {
  send(args: SendArgs): Promise<SendResult>;
  /**
  * Uploads BYTES — already read out of storage by the caller — to the provider's media API, and returns the
  * `mediaId` that `send({ media: { mediaId, ... } })` then refers to.
  *
  * The provider's HTTP and its token belong to **this** package; storage is **never** imported here. The caller
  * hands over bytes it has already resolved, so neither half has to touch the other's credentials.
  */
  uploadMedia(bytes: Uint8Array, mimeType: string): Promise<UploadMediaResult>;
}
