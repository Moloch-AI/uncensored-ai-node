/**
 * The `MolochAI` client.
 *
 * @module
 */

import {
  type Fetch,
  type RequestSpec,
  type RetryBudget,
  Transport,
  withRateLimit,
} from "./core.js";
import { MolochAIError, NotFoundError } from "./errors.js";
import { ChatCompletionStream } from "./streaming.js";
import type {
  Account,
  ChatCompletion,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  Model,
  RequestOptions,
} from "./types.js";

/** The public MolochAI API. */
export const DEFAULT_BASE_URL = "https://api.molochai.dev/api/v1";
/** 120 seconds. */
export const DEFAULT_TIMEOUT = 120_000;
export const DEFAULT_MAX_RETRIES = 2;
/** 60 seconds. */
export const DEFAULT_MAX_RETRY_AFTER = 60_000;

const KEYS_URL =
  "https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node";

export interface ClientOptions {
  /** API key. Default: `MOLOCHAI_API_KEY`. Required. */
  apiKey?: string;
  /** Default: `MOLOCHAI_BASE_URL`, then `https://api.molochai.dev/api/v1`. */
  baseURL?: string;
  /**
   * Milliseconds to wait for the connection and response headers, and between
   * stream chunks (the gateway sends keep-alive comments about once a second).
   * Default: `MOLOCHAI_TIMEOUT` (seconds), then 120000. `Infinity` disables it.
   */
  timeout?: number;
  /** Retries after the first attempt. Default: `MOLOCHAI_MAX_RETRIES`, then 2. `0` disables retries. */
  maxRetries?: number;
  /**
   * Longest `Retry-After` (milliseconds) a rate-limited request waits before
   * retrying. A longer `Retry-After` throws `RateLimitError` at once. Default 60000.
   */
  maxRetryAfter?: number;
  /** Custom `fetch` (proxies, tests). Default: the global `fetch`. */
  fetch?: Fetch;
  /** Headers sent with every request. `Authorization` is always set from `apiKey`. */
  defaultHeaders?: Record<string, string>;
  /**
   * The key is not scoped (it can read account details and create invoices), so
   * the client refuses to run in a browser. Set this only for local tools you run
   * yourself.
   */
  dangerouslyAllowBrowser?: boolean;
}

/**
 * Client for the MolochAI API.
 *
 * ```ts
 * const client = new MolochAI(); // reads MOLOCHAI_API_KEY
 * const reply = await client.chat.completions.create({
 *   model: "glm-5.3-flash",
 *   messages: [{ role: "user", content: "Hi" }],
 * });
 * ```
 */
export class MolochAI {
  /** Base URL without a trailing slash. */
  readonly baseURL: string;
  /** Milliseconds; see {@link ClientOptions.timeout}. */
  readonly timeout: number;
  readonly maxRetries: number;
  /** Milliseconds; see {@link ClientOptions.maxRetryAfter}. */
  readonly maxRetryAfter: number;
  readonly chat: Chat;
  readonly models: Models;
  readonly account: AccountResource;
  #transport: Transport;

  constructor(options: ClientOptions = {}) {
    const env = readEnv();

    if (!options.dangerouslyAllowBrowser && isBrowser()) {
      throw new MolochAIError(
        "MolochAI API keys must not be used in a browser: they are not scoped and anyone can read them from the page. Call the API from your server, or pass dangerouslyAllowBrowser: true for a local tool only you use.",
      );
    }

    const apiKey = options.apiKey ?? env.MOLOCHAI_API_KEY;
    if (!apiKey) {
      throw new MolochAIError(
        `Missing API key. Pass { apiKey } or set MOLOCHAI_API_KEY. Create a key at ${KEYS_URL}`,
      );
    }

    const baseURL = normalizeBaseURL(
      options.baseURL ?? (env.MOLOCHAI_BASE_URL || DEFAULT_BASE_URL),
    );
    const timeout =
      options.timeout ??
      (env.MOLOCHAI_TIMEOUT
        ? parseSeconds("MOLOCHAI_TIMEOUT", env.MOLOCHAI_TIMEOUT)
        : DEFAULT_TIMEOUT);
    const maxRetries =
      options.maxRetries ??
      (env.MOLOCHAI_MAX_RETRIES
        ? parseCount("MOLOCHAI_MAX_RETRIES", env.MOLOCHAI_MAX_RETRIES)
        : DEFAULT_MAX_RETRIES);
    const maxRetryAfter = options.maxRetryAfter ?? DEFAULT_MAX_RETRY_AFTER;

    if (!(timeout > 0))
      throw new MolochAIError(`timeout must be a positive number of milliseconds, got ${timeout}.`);
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new MolochAIError(`maxRetries must be a non-negative integer, got ${maxRetries}.`);
    }
    if (!(maxRetryAfter >= 0)) {
      throw new MolochAIError(
        `maxRetryAfter must be a non-negative number of milliseconds, got ${maxRetryAfter}.`,
      );
    }

    this.baseURL = baseURL;
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.maxRetryAfter = maxRetryAfter;
    this.#transport = new Transport({
      apiKey,
      baseURL,
      timeout,
      maxRetries,
      maxRetryAfter,
      fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
      defaultHeaders: { ...options.defaultHeaders },
      sendUserAgent: !isBrowser(),
    });
    this.chat = new Chat(this.#transport);
    this.models = new Models(this.#transport);
    this.account = new AccountResource(this.#transport);
  }

  /** A summary safe to log: the key is masked. */
  toJSON(): Record<string, unknown> {
    return {
      baseURL: this.baseURL,
      timeout: this.timeout,
      maxRetries: this.maxRetries,
      maxRetryAfter: this.maxRetryAfter,
      apiKey: this.#transport.config.apiKey,
    };
  }

  /** Node's `util.inspect` / `console.log` output, with the key masked. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    const json = this.toJSON();
    const fields = Object.entries(json)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? `'${v}'` : String(v)}`)
      .join(", ");
    return `MolochAI { ${fields} }`;
  }
}

/** `client.chat`. */
export class Chat {
  readonly completions: Completions;
  /** @internal */
  constructor(transport: Transport) {
    this.completions = new Completions(transport);
  }
}

/** `client.chat.completions`. */
export class Completions {
  #transport: Transport;
  /** @internal */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * `POST /chat/completions`. With `stream: true` resolves to a
   * {@link ChatCompletionStream} once the response headers arrive; otherwise to
   * the whole {@link ChatCompletion}.
   */
  create(params: ChatCompletionCreateParamsStreaming): Promise<ChatCompletionStream>;
  create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
  create(params: ChatCompletionCreateParams): Promise<ChatCompletion | ChatCompletionStream>;
  async create(params: ChatCompletionCreateParams): Promise<ChatCompletion | ChatCompletionStream> {
    const { signal, timeout, maxRetries, extraBody, ...wire } = params;
    const onQueue = "onQueue" in params ? params.onQueue : undefined;
    if ("onQueue" in wire) delete (wire as { onQueue?: unknown }).onQueue;
    const body: Record<string, unknown> = { ...wire, ...extraBody };
    const spec: RequestSpec = {
      method: "POST",
      url: this.#transport.url("/chat/completions"),
      body,
      stream: params.stream === true,
      signal,
      timeout,
      maxRetries,
    };

    if (params.stream !== true) {
      const { data, response } = await this.#transport.json<ChatCompletion>(spec);
      return withRateLimit(data, response.headers);
    }

    // One controller for the whole stream: the caller's signal and stream.abort() both feed it.
    const controller = new AbortController();
    const forward = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", forward, { once: true });
    const cleanup = (): void => signal?.removeEventListener("abort", forward);

    const streamSpec: RequestSpec = { ...spec, signal: controller.signal };
    const budget: RetryBudget = {
      used: 0,
      max: maxRetries ?? this.#transport.config.maxRetries,
    };
    try {
      const attempt = await this.#transport.stream(streamSpec, budget);
      return new ChatCompletionStream({
        transport: this.#transport,
        spec: streamSpec,
        budget,
        attempt,
        controller,
        onQueue,
        cleanup,
      });
    } catch (err) {
      cleanup();
      throw err;
    }
  }
}

/** `client.models`. */
export class Models {
  #transport: Transport;
  /** @internal */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * `GET /models`. Fetch this instead of hard-coding ids: the catalog changes,
   * and `available` says whether a server is serving each model right now.
   */
  async list(options: RequestOptions = {}): Promise<Model[]> {
    const { data } = await this.#transport.json<{ data?: unknown }>({
      method: "GET",
      url: this.#transport.url("/models"),
      ...pick(options),
    });
    if (!Array.isArray(data?.data)) {
      throw new MolochAIError("Unexpected /models response: no `data` array.");
    }
    return data.data as Model[];
  }
}

/** `client.account`. MolochAI only. */
export class AccountResource {
  #transport: Transport;
  /** @internal */
  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * `GET /api/auth/me`: plan, credit, and per-model `context_limit`. The URL is
   * derived from `baseURL` by replacing the trailing `/v1` with `/auth/me`.
   * Throws {@link NotFoundError} with an explanation when `baseURL` points at a
   * server that is not MolochAI.
   */
  async retrieve(options: RequestOptions = {}): Promise<Account> {
    const url = accountURL(this.#transport.config.baseURL);
    try {
      const { data } = await this.#transport.json<Account>({
        method: "GET",
        url,
        ...pick(options),
      });
      return data;
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError(
          `404 ${url} does not exist. account.retrieve() is a MolochAI endpoint (GET /api/auth/me); this baseURL looks like a different OpenAI-compatible server. chat.completions and models still work there.`,
          {
            status: err.status,
            type: err.type,
            body: err.body,
            headers: err.headers,
            requestId: err.requestId,
          },
        );
      }
      throw err;
    }
  }
}

/** @internal `.../api/v1` → `.../api/auth/me`. */
export function accountURL(baseURL: string): string {
  if (!/\/v1$/.test(baseURL)) {
    throw new MolochAIError(
      `Cannot derive the account URL from baseURL ${baseURL}: it must end in /v1 (for example https://api.molochai.dev/api/v1).`,
    );
  }
  return `${baseURL.slice(0, -"/v1".length)}/auth/me`;
}

function pick(options: RequestOptions): Pick<RequestSpec, "signal" | "timeout" | "maxRetries"> {
  return { signal: options.signal, timeout: options.timeout, maxRetries: options.maxRetries };
}

function normalizeBaseURL(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    throw new MolochAIError(`baseURL must be an http(s) URL, got ${JSON.stringify(value)}.`);
  }
  return trimmed;
}

function parseSeconds(name: string, raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new MolochAIError(
      `${name} must be a positive number of seconds, got ${JSON.stringify(raw)}.`,
    );
  }
  return seconds * 1000;
}

function parseCount(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new MolochAIError(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

type EnvName =
  | "MOLOCHAI_API_KEY"
  | "MOLOCHAI_BASE_URL"
  | "MOLOCHAI_TIMEOUT"
  | "MOLOCHAI_MAX_RETRIES";

function readEnv(): Partial<Record<EnvName, string>> {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const out: Partial<Record<EnvName, string>> = {};
  if (!env) return out;
  for (const name of [
    "MOLOCHAI_API_KEY",
    "MOLOCHAI_BASE_URL",
    "MOLOCHAI_TIMEOUT",
    "MOLOCHAI_MAX_RETRIES",
  ] as const) {
    const value = env[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
}

function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== "undefined" && typeof g.document !== "undefined";
}
