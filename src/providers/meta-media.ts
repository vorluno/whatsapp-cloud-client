import { type FetchLike, defaultFetch, getJson, ProviderSendError } from "./http";

// Downloading inbound WhatsApp media. Meta's Cloud API exposes media in TWO steps: first a `GET /{media-id}`
// with the bearer, which returns `{ url, mime_type, file_size }` — that signed `url` expires in minutes and is
// never persisted; then a `GET` of that `url` with the SAME bearer, which returns the raw bytes.
//
// Step two is NOT JSON, so it cannot reuse the JSON helpers: it goes through `fetch` directly and reads an
// array buffer. A non-2xx throws `ProviderSendError`, the same type the rest of the adapters throw, so the
// caller's retry classifies it as transient and backs off toward the dead-letter queue like everything else.

export interface FetchMetaMediaOpts {
  fetch?: FetchLike; // injectable for tests; covers step one only (the JSON metadata) — step two uses the global `fetch` directly
  graphVersion?: string;
}

export interface FetchMetaMediaResult {
  bytes: Uint8Array;
  mimeType: string;
  sizeBytes: number;
}

// Meta's legitimate download hosts: the `url` from step one points at their lookaside CDN. The check happens
// BEFORE the bearer is attached, and that ordering is the whole point — if the `url` were ever poisoned or
// redirected to another host, sending first would hand that host the tenant's access token.
const ALLOWED_MEDIA_HOST_SUFFIXES = [".facebook.com", ".fbcdn.net", ".fbsbx.com"];

function isAllowedMediaUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_MEDIA_HOST_SUFFIXES.some((suf) => host === suf.slice(1) || host.endsWith(suf));
  } catch {
    return false;
  }
}

/** Downloads one inbound attachment by its `mediaId`, the one the parsed webhook hands you. */
export async function fetchMetaMedia(
  mediaId: string,
  accessToken: string,
  opts?: FetchMetaMediaOpts,
): Promise<FetchMetaMediaResult> {
  const fetchFn = opts?.fetch ?? defaultFetch;
  const version = opts?.graphVersion ?? process.env.META_WA_GRAPH_VERSION ?? "v21.0";
  const headers = { authorization: `Bearer ${accessToken}` };

  // Step one: metadata plus the signed download URL. JSON, so the shared helper does the work.
  const meta = (await getJson(fetchFn, "meta", `https://graph.facebook.com/${version}/${mediaId}`, headers)) as {
    url?: string;
    mime_type?: string;
    file_size?: number;
  };
  if (!meta.url || !meta.mime_type) {
    throw new Error(`fetchMetaMedia: metadata response carried no url or mime_type (mediaId=${mediaId})`);
  }

  // Security: the `url` comes from Meta's own response, but its host is checked against the allowlist BEFORE the
  // bearer is attached — so an unexpected `url` cannot leak the tenant's token to a third party.
  if (!isAllowedMediaUrl(meta.url)) {
    throw new Error(`fetchMetaMedia: download url outside Meta's allowlist (mediaId=${mediaId})`);
  }

  // Step two: raw bytes from the signed URL — same bearer, but not JSON. The global `fetch` directly, because the
  // injectable `FetchLike` exposes `.text()` and not `.arrayBuffer()`. `redirect: "manual"` matters as much as the
  // host check: a 3xx is NOT followed, so the bearer is never re-sent to wherever the redirect points.
  const res = await fetch(meta.url, { headers, redirect: "manual" });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new ProviderSendError("meta", res.status, errBody);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  return { bytes, mimeType: meta.mime_type, sizeBytes: bytes.byteLength };
}
