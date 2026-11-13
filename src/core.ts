/**
 * HTTP transport: headers, timeouts, aborts and the retry policy.
 *
 * @internal
 * @module
 */

import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  APIUserAbortError,
  ModelUnavailableError,
  MolochAIError,
  makeStatusError,
  QuotaExceededError,
  RateLimitError,
  redact,
  StreamError,
} from "./errors.js";
import type { RateLimit } from "./types.js";
import { VERSION } from "./version.js";

/** A `fetch`-compatible function. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** @internal */
export interface TransportConfig {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
  maxRetryAfter: number;
  fetch: Fetch;
  defaultHeaders: Record<string, string>;
  sendUserAgent: boolean;
}

/** @internal */
export interface RequestSpec {
  method: "GET" | "POST";
  /** Absolute URL. */
  url: string;
  body?: Record<string, unknown>;
  stream?: boolean;
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
  maxRetries?: number | undefined;
}

/** @internal Shared retry budget: a stream's pre-yield retries draw from the same budget. */
export interface RetryBudget {
  used: number;
  max: number;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;

/** In-stream error types that are safe to retry before anything was yielded. */
const RETRYABLE_STREAM_TYPES = new Set([
  "server_busy",
  "upstream_unreachable",
  "upstream_timeout",
  "upstream_error",
]);

/**
 * One HTTP attempt: its own AbortController, linked to the caller's signal, and
 * an idle timer that runs only while we wait on the network.
 *
 * @internal
 */
export class Attempt {
  readonly controller = new AbortController();
  response!: Response;
  #timeout: number;
  #userSignal: AbortSignal | undefined;
  #error: MolochAIError | null = null;
  #abortPromise: Promise<never>;
  #rejectAbort!: (err: MolochAIError) => void;
  #onUserAbort = (): void => this.#fail(new APIUserAbortError());

  constructor(timeout: number, userSignal?: AbortSignal) {
    this.#timeout = timeout;
    this.#userSignal = userSignal;
    this.#abortPromise = new Promise<never>((_, reject) => {
      this.#rejectAbort = reject;
    });
    this.#abortPromise.catch(() => {});
    if (userSignal?.aborted) this.#fail(new APIUserAbortError());
    else userSignal?.addEventListener("abort", this.#onUserAbort, { once: true });
  }

  /** Wait for `promise`, failing with a timeout if it takes longer than `timeout` ms. */
  async wait<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => {});
    if (this.#error) throw this.#error;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (Number.isFinite(this.#timeout)) {
      timer = setTimeout(() => {
        this.#fail(new APITimeoutError(`No response from the server within ${this.#timeout} ms.`));
      }, this.#timeout);
    }
    try {
      return await Promise.race([promise, this.#abortPromise]);
    } catch (err) {
      if (this.#error) throw this.#error;
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Stop listening to the caller's signal. Does not abort. */
  close(): void {
    this.#userSignal?.removeEventListener("abort", this.#onUserAbort);
  }

  #fail(err: MolochAIError): void {
    if (this.#error) return;
    this.#error = err;
    this.controller.abort(err);
    this.#rejectAbort(err);
  }
}

/** @internal */
export class Transport {
  readonly config: TransportConfig;
  #apiKey: string;

  constructor(config: TransportConfig) {
    const { apiKey, ...rest } = config;
    this.#apiKey = apiKey;
    // Keep the key out of anything that might be logged or inspected.
    this.config = Object.freeze({ ...rest, apiKey: maskKey(apiKey) });
  }

  url(path: string): string {
    return `${this.config.baseURL}${path}`;
  }

  /** Send a request and parse a JSON response, retrying per the policy. */
  async json<T>(spec: RequestSpec): Promise<{ data: T; response: Response }> {
    const budget: RetryBudget = { used: 0, max: spec.maxRetries ?? this.config.maxRetries };
    return this.#withRetries(spec, budget, async (attempt) => {
      let text: string;
      try {
        text = await attempt.wait(attempt.response.text());
      } catch (err) {
        throw toConnectionError(err, "The connection closed while reading the response.");
      }
      try {
        return { data: JSON.parse(text) as T, response: attempt.response };
      } catch {
        throw new MolochAIError(
          `Expected a JSON response from ${spec.method} ${stripQuery(spec.url)} but could not parse it.`,
        );
      }
    });
  }

  /** Send a streaming request; resolves once a 2xx response's headers arrive. */
  async stream(spec: RequestSpec, budget: RetryBudget): Promise<Attempt> {
    return this.#withRetries(spec, budget, async (attempt) => attempt);
  }

  /**
   * Called by a stream that failed before yielding anything. Returns a fresh
   * attempt after the backoff delay, or `null` when the error should surface.
   */
  async retryStream(
    spec: RequestSpec,
    budget: RetryBudget,
    err: MolochAIError,
  ): Promise<Attempt | null> {
    const delay = this.retryDelay(err, budget);
    if (delay === null) return null;
    budget.used++;
    await sleep(delay, spec.signal);
    return this.#withRetries(spec, budget, async (attempt) => attempt);
  }

  /**
   * Milliseconds to wait before the next attempt, or `null` to give up.
   *
   * - connection errors and timeouts, 502, 503 `server_busy`, 504, 524 and
   *   other 5xx: exponential backoff with full jitter (base 500 ms, cap 8 s);
   * - 429 rate limit: `Retry-After`, unless it exceeds `maxRetryAfter`;
   * - never: quota 429, `model_unavailable`, 401/402/403/404/413/422, aborts.
   */
  retryDelay(err: MolochAIError, budget: RetryBudget): number | null {
    if (budget.used >= budget.max) return null;
    if (err instanceof APIUserAbortError) return null;
    if (err instanceof RateLimitError) {
      if (err.retryAfter === null) return backoff(budget.used);
      const ms = err.retryAfter * 1000;
      return ms > this.config.maxRetryAfter ? null : ms;
    }
    if (err instanceof QuotaExceededError || err instanceof ModelUnavailableError) return null;
    if (err instanceof APIConnectionError) return backoff(budget.used);
    if (err instanceof APIStatusError) return err.status >= 500 ? backoff(budget.used) : null;
    if (err instanceof StreamError) {
      if (!RETRYABLE_STREAM_TYPES.has(err.type)) return null;
      if (err.type === "upstream_error" && err.status !== null && err.status < 500) return null;
      return backoff(budget.used);
    }
    return null;
  }

  async #withRetries<R>(
    spec: RequestSpec,
    budget: RetryBudget,
    consume: (attempt: Attempt) => Promise<R>,
  ): Promise<R> {
    for (;;) {
      let failure: MolochAIError;
      try {
        const attempt = await this.#send(spec);
        if (attempt.response.ok) {
          try {
            return await consume(attempt);
          } finally {
            if (!spec.stream) attempt.close();
          }
        }
        let text = "";
        try {
          text = await attempt.wait(attempt.response.text());
        } catch (err) {
          if (err instanceof APIUserAbortError) throw err;
          // Could not read the error body; classify by status alone.
        } finally {
          attempt.close();
        }
        failure = makeStatusError(
          attempt.response.status,
          attempt.response.headers,
          text,
          this.#apiKey,
        );
      } catch (err) {
        if (!(err instanceof APIConnectionError)) throw err;
        failure = err;
      }
      const delay = this.retryDelay(failure, budget);
      if (delay === null) throw failure;
      budget.used++;
      await sleep(delay, spec.signal);
    }
  }

  async #send(spec: RequestSpec): Promise<Attempt> {
    if (spec.signal?.aborted) throw new APIUserAbortError();
    const attempt = new Attempt(spec.timeout ?? this.config.timeout, spec.signal);
    const init: RequestInit = {
      method: spec.method,
      headers: this.#headers(spec),
      signal: attempt.controller.signal,
    };
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
    const fetchFn = this.config.fetch;
    try {
      attempt.response = await attempt.wait(fetchFn(spec.url, init));
    } catch (err) {
      attempt.close();
      throw toConnectionError(err, `Could not reach ${originOf(spec.url)}.`, this.#apiKey);
    }
    return attempt;
  }

  #headers(spec: RequestSpec): Headers {
    const headers = new Headers({
      Accept: spec.stream ? "text/event-stream" : "application/json",
    });
    if (spec.body !== undefined) headers.set("Content-Type", "application/json");
    if (this.config.sendUserAgent) headers.set("User-Agent", `molochai-node/${VERSION}`);
    for (const [name, value] of Object.entries(this.config.defaultHeaders))
      headers.set(name, value);
    headers.set("Authorization", `Bearer ${this.#apiKey}`);
    return headers;
  }
}

/** @internal Map anything thrown by fetch or a body read to an SDK error. */
export function toConnectionError(err: unknown, message: string, secret?: string): MolochAIError {
  if (err instanceof MolochAIError) return err;
  const detail = describeCause(err);
  const text = detail ? `${message.replace(/\.$/, "")} (${detail}).` : message;
  return new APIConnectionError(secret ? redact(text, secret) : text, { cause: err });
}

function describeCause(err: unknown): string {
  if (!(err instanceof Error)) return "";
  const cause = (err as { cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code: unknown }).code)
      : "";
  return code || err.message;
}

/** @internal Full-jitter exponential backoff. `retry` is 0 for the first retry. */
export function backoff(retry: number): number {
  return Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** retry);
}

/** @internal Sleep that rejects with APIUserAbortError when `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new APIUserAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new APIUserAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** @internal */
export function readRateLimit(headers: Headers): RateLimit {
  return {
    limit: intHeader(headers.get("x-ratelimit-limit")),
    remaining: intHeader(headers.get("x-ratelimit-remaining")),
  };
}

/** @internal Attach `rateLimit` as a non-enumerable property. */
export function withRateLimit<T extends object>(target: T, headers: Headers): T {
  Object.defineProperty(target, "rateLimit", {
    value: readRateLimit(headers),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return target;
}

/** @internal `****abcd` for long keys, `****` otherwise. */
export function maskKey(key: string): string {
  return key.length >= 20 ? `****${key.slice(-4)}` : "****";
}

function intHeader(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "the server";
  }
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}
