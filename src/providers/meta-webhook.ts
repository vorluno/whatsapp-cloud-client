import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// The logic of Meta's WhatsApp webhook. PURE and testable: signature verification over the RAW body, plus a
// TOLERANT parse of the payload. The HTTP handler uses this; the actual processing — resolving which tenant the
// message belongs to and materialising it — happens in a worker, on the other side of a queue, with different
// privileges.

// The inbound queue. The producer is the HTTP handler, once the signature checks out; the consumer is the
// worker. Both sides share the prefix.
export const MESSAGING_INBOUND_QUEUE = "messaging-inbound";

// The job IS the raw, already-verified payload. The worker parses it and resolves the tenant — the handler does
// not, because the handler runs with the credentials of something exposed to the internet.
export interface MetaWebhookJob {
  raw: string;
}

/** Verifies `X-Hub-Signature-256: sha256=<hex>` as an HMAC-SHA256 of the raw body, compared in constant time.
 *  No header, or no secret, is false — never a pass. */
export function verifyMetaSignature(rawBody: string, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const got = header.startsWith("sha256=") ? header.slice(7) : header;
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(got, "hex"));
  } catch {
    return false;
  }
}

// An attachment straight off the webhook, BEFORE anything is downloaded or stored. `caption` is the text
// WhatsApp attaches to an image, video or document; audio NEVER carries one, because the Cloud API does not
// expose it for that type.
export interface ParsedInboundMedia {
  mediaId: string;
  mimeType: string;
  kind: "image" | "document" | "audio" | "video";
  caption?: string;
  filename?: string; // only a document has one
}
export interface ParsedInbound {
  phoneNumberId: string;
  providerMessageId: string;
  from: string; // E.164 without the '+'
  body: string;
  name?: string;
  timestamp?: number; // epoch seconds
  media?: ParsedInboundMedia; // present when the message carries an image, document, audio or video
  // Present when the person TAPPED a button or a list option on an interactive message. It is the opaque payload
  // THIS system generated when it sent the message, so the caller matches it against that format and takes a
  // deterministic path — with no model in the loop.
  interactiveReplyId?: string;
  /**
   * The TEXT of the TEMPLATE button the person tapped. Present only on `type: "button"`.
   *
   * This is a DIFFERENT mechanism from the interactive reply id, and the distinction matters: that one carries an
   * opaque id this system chose when sending, so routing on it cannot be wrong. Here Meta exposes no payload of
   * its own — the text IS the contract. Which is why those strings live as constants next to the templates, and a
   * test fails if the router and the template drift apart: changing "Already paid" to "I already paid" would
   * break routing silently.
   */
  templateButtonText?: string;
}
export interface ParsedStatus {
  phoneNumberId: string;
  providerMessageId: string;
  status: string; // sent | delivered | read | failed
  recipientId: string; // E.164 without the '+'
  timestamp?: number;
}
// A template event off the webhook: status in real time, the fast path. The periodic sync is the backstop.
// `event` and `category` arrive RAW from Meta, in upper case; the worker case-folds them and maps them onto the
// stored enum. The template id is normalised from Meta's numeric form to a string, to match how it is stored.
export interface ParsedTemplateEvent {
  metaTemplateId: string;
  event: string; // Meta's RAW event (APPROVED / REJECTED / PAUSED / ...) — plus a synthetic one for a category change
  name?: string;
  language?: string;
  category?: string; // the category, raw, from whichever of the two fields carries it
  reason?: string;
}
export interface ParsedMetaWebhook {
  inbound: ParsedInbound[];
  statuses: ParsedStatus[];
  templateEvents: ParsedTemplateEvent[];
}

// A TOLERANT schema for Meta's payload. Everything is optional, so an unexpected shape never throws — it comes
// back as empty sections.
const MetaPayload = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              // The discriminator of the change. Today it is 'messages'; templates use their own two. Discriminated by
              // `field`, NOT by which keys happen to be present — the second is a guess that works until it does not.
              field: z.string().optional(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }).optional(),
                contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).partial().optional() })).optional(),
                // The media sub-objects, one per type (image, video, document, audio), exactly as the Cloud API declares
                // them. All optional, because the shape is TOLERANT: an unexpected field must not throw.
                messages: z
                  .array(
                    z.object({
                      id: z.string(),
                      from: z.string(),
                      type: z.string(),
                      timestamp: z.string().optional(),
                      text: z.object({ body: z.string() }).optional(),
                      image: z.object({ id: z.string(), mime_type: z.string(), sha256: z.string().optional(), caption: z.string().optional() }).optional(),
                      video: z.object({ id: z.string(), mime_type: z.string(), sha256: z.string().optional(), caption: z.string().optional() }).optional(),
                      document: z
                        .object({
                          id: z.string(),
                          mime_type: z.string(),
                          sha256: z.string().optional(),
                          caption: z.string().optional(),
                          filename: z.string().optional(),
                        })
                        .optional(),
                      // audio NEVER carries a caption — the Cloud API does not expose one for this type.
                      audio: z.object({ id: z.string(), mime_type: z.string(), sha256: z.string().optional() }).optional(),
                      // The interactive reply: `button_reply` for buttons, which is what this system sends today, or
                      // `list_reply` for lists, which it does not send but accepts anyway, in case Meta delivers one
                      // or we add them later. The `id` is the opaque payload we set when sending.
                      interactive: z
                        .object({
                          type: z.string(),
                          button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
                          list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
                        })
                        .optional(),
                      // A TEMPLATE button tap. Both fields carry the text the tenant configured on the template;
                      // `payload` is the one Meta documents as stable and `text` is the one it displays. Both
                      // optional: the parser's shape is tolerant by design.
                      button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
                statuses: z
                  .array(z.object({ id: z.string(), status: z.string(), recipient_id: z.string(), timestamp: z.string().optional() }))
                  .optional(),
                // The value of a template status or category update. The types here are DELIBERATELY PERMISSIVE:
                // a union of string and number, because Meta sends the template id as a NUMBER — and one wrong
                // strict type would fail the parse of the WHOLE payload, losing any inbound message that happened to
                // travel in the same delivery. All optional, so the shape stays tolerant.
                event: z.union([z.string(), z.number()]).optional(),
                message_template_id: z.union([z.string(), z.number()]).optional(),
                message_template_name: z.union([z.string(), z.number()]).optional(),
                message_template_language: z.union([z.string(), z.number()]).optional(),
                message_template_category: z.union([z.string(), z.number()]).optional(),
                new_category: z.union([z.string(), z.number()]).optional(), // category updates only
                reason: z.union([z.string(), z.number()]).optional(),
              }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

// A guard for the media types we support. The predicate narrows the type — a plain `string` in the schema — to
// the literal union, so the rest of the block can reach the sub-objects without casts.
function isMediaType(t: string): t is ParsedInboundMedia["kind"] {
  return t === "image" || t === "document" || t === "audio" || t === "video";
}

// The NORMALISED shape of the four media sub-objects. `caption` and `filename` are optional because audio never
// has a caption and only a document has a filename; the rest simply will not carry them.
interface MediaSubObj {
  id: string;
  mime_type: string;
  caption?: string;
  filename?: string;
}

/** Pulls the inbound messages and the statuses out of a Meta payload. Tolerant: garbage yields empty sections. */
export function parseMetaWebhook(body: unknown): ParsedMetaWebhook {
  const out: ParsedMetaWebhook = { inbound: [], statuses: [], templateEvents: [] };
  const parsed = MetaPayload.safeParse(body);
  if (!parsed.success) return out;

  for (const entry of parsed.data.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;

      // Template events, status and category, discriminated by `field`. They carry no phone number id, so they are
      // resolved BEFORE the guard that requires one — which would otherwise discard them. Which tenant they belong to
      // is resolved by template id, not by number.
      if (change.field === "message_template_status_update" || change.field === "message_template_category_update") {
        const id = v.message_template_id;
        if (id === undefined || id === null) continue; // with no id there is no row to point at
        const isCategoryOnly = change.field === "message_template_category_update";
        out.templateEvents.push({
          metaTemplateId: String(id),
          event: isCategoryOnly ? "CATEGORY_UPDATE" : String(v.event ?? ""),
          name: v.message_template_name != null ? String(v.message_template_name) : undefined,
          language: v.message_template_language != null ? String(v.message_template_language) : undefined,
          category: v.new_category != null ? String(v.new_category) : v.message_template_category != null ? String(v.message_template_category) : undefined,
          reason: v.reason != null ? String(v.reason) : undefined,
        });
        continue;
      }

      const phoneNumberId = v.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const nameByWaId = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));

      for (const m of v.messages ?? []) {
        if (m.type === "text") {
          if (!m.text?.body) continue; // a text message with no body is an inconsistent payload → discard THIS message, not the batch
          out.inbound.push({
            phoneNumberId,
            providerMessageId: m.id,
            from: m.from,
            body: m.text.body,
            name: nameByWaId.get(m.from),
            timestamp: m.timestamp ? Number(m.timestamp) : undefined,
          });
          continue;
        }

        // An interactive reply: the person TAPPED something. `body` is the readable title, so the thread can show what
        // they picked; the reply id is the opaque one the caller parses. With neither a recognisable button nor list
        // reply — an inconsistent payload — THIS message is discarded and the batch is not, same as everywhere else.
        if (m.type === "interactive") {
          const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
          if (!reply) continue;
          out.inbound.push({
            phoneNumberId,
            providerMessageId: m.id,
            from: m.from,
            body: reply.title,
            name: nameByWaId.get(m.from),
            timestamp: m.timestamp ? Number(m.timestamp) : undefined,
            interactiveReplyId: reply.id,
          });
          continue;
        }

        // A TEMPLATE button tap. This branch goes BEFORE the media branch and before the "unsupported type"
        // warning, which is where it used to land: the tap was lost whole and nobody found out.
        if (m.type === "button") {
          const texto = m.button?.text ?? m.button?.payload;
          if (!texto) continue; // with no text there is nothing to route on → discard THIS message, not the batch
          out.inbound.push({
            phoneNumberId,
            providerMessageId: m.id,
            from: m.from,
            // The body carries the button's text so the thread can show WHAT the person tapped. The routing field is
            // kept separate on purpose: the router looks at that field and NEVER at the body, so a contact who types
            // the same words by hand does not trigger the action.
            body: texto,
            name: nameByWaId.get(m.from),
            timestamp: m.timestamp ? Number(m.timestamp) : undefined,
            templateButtonText: texto,
          });
          continue;
        }

        if (isMediaType(m.type)) {
          // the sub-object of the same name carries the media id and mime type — the worker fetches the rest
          const media: MediaSubObj | undefined =
            m.type === "image" ? m.image : m.type === "video" ? m.video : m.type === "document" ? m.document : m.audio;
          if (!media) continue; // `type` says media but the sub-object did not arrive: an inconsistent payload → discard
          out.inbound.push({
            phoneNumberId,
            providerMessageId: m.id,
            from: m.from,
            body: media.caption ?? "", // audio never carries a caption, so the body is empty — there is no text to materialise
            name: nameByWaId.get(m.from),
            timestamp: m.timestamp ? Number(m.timestamp) : undefined,
            media: {
              mediaId: media.id,
              mimeType: media.mime_type,
              kind: m.type,
              caption: media.caption,
              filename: media.filename,
            },
          });
          continue;
        }

        // An unknown type (sticker, location, reaction, ...): NOT discarded in complete silence, so it stays traceable.
        console.warn(`[messaging] meta webhook: unsupported inbound message type (type=${m.type}, id=${m.id})`);
      }
      for (const s of v.statuses ?? []) {
        out.statuses.push({
          phoneNumberId,
          providerMessageId: s.id,
          status: s.status,
          recipientId: s.recipient_id,
          timestamp: s.timestamp ? Number(s.timestamp) : undefined,
        });
      }
    }
  }
  return out;
}
