import { ProviderSendError } from "./http";

// Classifying Meta's errors on SEND. An `error 190` — an invalid or revoked token — is not the same thing as a
// transient network failure: the customer can revoke your access on Meta's side at any moment, and retrying a
// dead token blindly will never bring it back. What that needs is a reconnection, not a retry. None of this
// applies to the inbound webhook, which fails in its own ways and has its own code.

interface MetaErrorBody {
  error?: { code?: number };
}

/** Is this `ProviderSendError` an error 190 — a revoked or invalid token? A non-JSON body, or any other code,
 *  answers false and the failure is treated as an ordinary transient one. */
export function isMetaTokenRevokedError(err: unknown): boolean {
  if (!(err instanceof ProviderSendError) || err.provider !== "meta") return false;
  try {
    const parsed = JSON.parse(err.body) as MetaErrorBody;
    return parsed?.error?.code === 190;
  } catch {
    return false;
  }
}

// Classifying a request VALIDATION rejection on send. This exists because of a production incident: two agent
// replies were lost with `transient(meta send failed (400): Param text.body must be at most 4096 characters
// long) · attempts=5`. A 400 from Meta fell into the generic catch, was treated as transient, and burned all
// five retries without escalating to anybody. A VALIDATION rejection — a malformed or out-of-range payload — is
// TERMINAL: retrying the SAME payload gets the SAME rejection. Retrying it is no different from never having
// tried, except that it also spends five calls on the Graph API.
//
// Classification is by STATUS and CODE, NEVER by the English text of the message. Meta changes that wording
// without notice, and a guard that matched on text would go silently dead at the next rewording — a failure
// this codebase has already been bitten by elsewhere.
//
// A 429, or any 5xx, is NEVER terminal here: those are genuinely transient, and doubt resolves in favour of
// retrying. A 400 CAN be throttling in disguise — Meta sometimes sends rate limiting with a 400 instead of a
// 429 — so if the body carries one of the known, STABLE error codes for that, it stays transient despite the
// status. If the body is not JSON, or carries no `code`, we cannot confirm it is a structured validation error
// from Meta, so it is transient too.
//
// ── The fix, and why the default is the whole design ─────────────────────────────────────────────────────────
// The paragraph above was already written when the code fell through to a final `return true`: a missing **or
// unknown** code, with a 400 and a valid JSON body, was classified TERMINAL. Which means the day Meta adds a new
// code, that message is discarded with no retry and no escalation — exactly the scenario this comment claims to
// prevent, and to a real customer.
//
// So classification is an ALLOWLIST of terminal codes, not a default. **What decides the default is the
// asymmetry of the cost, not a preference:** a false terminal loses the customer's message forever; a false
// transient spends five API calls and ends up in the dead-letter queue anyway, **with no data lost**. The two
// mistakes do not cost the same, so there is no tie to break.
//
// The bug that prompted all this stays closed: the 400 for text over 4096 characters arrives with `code: 100` —
// verified against the real stored error from production — so it is NAMED terminal and never burns five retries
// again. Adding a new terminal case is one line with its Meta code.
export const META_TERMINAL_CODES = new Set([
  100, // "Invalid parameter" — the one from the real incident (a body over 4096 characters). The same payload will be
  // rejected the same way, every time.
]);

export const META_TRANSIENT_CODES_DESPITE_400 = new Set([
  4, // "Application request limit reached" (the app's own rate limit)
  17, // "User request limit reached"
  32, // "Page request limit reached"
  80007, // WhatsApp Business Account rate limit hit
  130429, // "Rate limit hit"
  131048, // "Spam rate limit hit"
  131056, // "There are throttling limitations for this app-WABA pair"
]);

/** Is this `ProviderSendError` a request VALIDATION rejection — terminal, do not retry? See the comment above for
 *  the full criterion. A revoked token (`code === 190`) has its own classifier and is excluded here, so the same
 *  decision is never made in two places. */
export function isMetaValidationRejectedError(err: unknown): boolean {
  if (!(err instanceof ProviderSendError) || err.provider !== "meta") return false;
  if (err.status !== 400) return false; // 429 and 5xx never reach here — those are genuinely transient. Only an explicit 400.
  let parsed: MetaErrorBody;
  try {
    parsed = JSON.parse(err.body) as MetaErrorBody;
  } catch {
    return false; // a non-JSON body: we cannot confirm Meta's expected error shape — when in doubt, transient
  }
  const code = parsed?.error?.code;
  if (code === undefined) return false; // a 400 with JSON but no `code`: not a confirmable validation — transient
  if (code === 190) return false; // revoked token — handled by its own classifier, never decided twice
  // The throttling guard sits BEFORE the allowlist deliberately. It is redundant as long as the two sets stay
  // disjoint — there is a test that guarantees they do — but it writes the precedence down: if someone ever added
  // a rate-limit code to the terminal list, "transient" wins, which is the safe side of the asymmetry.
  if (META_TRANSIENT_CODES_DESPITE_400.has(code)) return false; // rate limiting wearing a 400
  // ALLOWLIST: only what we know to be a validation error. An UNKNOWN code is transient — see the comment above:
  // losing the message is irreversible, spending retries is not.
  return META_TERMINAL_CODES.has(code);
}
