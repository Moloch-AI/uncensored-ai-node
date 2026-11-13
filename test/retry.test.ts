import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoff } from "../src/core.js";
import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  ContextLengthExceededError,
  ModelUnavailableError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  ServerBusyError,
  UnprocessableEntityError,
  UpstreamError,
} from "../src/index.js";
import { client, completion, json, MESSAGES, mockFetch, settle, text } from "./fixtures.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(Math, "random").mockReturnValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ok = json(200, completion());

function create(fetch: ReturnType<typeof mockFetch>, options = {}) {
  return client(fetch, options).chat.completions.create({ model: "m", messages: MESSAGES });
}

function gaps(fetch: ReturnType<typeof mockFetch>): number[] {
  return fetch.calls.slice(1).map((c, i) => c.at - (fetch.calls[i]?.at ?? 0));
}

describe("retry matrix: retried with backoff", () => {
  it.each([
    [
      "502 upstream_unreachable",
      json(502, { error: { type: "upstream_unreachable", message: "x" } }),
    ],
    ["502 upstream_error", json(502, { error: { type: "upstream_error", status: 500 } })],
    ["503 server_busy", json(503, { error: { type: "server_busy", message: "Busy." } })],
    ["504 upstream_timeout", json(504, { error: { type: "upstream_timeout", message: "x" } })],
    ["524 Cloudflare HTML", text(524, "<html>timeout</html>")],
    ["500 empty", text(500, "")],
  ])("%s", async (_name, failure) => {
    const fetch = mockFetch(failure, failure, ok);
    const result = await settle(create(fetch));
    expect(result.status).toBe("fulfilled");
    expect(fetch).toHaveBeenCalledTimes(3);
    // Math.random() = 1: full-jitter delay equals the cap for the attempt.
    expect(gaps(fetch)).toEqual([500, 1000]);
  });

  it("connection errors", async () => {
    const fetch = mockFetch(new TypeError("fetch failed"), ok);
    const result = await settle(create(fetch));
    expect(result.status).toBe("fulfilled");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const fetch = mockFetch(json(503, { error: { type: "server_busy" } }));
    const result = await settle(create(fetch));
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ServerBusyError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("maxRetries: 0 disables retries", async () => {
    const fetch = mockFetch(json(502, {}));
    const result = await settle(create(fetch, { maxRetries: 0 }));
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(UpstreamError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a per-request maxRetries overrides the client", async () => {
    const fetch = mockFetch(json(502, {}));
    const result = await settle(
      client(fetch).chat.completions.create({ model: "m", messages: MESSAGES, maxRetries: 4 }),
    );
    expect(result.status).toBe("rejected");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(gaps(fetch)).toEqual([500, 1000, 2000, 4000]);
  });

  it("backoff is capped at 8 s", () => {
    expect(backoff(0)).toBe(500);
    expect(backoff(4)).toBe(8000);
    expect(backoff(10)).toBe(8000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoff(3)).toBe(0);
  });

  it("models.list() uses the same policy", async () => {
    const fetch = mockFetch(
      json(503, { error: { type: "server_busy" } }),
      json(200, { object: "list", data: [] }),
    );
    const result = await settle(client(fetch).models.list());
    expect(result.status).toBe("fulfilled");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("retry matrix: never retried", () => {
  it.each([
    ["401", json(401, { message: "Unauthenticated." }), AuthenticationError],
    ["402", json(402, { error: { type: "no_active_plan" } }), PaymentRequiredError],
    ["403", json(403, { message: "Verify.", code: "email_unverified" }), PermissionDeniedError],
    ["404", json(404, { message: "Not found." }), NotFoundError],
    ["413", json(413, { error: { type: "context_length_exceeded" } }), ContextLengthExceededError],
    [
      "422",
      json(422, { message: "Invalid.", errors: { model: ["Invalid."] } }),
      UnprocessableEntityError,
    ],
    [
      "429 quota",
      json(429, { error: { type: "quota_exceeded", resets_at: "2026-12-01T00:00:00Z" } }),
      QuotaExceededError,
    ],
    [
      "429 session",
      json(429, { error: { type: "session_quota_exceeded", resets_at: "2026-12-01T00:00:00Z" } }),
      QuotaExceededError,
    ],
    [
      "503 model_unavailable",
      json(503, { error: { type: "model_unavailable", model: "m" } }),
      ModelUnavailableError,
    ],
  ])("%s", async (_name, failure, cls) => {
    const fetch = mockFetch(failure, ok);
    const result = await settle(create(fetch));
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(cls);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("rate limit (429 Too Many Attempts)", () => {
  it("waits exactly Retry-After seconds, then retries", async () => {
    const fetch = mockFetch(
      json(429, { message: "Too Many Attempts." }, { "Retry-After": "7" }),
      ok,
    );
    const result = await settle(create(fetch));
    expect(result.status).toBe("fulfilled");
    expect(gaps(fetch)).toEqual([7000]);
  });

  it("throws at once when Retry-After exceeds maxRetryAfter", async () => {
    const fetch = mockFetch(
      json(429, { message: "Too Many Attempts." }, { "Retry-After": "61" }),
      ok,
    );
    const result = await settle(create(fetch));
    expect(result.status).toBe("rejected");
    const err = (result as PromiseRejectedResult).reason as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(61);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maxRetryAfter is configurable (milliseconds)", async () => {
    const fetch = mockFetch(
      json(429, { message: "Too Many Attempts." }, { "Retry-After": "90" }),
      ok,
    );
    const result = await settle(create(fetch, { maxRetryAfter: 120_000 }));
    expect(result.status).toBe("fulfilled");
    expect(gaps(fetch)).toEqual([90_000]);
  });

  it("falls back to backoff without Retry-After", async () => {
    const fetch = mockFetch(json(429, { message: "Too Many Attempts." }), ok);
    await settle(create(fetch));
    expect(gaps(fetch)).toEqual([500]);
  });
});

describe("timeouts and aborts", () => {
  it("times out a request that gets no response, retrying it first", async () => {
    const fetch = mockFetch(() => new Promise<Response>(() => {}));
    const start = Date.now();
    const result = await settle(create(fetch, { timeout: 10_000 }));
    expect(result.status).toBe("rejected");
    const err = (result as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(Date.now() - start).toBe(3 * 10_000 + 500 + 1000);
    // The fetch was told to abort.
    expect(fetch.calls[0]?.signal?.aborted).toBe(true);
  });

  it("a per-request timeout overrides the client", async () => {
    const fetch = mockFetch(() => new Promise<Response>(() => {}));
    const start = Date.now();
    const result = await settle(
      client(fetch).chat.completions.create({
        model: "m",
        messages: MESSAGES,
        timeout: 50,
        maxRetries: 0,
      }),
    );
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(APITimeoutError);
    expect(Date.now() - start).toBe(50);
  });

  it("times out while reading a slow body", async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const fetch = mockFetch(() => new Response(body, { status: 200 }));
    const result = await settle(create(fetch, { timeout: 1_000, maxRetries: 0 }));
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(APITimeoutError);
  });

  it("timeout: Infinity disables the timer", async () => {
    let resolve: (r: Response) => void = () => {};
    const fetch = mockFetch(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const pending = create(fetch, { timeout: Number.POSITIVE_INFINITY });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    resolve(ok());
    await expect(pending).resolves.toMatchObject({ object: "chat.completion" });
  });

  it("aborting during the backoff sleep stops at once", async () => {
    const ac = new AbortController();
    const fetch = mockFetch(json(502, {}));
    const pending = client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      signal: ac.signal,
    });
    const check = expect(pending).rejects.toThrow(APIUserAbortError);
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await check;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborting an in-flight request is never retried", async () => {
    const ac = new AbortController();
    const fetch = mockFetch(() => new Promise<Response>(() => {}));
    const pending = client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      signal: ac.signal,
    });
    const check = expect(pending).rejects.toThrow(APIUserAbortError);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await check;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("an error body that cannot be read is still classified by status", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    const fetch = mockFetch(() => new Response(body, { status: 401 }));
    const result = await settle(create(fetch));
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(AuthenticationError);
  });

  it("a success body that breaks mid-read is a retried connection error", async () => {
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("terminated"));
          },
        }),
        { status: 200 },
      );
    const fetch = mockFetch(broken, ok);
    const result = await settle(create(fetch));
    expect(result.status).toBe("fulfilled");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
