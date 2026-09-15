import { type FetchLike, defaultFetch, getJson, postJson } from "./http";

// The backend of WhatsApp's Embedded Signup. This is written from the Tech Provider position, not the BSP one:
// each tenant connects THEIR OWN WhatsApp Business Account and pays Meta directly.
//
// The code exchange and the conversion to a long-lived token are GETs with a query string — checked against
// Meta's documentation rather than assumed, because the obvious guess is a POST with a JSON body and that is
// wrong. Subscribing the app and registering the number ARE POSTs with a bearer, like the sender.

export interface MetaOnboardingOpts {
  fetch?: FetchLike;
  appId?: string;
  appSecret?: string;
  graphVersion?: string;
}

function readOpts(opts?: MetaOnboardingOpts) {
  return {
    fetchFn: opts?.fetch ?? defaultFetch,
    appId: opts?.appId ?? process.env.META_WA_APP_ID ?? "",
    appSecret: opts?.appSecret ?? process.env.META_WA_APP_SECRET ?? "",
    version: opts?.graphVersion ?? process.env.META_WA_GRAPH_VERSION ?? "v21.0",
  };
}

/**
 * Step 1: the single-use OAuth `code` from the browser's `FB.login()` becomes a SHORT-lived token.
 *
 * `redirectUri` is not optional bookkeeping. The JS SDK binds the `code` to the `redirect_uri` of the page where
 * the popup opened, and Meta requires the SAME `redirect_uri` in the exchange or it answers OAuthException
 * code=100 subcode=36008, "redirect_uri is not identical...". The frontend sends it; server-side flows without
 * the JS SDK omit it. The SDK uses the same value for Business Login and for Embedded Signup, so sending it is
 * correct either way.
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri?: string,
  opts?: MetaOnboardingOpts,
): Promise<{ accessToken: string }> {
  const { fetchFn, appId, appSecret, version } = readOpts(opts);
  if (!appId || !appSecret) throw new Error("exchangeCodeForToken: missing META_WA_APP_ID / META_WA_APP_SECRET");
  const qs = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  // `!== undefined`, not `if (redirectUri)`: OMITTING the parameter and sending it EMPTY are different requests.
  // The JS SDK flow sometimes binds the code to an empty redirect_uri, so an explicit `redirect_uri=` has to be
  // sendable.
  if (redirectUri !== undefined) qs.set("redirect_uri", redirectUri);
  const json = (await getJson(fetchFn, "meta", `https://graph.facebook.com/${version}/oauth/access_token?${qs}`, {})) as { access_token?: string };
  if (!json.access_token) throw new Error("exchangeCodeForToken: response carried no access_token");
  return { accessToken: json.access_token };
}

/** Step 2, REQUIRED before persisting or using anything in production: short-lived token → long-lived token. */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  opts?: MetaOnboardingOpts,
): Promise<{ accessToken: string; expiresInSeconds?: number }> {
  const { fetchFn, appId, appSecret, version } = readOpts(opts);
  if (!appId || !appSecret) throw new Error("exchangeForLongLivedToken: missing META_WA_APP_ID / META_WA_APP_SECRET");
  const qs = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });
  const json = (await getJson(fetchFn, "meta", `https://graph.facebook.com/${version}/oauth/access_token?${qs}`, {})) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) throw new Error("exchangeForLongLivedToken: response carried no access_token");
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in };
}

/** Step 3: point that account's webhooks at the app — without it, the customer's inbound messages never arrive. */
export async function subscribeAppToWaba(wabaId: string, accessToken: string, opts?: MetaOnboardingOpts): Promise<void> {
  const { fetchFn, version } = readOpts(opts);
  const url = `https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`;
  await postJson(fetchFn, "meta", url, { authorization: `Bearer ${accessToken}` }, {});
}

/**
 * Step 4: activates the number on the Cloud API. **The `pin` is REQUIRED, always** — not "if the customer has 2FA".
 *
 * For months this function only sent it when provided, with the comment "+pin if the customer has 2FA on the
 * number", and the first real customer who connected a NEW number through Embedded Signup (2026-09-15) hit
 * `(#100) The parameter pin is required`. Meta's documentation is unambiguous: *"pin — Required. If your number already
 * has two-step verification enabled, set this value to its 6-digit PIN. If it does not, set this value to a 6-digit
 * number"* and *"We enforce setting two-step verification during account creation"*. In other words: registering a
 * number IS enabling two-step verification on it; the PIN we send here becomes ITS PIN.
 *
 * That is why the caller decides the PIN first (the customer's, or one generated with `generateTwoStepPin`) and
 * persists it encrypted: if the customer ever moves the number, they will need it. A PIN that only ever existed in
 * one HTTP request is a number nobody can use again.
 */
export async function registerPhoneNumber(phoneNumberId: string, accessToken: string, opts: MetaOnboardingOpts | undefined, pin: string): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new Error("registerPhoneNumber: the two-step verification PIN must be exactly 6 digits");
  const { fetchFn, version } = readOpts(opts);
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}/register`;
  await postJson(fetchFn, "meta", url, { authorization: `Bearer ${accessToken}` }, { messaging_product: "whatsapp", pin });
}

/** A 6-digit PIN for a number that does not have two-step verification yet. Truly random (`crypto`), never
 *  derived from anything guessable (date, number, org). */
export function generateTwoStepPin(): string {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(100000 + (n[0]! % 900000));
}

/** Meta answers 133005 when the number ALREADY has two-step verification and the PIN is not its own. Told apart
 *  so the screen can ask for the right PIN instead of saying "could not connect". */
export function isPinMismatch(error: unknown): boolean {
  const texto = error instanceof Error ? error.message : String(error);
  return /133005|two[- ]step verification pin mismatch|pin mismatch/i.test(texto);
}

// The Embedded Signup popup only posts back the account id and the phone number id — never the number itself in
// E.164. Asking the user to type it is fragile: they can mistype a number that is ALREADY registered with Meta,
// and then nothing matches. It is resolved by querying the Graph API for the phone number id we just received.
export async function fetchPhoneNumberDisplay(
  phoneNumberId: string,
  accessToken: string,
  opts?: MetaOnboardingOpts,
): Promise<{ displayPhoneNumber: string }> {
  const { fetchFn, version } = readOpts(opts);
  const url = `https://graph.facebook.com/${version}/${phoneNumberId}?fields=display_phone_number`;
  const json = (await getJson(fetchFn, "meta", url, { authorization: `Bearer ${accessToken}` })) as { display_phone_number?: string };
  if (!json.display_phone_number) throw new Error("fetchPhoneNumberDisplay: response carried no display_phone_number");
  return { displayPhoneNumber: json.display_phone_number };
}

// Fallback for when the popup does NOT emit the Embedded Signup message with the two ids. That happens when the
// configuration runs Business Login instead — the app has not finished App Review, so Meta falls back to an
// asset grant — and we still hold a valid `code` whose token grants access to whatever accounts the user opted
// in. They can be derived from the token itself:
//   1) inspect the token and read the granted target ids off the management permission's granular scopes;
//   2) list that account's phone numbers and take the first.
// Inspecting the token needs the app access token. If the token grants no account at all — a missing permission —
// or the account has no numbers, this throws naming the step that failed, rather than returning something empty
// that looks like an answer. It also returns the raw E.164, so nothing has to ask the Graph API a second time.
export async function deriveWabaAndPhoneFromToken(
  accessToken: string,
  opts?: MetaOnboardingOpts,
): Promise<{ wabaId: string; phoneNumberId: string; displayPhoneNumber: string; wabaCount: number }> {
  const { fetchFn, appId, appSecret, version } = readOpts(opts);
  if (!appId || !appSecret) throw new Error("deriveWabaAndPhoneFromToken: missing META_WA_APP_ID / META_WA_APP_SECRET");

  const appToken = `${appId}|${appSecret}`;
  const dbgUrl = `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appToken)}`;
  const dbg = (await getJson(fetchFn, "meta", dbgUrl, {})) as {
    data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> };
  };
  const scopes = dbg.data?.granular_scopes ?? [];
  const waScope =
    scopes.find((s) => s.scope === "whatsapp_business_management") ??
    scopes.find((s) => s.scope === "whatsapp_business_messaging");
  const wabaIds = (waScope?.target_ids ?? []).filter(Boolean);
  if (wabaIds.length === 0) {
    throw new Error(
      "deriveWabaAndPhoneFromToken: this token grants access to no WhatsApp Business Account (check that the account was selected in the popup and that the whatsapp_business_management permission was granted)",
    );
  }
  const wabaId = wabaIds[0]!; // the user opted their account in; if there are several we take the first, and the count says so

  const pnUrl = `https://graph.facebook.com/${version}/${wabaId}/phone_numbers?fields=id,display_phone_number`;
  const pn = (await getJson(fetchFn, "meta", pnUrl, { authorization: `Bearer ${accessToken}` })) as {
    data?: Array<{ id?: string; display_phone_number?: string }>;
  };
  const first = (pn.data ?? []).find((p) => p.id);
  if (!first?.id) throw new Error(`deriveWabaAndPhoneFromToken: WhatsApp Business Account ${wabaId} has no phone numbers`);
  return {
    wabaId,
    phoneNumberId: first.id,
    displayPhoneNumber: first.display_phone_number ?? "",
    wabaCount: wabaIds.length,
  };
}
