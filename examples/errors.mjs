// What each error means and what to do about it.
//
//   MOLOCHAI_API_KEY=your-api-key node examples/errors.mjs "Hi"
//
// Against the mock server, markers trigger each case, e.g.
//   node examples/errors.mjs "[mock:quota] hi"      -> QuotaExceededError
//   node examples/errors.mjs "[mock:context] hi"    -> ContextLengthExceededError
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  AuthenticationError,
  ContextLengthExceededError,
  ModelUnavailableError,
  MolochAI,
  PaymentRequiredError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  ServerBusyError,
  UnprocessableEntityError,
  UpstreamError,
} from "molochai";

const MODEL = "glm-5.3-flash";
const client = new MolochAI();

try {
  const reply = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: process.argv[2] ?? "Hi" }],
  });
  console.log(reply.choices[0].message.content);
} catch (err) {
  console.error(explain(err));
  process.exitCode = 1;
}

function explain(err) {
  // Branch on the class and typed fields, never on message text.
  if (err instanceof AuthenticationError)
    return "401: check MOLOCHAI_API_KEY (missing, mistyped or revoked).";
  if (err instanceof PaymentRequiredError) return "402: no active plan and no credit.";
  if (err instanceof PermissionDeniedError)
    return `403 (${err.code}): confirm your email in the dashboard.`;
  if (err instanceof ContextLengthExceededError) {
    return `413: about ${err.estimatedTokens} tokens, limit ${err.contextCap} (set by ${err.boundBy}). Trim the conversation.`;
  }
  if (err instanceof UnprocessableEntityError)
    return `422: invalid request: ${JSON.stringify(err.errors)}`;
  if (err instanceof QuotaExceededError) {
    return `429: ${err.kind ?? "quota"} quota used; resets at ${err.resetsAt?.toISOString() ?? "an unknown time"}. Not retried.`;
  }
  if (err instanceof RateLimitError)
    return `429: rate limited; Retry-After ${err.retryAfter}s was longer than maxRetryAfter.`;
  if (err instanceof ModelUnavailableError)
    return `503: ${err.model} is not being served right now. Pick another from models.list().`;
  if (err instanceof ServerBusyError)
    return "503: no free slot, still busy after retries. Try again shortly.";
  if (err instanceof UpstreamError) {
    return `${err.status}: upstream problem (${err.type ?? "no type"}), still failing after retries. Prefer streaming for long replies.`;
  }
  if (err instanceof APIStatusError) return `${err.status}: ${err.message}`;
  if (err instanceof APITimeoutError) return "Timed out. Raise `timeout` or stream the reply.";
  if (err instanceof APIConnectionError) return `Could not connect: ${err.message}`;
  return `Unexpected error: ${err}`;
}
