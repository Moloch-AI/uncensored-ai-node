/**
 * Error classes. Every error the SDK throws is a `MolochAIError`.
 *
 * ```
 * MolochAIError
 * ├── APIConnectionError          network failure, connection dropped mid-stream
 * │   └── APITimeoutError         no response / no stream data within `timeout`
 * ├── APIUserAbortError           your AbortSignal fired, or stream.abort()
 * ├── StreamError                 error event inside an open stream (HTTP 200)
 * └── APIStatusError              non-2xx HTTP response
 *     ├── AuthenticationError         401
 *     ├── PaymentRequiredError        402 no_active_plan
 *     ├── PermissionDeniedError       403 email_unverified
 *     ├── NotFoundError               404
 *     ├── ContextLengthExceededError  413 context_length_exceeded
 *     ├── UnprocessableEntityError    422 validation
 *     ├── RateLimitError              429 Too Many Attempts (Retry-After)
 *     ├── QuotaExceededError          429 session / monthly / weekly quota
 *     ├── ModelUnavailableError       503 model_unavailable
 *     ├── ServerBusyError             503 server_busy (and other 503s)
 *     └── UpstreamError               502, 504, 524, other 5xx, upstream_error
 * ```
 *
 * Code should branch on the class, `status`, `type` and the typed fields,
 * never on message text: messages are written for people and can change.
 *
 * @module
 */

/** Base class for every error thrown by this SDK. */
export class MolochAIError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MolochAIError";
  }
}

/** The request never got an HTTP response, or the connection dropped while streaming. */
export class APIConnectionError extends MolochAIError {
  constructor(message = "Connection error.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "APIConnectionError";
  }
}

/** Nothing arrived from the server within `timeout` (connect, headers, or between stream chunks). */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request timed out.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "APITimeoutError";
  }
}

/** Your `AbortSignal` fired, or you called `stream.abort()`. Never retried. */
export class APIUserAbortError extends MolochAIError {
  constructor(message = "Request was aborted.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "APIUserAbortError";
  }
}

/** Fields shared by every {@link APIStatusError}. */
export interface APIStatusErrorInit {
  status: number;
  type: string | null;
  body: unknown;
  headers: Headers;
  requestId: string | null;
}

/** The server answered with a non-2xx status. */
export class APIStatusError extends MolochAIError {
  /** HTTP status code. */
  readonly status: number;
  /**
   * Machine-readable error type: `error.type` from a gateway error body
   * (`quota_exceeded`, `server_busy`, ...), or `code` from a bare-message body
   * (`email_unverified`). `null` when the body has neither.
   */
  readonly type: string | null;
  /** Parsed JSON body, the raw text when the body is not JSON, or `null` when empty. */
  readonly body: unknown;
  /** Response headers. */
  readonly headers: Headers;
  /** `request_id` from the body, or the `x-request-id` header. Quote it when you contact support. */
  readonly requestId: string | null;

  constructor(message: string, init: APIStatusErrorInit) {
    super(message);
    this.name = "APIStatusError";
    this.status = init.status;
    this.type = init.type;
    this.body = init.body;
    this.headers = init.headers;
    this.requestId = init.requestId;
  }
}

/** 401: the key is missing, mistyped or revoked. */
export class AuthenticationError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "AuthenticationError";
  }
}

/** 402 `no_active_plan`: no active plan and no credit. */
export class PaymentRequiredError extends APIStatusError {
  /** `plan` from the body, when present. */
  readonly plan: string | null;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "PaymentRequiredError";
    this.plan = str(errorObject(init.body)?.plan);
  }
}

/** 403, for example `code: "email_unverified"` (confirm your email in the dashboard). */
export class PermissionDeniedError extends APIStatusError {
  /** `code` from the body (`email_unverified`), when present. */
  readonly code: string | null;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "PermissionDeniedError";
    this.code = str(asRecord(init.body)?.code) ?? init.type;
  }
}

/**
 * 404. Against MolochAI this usually means a wrong `baseURL`. `account.retrieve()`
 * also throws it when `baseURL` points at a server that has no `/auth/me`.
 */
export class NotFoundError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "NotFoundError";
  }
}

/** 413 `context_length_exceeded`: the prompt does not fit. Trim the conversation and retry. */
export class ContextLengthExceededError extends APIStatusError {
  /** The gateway's estimate of the prompt size, in tokens. */
  readonly estimatedTokens: number | null;
  /** The context limit that applied, in tokens. */
  readonly contextCap: number | null;
  /** Which limit applied: `"plan"` or `"server"`. */
  readonly boundBy: string | null;
  /** Your plan, when present. */
  readonly plan: string | null;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "ContextLengthExceededError";
    const e = errorObject(init.body);
    this.estimatedTokens = num(e?.estimated_tokens);
    this.contextCap = num(e?.context_cap);
    this.boundBy = str(e?.bound_by);
    this.plan = str(e?.plan);
  }
}

/** 422: the request failed validation (unknown model id, empty messages, out-of-range sampling). */
export class UnprocessableEntityError extends APIStatusError {
  /** Field name to messages, e.g. `{ model: ["The selected model is invalid."] }`. */
  readonly errors: Record<string, string[]>;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "UnprocessableEntityError";
    this.errors = {};
    const raw = asRecord(asRecord(init.body)?.errors);
    if (raw) {
      for (const [field, value] of Object.entries(raw)) {
        this.errors[field] = Array.isArray(value) ? value.map(String) : [String(value)];
      }
    }
  }
}

/**
 * 429 `Too Many Attempts.`: over the per-account request rate. Retried
 * automatically when `Retry-After` is within `maxRetryAfter`.
 */
export class RateLimitError extends APIStatusError {
  /** Seconds to wait, from the `Retry-After` header. `null` when the header is missing. */
  readonly retryAfter: number | null;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "RateLimitError";
    this.retryAfter = parseRetryAfter(init.headers.get("retry-after"));
  }
}

/** Which quota ran out. */
export type QuotaKind = "session" | "monthly" | "weekly";

/**
 * 429 `quota_exceeded` or `session_quota_exceeded`. Never retried automatically:
 * it will not pass before `resetsAt`.
 */
export class QuotaExceededError extends APIStatusError {
  /** When the quota resets (`resets_at`). `null` if the body did not say. */
  readonly resetsAt: Date | null;
  /** `"session"` (5-hour window), `"monthly"` or `"weekly"`; `null` if the body did not say. */
  readonly kind: QuotaKind | null;
  /** Your plan, when present. */
  readonly plan: string | null;
  /** `monthly_used` / `weekly_used`, when present. */
  readonly used: number | null;
  /** `monthly_cap` / `weekly_cap`, when present. */
  readonly cap: number | null;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "QuotaExceededError";
    const e = errorObject(init.body);
    const resets = str(e?.resets_at);
    const parsed = resets === null ? Number.NaN : Date.parse(resets);
    this.resetsAt = Number.isNaN(parsed) ? null : new Date(parsed);
    this.plan = str(e?.plan);
    if (init.type === "session_quota_exceeded") {
      this.kind = "session";
      this.used = null;
      this.cap = null;
    } else if (e && ("monthly_cap" in e || "monthly_used" in e)) {
      this.kind = "monthly";
      this.used = num(e.monthly_used);
      this.cap = num(e.monthly_cap);
    } else if (e && ("weekly_cap" in e || "weekly_used" in e)) {
      this.kind = "weekly";
      this.used = num(e.weekly_used);
      this.cap = num(e.weekly_cap);
    } else {
      this.kind = null;
      this.used = null;
      this.cap = null;
    }
  }
}

/**
 * 503 `model_unavailable`: the id is known but no server is serving it right now.
 * Not retried automatically; pick another model from `client.models.list()`.
 */
export class ModelUnavailableError extends APIStatusError {
  /** The model id from the body. */
  readonly model: string | null;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "ModelUnavailableError";
    this.model = str(errorObject(init.body)?.model);
  }
}

/** 503 `server_busy` (and any other 503 that is not `model_unavailable`). Retried with backoff. */
export class ServerBusyError extends APIStatusError {
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "ServerBusyError";
  }
}

/**
 * 502, 504, 524 (edge timeout on a long non-streamed request), other 5xx, and
 * `upstream_error`. Retried with backoff when the HTTP status is 5xx.
 */
export class UpstreamError extends APIStatusError {
  /** For `upstream_error`: the status the serving server returned (`error.status`). */
  readonly upstreamStatus: number | null;
  constructor(message: string, init: APIStatusErrorInit) {
    super(message, init);
    this.name = "UpstreamError";
    this.upstreamStatus = num(errorObject(init.body)?.status);
  }
}

/**
 * An error event inside a stream that had already opened with HTTP 200, e.g.
 * `data: {"error":{"type":"upstream_timeout","message":"...","elapsed_s":181.2}}`.
 *
 * Types seen: `server_busy`, `upstream_unreachable`, `upstream_timeout`,
 * `upstream_error` (has `status`), `preempted` (the server was reclaimed
 * mid-reply; retry in about a minute).
 */
export class StreamError extends MolochAIError {
  /** `error.type` from the event, or `"unknown"`. */
  readonly type: string;
  /** `error.status` (for `upstream_error`), when present. */
  readonly status: number | null;
  /** `error.elapsed_s`, when present. */
  readonly elapsedSeconds: number | null;
  /** `error.request_id`, when present. */
  readonly requestId: string | null;
  /** The full `error` object from the event. */
  readonly data: Record<string, unknown>;

  constructor(data: Record<string, unknown>) {
    const type = str(data.type) ?? "unknown";
    const message = str(data.message) ?? "The server reported an error in the stream.";
    super(`Stream error (${type}): ${message}`);
    this.name = "StreamError";
    this.type = type;
    this.status = num(data.status);
    this.elapsedSeconds = num(data.elapsed_s);
    this.requestId = str(data.request_id);
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Mapping an HTTP error response to a class.
// ---------------------------------------------------------------------------

/** @internal Build the right {@link APIStatusError} subclass from a response. */
export function makeStatusError(
  status: number,
  headers: Headers,
  rawText: string,
  secret?: string,
): APIStatusError {
  const text = secret ? redact(rawText, secret) : rawText;
  let body: unknown = text.length > 0 ? text : null;
  let isJSON = false;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
      isJSON = true;
    } catch {
      // Not JSON (Cloudflare HTML pages, proxies). Keep the raw text.
    }
  }

  const record = isJSON ? asRecord(body) : null;
  const errObj = asRecord(record?.error);
  const type = str(errObj?.type) ?? str(record?.code);
  const serverMessage = str(errObj?.message) ?? str(record?.message);
  const requestId = str(errObj?.request_id) ?? headers.get("x-request-id");

  let message: string;
  if (serverMessage !== null) {
    message = `${status} ${type && errObj ? `${type}: ` : ""}${serverMessage}`;
  } else if (type !== null) {
    message = `${status} ${type}`;
  } else if (status === 524) {
    message =
      "524 The edge timed out waiting for the API (non-JSON body). Long non-streamed generations can hit this limit; use stream: true.";
  } else if (text.length === 0) {
    message = `${status} (empty response body)`;
  } else if (!isJSON) {
    message = `${status} (non-JSON response body)`;
  } else {
    message = `${status} (unrecognized error body)`;
  }

  const init: APIStatusErrorInit = { status, type, body, headers, requestId };

  switch (status) {
    case 401:
      return new AuthenticationError(message, init);
    case 402:
      return new PaymentRequiredError(message, init);
    case 403:
      return new PermissionDeniedError(message, init);
    case 404:
      return new NotFoundError(message, init);
    case 413:
      return new ContextLengthExceededError(message, init);
    case 422:
      return new UnprocessableEntityError(message, init);
    case 429:
      if (
        type === "quota_exceeded" ||
        type === "session_quota_exceeded" ||
        (errObj !== null && "resets_at" in errObj)
      ) {
        return new QuotaExceededError(message, init);
      }
      return new RateLimitError(message, init);
    case 503:
      if (type === "model_unavailable") return new ModelUnavailableError(message, init);
      return new ServerBusyError(message, init);
  }
  if (status >= 500 || type === "upstream_error") return new UpstreamError(message, init);
  return new APIStatusError(message, init);
}

/** @internal Parse a `Retry-After` header (delta-seconds or HTTP date) into seconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** @internal Replace every occurrence of `secret` in `text`. */
export function redact(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[redacted]");
}

/** @internal */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorObject(body: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(body)?.error);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}
