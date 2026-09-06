# whatsapp-cloud-client

> A typed WhatsApp Cloud API client for Node. Webhook signature verification first, in constant time
> and fail-closed.

[![npm](https://img.shields.io/npm/v/whatsapp-cloud-client)](https://www.npmjs.com/package/whatsapp-cloud-client)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![types](https://img.shields.io/badge/types-included-blue)](#)

## Install

```bash
npm i whatsapp-cloud-client
```

It ships **TypeScript sources**, not compiled JavaScript, so it needs a TypeScript-aware runtime or
bundler — Bun, `tsx`, Vite, Next, esbuild. That is a deliberate choice for now and not an oversight:
a compiled build is worth adding, and it is not worth pretending to have.

## Example

```ts
import { verifyMetaSignature, parseMetaWebhook } from "whatsapp-cloud-client/webhook";

// In your webhook handler. The RAW body — not the parsed one: re-serialising changes the bytes and
// the signature stops matching, which is the single most common way this check silently never passes.
export async function handler(rawBody: string, headers: Headers) {
  if (!verifyMetaSignature(rawBody, headers.get("x-hub-signature-256"), process.env.META_APP_SECRET ?? "")) {
    return new Response("bad signature", { status: 401 });
  }

  const { inbound, statuses } = parseMetaWebhook(JSON.parse(rawBody));

  for (const message of inbound) {
    // message.from is E.164 without the '+', message.body is the text,
    // message.media is present when it carried an image, document, audio or video.
    console.log(message.from, message.body);
  }
  for (const status of statuses) {
    console.log(status.providerMessageId, status.status); // sent | delivered | read | failed
  }
  return new Response("ok");
}
```

## What it does

- **Verifies the webhook signature** over the raw body, in constant time, and answers false when the
  header or the secret is missing — never a pass by omission.
- **Parses the webhook tolerantly**: an unexpected shape yields empty sections instead of throwing, so
  one malformed message never costs you the rest of the batch.
- **Sends** text, templates, media and interactive messages, and **uploads media** to the Cloud API.
- **Classifies Meta's errors** into what is worth retrying and what is not — including the 400s that
  are really rate limiting in disguise, and the revoked token that no retry will ever fix.
- **Does not:** manage your tenants, store anything, or decide *when* to send. It talks to Meta.

---

## Why it exists

Most of the code you write against the WhatsApp Cloud API is not sending messages — it is the part
around it. Verifying that a webhook is really from Meta. Deciding whether a failure is worth
retrying. Discovering that a media download is two calls and that the second one is not JSON. Finding
out that a button parameter must be the link *suffix*, because Meta concatenates it onto the base it
stored — and that it does not fail on send: the message is accepted, the row says delivered, and the
link only breaks when the customer taps it.

This package is that part, extracted from a system where it runs against live customer conversations.

## Design notes

**The signature check is fail-closed and takes the raw body.** Every other design leaks: comparing
with `===` leaks timing, and re-serialising the parsed body changes the bytes so the check silently
never passes — which looks exactly like "it works" until someone forges a request.

**Errors are classified by status and code, never by message text.** Meta rewrites its English
without notice, and a guard that matches on text goes quietly dead at the next rewording. The default
for an unknown code is *transient*, and that is deliberate: a false terminal loses the customer's
message forever, while a false transient spends a few API calls and ends up in a dead-letter queue
anyway. The two mistakes do not cost the same.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) — it says in the first line whether your pull request will
be considered.

## Security

See [SECURITY.md](./SECURITY.md).

## License

Apache-2.0. See [LICENSE](./LICENSE) and [AUTHORS](./AUTHORS).

---

Built by **[Vorluno](https://vorluno.dev)**, extracted from [niiko](https://niiko.org) — where it
runs in production. Unofficial: not affiliated with, endorsed by, or sponsored by Meta.
