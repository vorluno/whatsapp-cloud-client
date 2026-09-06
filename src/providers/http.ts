// HTTP helper for the channel adapters. `FetchLike` is the smallest slice of `fetch` the senders actually use,
// which is what makes it injectable in tests: a mock with no network and no DOM lib. The default wraps the
// global `fetch`.

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; headers?: ResponseHeaders }>;

// Read-only access to the response headers. It is OPTIONAL on `FetchLike` on purpose: the test mocks that came
// first return `{ ok, status, text }` and have to keep compiling. It was added because **some providers return
// the identifier of the thing they just created in a header rather than in the body** — LinkedIn answers with an
// empty body and puts the post's URN in `x-restli-id`. Without this, the only way to learn what was published
// would be a second call asking for "the most recent post", which is guessing.
export interface ResponseHeaders {
  get(name: string): string | null;
}

export const defaultFetch: FetchLike = async (url, init) => {
  // no `body` in the init when there is none (GET) — a `body: ""` can break in stricter runtimes.
  const requestInit: RequestInit = { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
  const res = await fetch(url, requestInit);
  return { ok: res.ok, status: res.status, text: () => res.text(), headers: res.headers };
};

// A send failure from the provider. The caller treats it as TRANSIENT: count the attempt, back off, and give up
// to a dead-letter queue when the attempts run out. A 4xx that is really a policy rejection (an invalid number,
// say) takes the same path for now — acceptable, and telling the two apart is a separate piece of work.
export class ProviderSendError extends Error {
  constructor(
    public provider: string,
    public status: number,
    public body: string,
  ) {
    super(`${provider} send failed (${status}): ${body.slice(0, 300)}`);
    this.name = "ProviderSendError";
  }
}

/** POST JSON. Throws `ProviderSendError` on a non-2xx; returns the parsed JSON, or `{}` if the body is empty. */
export async function postJson(
  fetchFn: FetchLike,
  provider: string,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new ProviderSendError(provider, res.status, text);
  return text ? JSON.parse(text) : {};
}

/** GET. Throws `ProviderSendError` on a non-2xx; returns the parsed JSON, or `{}` if the body is empty. No `body`:
 *  some of Meta's endpoints — the OAuth exchange among them — are a GET with a query string, not a POST. */
export async function getJson(fetchFn: FetchLike, provider: string, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchFn(url, { method: "GET", headers });
  const text = await res.text();
  if (!res.ok) throw new ProviderSendError(provider, res.status, text);
  return text ? JSON.parse(text) : {};
}

/** DELETE. Throws `ProviderSendError` on a non-2xx; returns the parsed JSON, or `{}` if the body is empty. */
export async function deleteJson(fetchFn: FetchLike, provider: string, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchFn(url, { method: "DELETE", headers });
  const text = await res.text();
  if (!res.ok) throw new ProviderSendError(provider, res.status, text);
  return text ? JSON.parse(text) : {};
}

// `uploadMedia` sends raw BYTES as multipart/form-data, not JSON, and the `FetchLike` above — built around a
// string body — cannot represent a `FormData`. `RawFetchLike` is the shape of the NATIVE `fetch`, injectable the
// same way and for the same reason: a test that never touches the network.
export type RawFetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** POST multipart/form-data. Throws `ProviderSendError` on a non-2xx; returns the parsed JSON, or `{}` if the
 *  body is empty. We do NOT set `content-type` in `headers`: `FormData` picks its own boundary, and forcing the
 *  header would strip it and break the request. */
export async function postMultipart(
  fetchFn: RawFetchLike,
  provider: string,
  url: string,
  headers: Record<string, string>,
  form: FormData,
): Promise<unknown> {
  const res = await fetchFn(url, { method: "POST", headers, body: form });
  const text = await res.text();
  if (!res.ok) throw new ProviderSendError(provider, res.status, text);
  return text ? JSON.parse(text) : {};
}

/** The default `RawFetchLike`: wraps the global `fetch`, same as `defaultFetch`. */
export const defaultRawFetch: RawFetchLike = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

// ── Two shapes the OAuth 2.0 adapters need and `postJson` cannot give them ────────────────────────────────────

/**
 * POST `application/x-www-form-urlencoded`. Throws `ProviderSendError` on a non-2xx.
 *
 * Not a style preference: **exchanging a `code` for a token is form-encoded in the standard** (RFC 6749 §4.1.3),
 * and both X and LinkedIn reject it outright if you send JSON. `postJson` cannot be reused because it serialises
 * the body with `JSON.stringify` — changing its header would not change its body.
 */
export async function postForm(
  fetchFn: FetchLike,
  provider: string,
  url: string,
  headers: Record<string, string>,
  fields: Record<string, string>,
): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new ProviderSendError(provider, res.status, text);
  return text ? JSON.parse(text) : {};
}

/**
 * POST JSON that also returns one response header. See `ResponseHeaders`: LinkedIn answers `POST /rest/posts`
 * with an empty body and the post's URN in `x-restli-id`.
 *
 * `header` comes back `null` when the injected `FetchLike` does not expose headers, so the caller decides what to
 * do about the absence instead of receiving an empty string that looks like a value.
 */
export async function postJsonWithHeader(
  fetchFn: FetchLike,
  provider: string,
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  headerName: string,
): Promise<{ json: unknown; header: string | null }> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new ProviderSendError(provider, res.status, text);
  return { json: text ? JSON.parse(text) : {}, header: res.headers?.get(headerName) ?? null };
}
