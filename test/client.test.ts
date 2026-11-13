import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maskKey } from "../src/core.js";
import MolochAIDefault, {
  APIConnectionError,
  DEFAULT_BASE_URL,
  MolochAI,
  MolochAIError,
  NotFoundError,
  VERSION,
} from "../src/index.js";
import { API_KEY, BASE_URL, client, completion, json, MESSAGES, mockFetch } from "./fixtures.js";

const ENV = ["MOLOCHAI_API_KEY", "MOLOCHAI_BASE_URL", "MOLOCHAI_TIMEOUT", "MOLOCHAI_MAX_RETRIES"];

beforeEach(() => {
  for (const name of ENV) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it("has documented defaults", () => {
    const c = new MolochAI({ apiKey: "k" });
    expect(c.baseURL).toBe("https://api.molochai.dev/api/v1");
    expect(c.baseURL).toBe(DEFAULT_BASE_URL);
    expect(c.timeout).toBe(120_000);
    expect(c.maxRetries).toBe(2);
    expect(c.maxRetryAfter).toBe(60_000);
  });

  it("reads MOLOCHAI_* environment variables", () => {
    vi.stubEnv("MOLOCHAI_API_KEY", "env-key");
    vi.stubEnv("MOLOCHAI_BASE_URL", "http://127.0.0.1:4010/api/v1/");
    vi.stubEnv("MOLOCHAI_TIMEOUT", "2.5");
    vi.stubEnv("MOLOCHAI_MAX_RETRIES", "5");
    const c = new MolochAI();
    expect(c.baseURL).toBe("http://127.0.0.1:4010/api/v1");
    expect(c.timeout).toBe(2_500);
    expect(c.maxRetries).toBe(5);
  });

  it("uses the key from MOLOCHAI_API_KEY", async () => {
    vi.stubEnv("MOLOCHAI_API_KEY", "env-key-value");
    const fetch = mockFetch(json(200, { object: "list", data: [] }));
    await new MolochAI({ fetch }).models.list();
    expect(fetch.calls[0]?.headers.get("authorization")).toBe("Bearer env-key-value");
  });

  it("options win over the environment", () => {
    vi.stubEnv("MOLOCHAI_API_KEY", "env-key");
    vi.stubEnv("MOLOCHAI_TIMEOUT", "5");
    vi.stubEnv("MOLOCHAI_MAX_RETRIES", "5");
    const c = new MolochAI({
      apiKey: "opt",
      timeout: 1_000,
      maxRetries: 0,
      baseURL: "http://127.0.0.1:8001/v1",
    });
    expect(c.timeout).toBe(1_000);
    expect(c.maxRetries).toBe(0);
    expect(c.baseURL).toBe("http://127.0.0.1:8001/v1");
  });

  it("requires an API key", () => {
    expect(() => new MolochAI()).toThrow(MolochAIError);
    expect(() => new MolochAI()).toThrow(/MOLOCHAI_API_KEY/);
    expect(() => new MolochAI()).toThrow(
      "https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node",
    );
  });

  it.each([
    ["MOLOCHAI_TIMEOUT", "abc", /MOLOCHAI_TIMEOUT must be a positive number of seconds/],
    ["MOLOCHAI_TIMEOUT", "0", /MOLOCHAI_TIMEOUT/],
    ["MOLOCHAI_TIMEOUT", "-1", /MOLOCHAI_TIMEOUT/],
    ["MOLOCHAI_MAX_RETRIES", "1.5", /MOLOCHAI_MAX_RETRIES must be a non-negative integer/],
    ["MOLOCHAI_MAX_RETRIES", "-1", /MOLOCHAI_MAX_RETRIES/],
    ["MOLOCHAI_BASE_URL", "not a url", /baseURL must be an http\(s\) URL/],
    ["MOLOCHAI_BASE_URL", "ftp://127.0.0.1/v1", /baseURL/],
  ])("rejects %s=%s", (name, value, pattern) => {
    vi.stubEnv(name, value);
    expect(() => new MolochAI({ apiKey: "k" })).toThrow(pattern);
  });

  it("rejects invalid options", () => {
    expect(() => new MolochAI({ apiKey: "k", timeout: 0 })).toThrow(/timeout/);
    expect(() => new MolochAI({ apiKey: "k", maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => new MolochAI({ apiKey: "k", maxRetryAfter: Number.NaN })).toThrow(/maxRetryAfter/);
  });

  it("refuses to run in a browser unless allowed", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => new MolochAI({ apiKey: "k" })).toThrow(/browser/);
    const fetch = mockFetch(json(200, completion()));
    const c = new MolochAI({ apiKey: "k", dangerouslyAllowBrowser: true, fetch });
    return c.chat.completions.create({ model: "m", messages: MESSAGES }).then(() => {
      expect(fetch.calls[0]?.headers.has("user-agent")).toBe(false);
    });
  });

  it("exports a default", () => {
    expect(MolochAIDefault).toBe(MolochAI);
  });

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("requests", () => {
  it("sends the expected method, URL, headers and body", async () => {
    const fetch = mockFetch(json(200, completion()));
    const c = client(fetch, {
      defaultHeaders: { "X-Trace": "abc", Authorization: "Bearer wrong" },
    });
    const ac = new AbortController();
    await c.chat.completions.create({
      model: "glm-5.3-flash",
      messages: MESSAGES,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 100,
      signal: ac.signal,
      timeout: 5_000,
      maxRetries: 1,
      extraBody: { stop: ["\n"] },
    });
    const call = fetch.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`${BASE_URL}/chat/completions`);
    expect(call?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers.get("content-type")).toBe("application/json");
    expect(call?.headers.get("accept")).toBe("application/json");
    expect(call?.headers.get("user-agent")).toBe(`molochai-node/${VERSION}`);
    expect(call?.headers.get("x-trace")).toBe("abc");
    expect(call?.body).toEqual({
      model: "glm-5.3-flash",
      messages: MESSAGES,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 100,
      stop: ["\n"],
    });
  });

  it("returns the completion with rateLimit from the headers (not enumerable)", async () => {
    const fetch = mockFetch(
      json(200, completion(), { "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "59" }),
    );
    const reply = await client(fetch).chat.completions.create({ model: "m", messages: MESSAGES });
    expect(reply.choices[0]?.message.content).toBe("Hello there");
    expect(reply.choices[0]?.message.reasoning_content).toBe("Thinking hard.");
    expect(reply.usage.total_tokens).toBe(12);
    expect(reply.rateLimit).toEqual({ limit: 60, remaining: 59 });
    expect(JSON.parse(JSON.stringify(reply))).toEqual(completion());
  });

  it("rateLimit fields are null when the headers are missing or junk", async () => {
    const fetch = mockFetch(json(200, completion(), { "X-RateLimit-Limit": "lots" }));
    const reply = await client(fetch).chat.completions.create({ model: "m", messages: MESSAGES });
    expect(reply.rateLimit).toEqual({ limit: null, remaining: null });
  });

  it("throws a clear error for a 200 that is not JSON", async () => {
    const fetch = mockFetch(() => new Response("<html>captive portal</html>", { status: 200 }));
    await expect(
      client(fetch).chat.completions.create({ model: "m", messages: MESSAGES }),
    ).rejects.toThrow(/Expected a JSON response from POST .*\/chat\/completions/);
  });

  it("models.list() returns the data array", async () => {
    const models = [
      {
        id: "glm-5.3-flash",
        object: "model",
        created: 0,
        owned_by: "molochai",
        name: "GLM-5.3-Flash",
        available: true,
      },
    ];
    const fetch = mockFetch(json(200, { object: "list", data: models }));
    expect(await client(fetch).models.list()).toEqual(models);
    expect(fetch.calls[0]?.method).toBe("GET");
    expect(fetch.calls[0]?.url).toBe(`${BASE_URL}/models`);
    expect(fetch.calls[0]?.headers.has("content-type")).toBe(false);
  });

  it("models.list() rejects an unexpected body", async () => {
    const fetch = mockFetch(json(200, { models: [] }));
    await expect(client(fetch).models.list()).rejects.toThrow(/no `data` array/);
  });
});

describe("account", () => {
  const ME = {
    id: 1,
    email: "dev@example.com",
    plan: "pro",
    plan_expires_at: "2026-12-13T00:00:00+00:00",
    tier: "pro",
    credit_usd: 0,
    email_verified: true,
    api_base: BASE_URL,
    default_model: "glm-5.3-flash",
    context_limit: 65536,
    models: [{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", available: true, context_limit: 65536 }],
  };

  it("calls /api/auth/me derived from the base URL", async () => {
    const fetch = mockFetch(json(200, ME));
    const me = await client(fetch).account.retrieve();
    expect(fetch.calls[0]?.url).toBe("https://api.molochai.dev/api/auth/me");
    expect(me.models[0]?.context_limit).toBe(65536);
  });

  it("derives the URL for a local mock too", async () => {
    const fetch = mockFetch(json(200, ME));
    await new MolochAI({
      apiKey: "k",
      baseURL: "http://127.0.0.1:4010/api/v1/",
      fetch,
    }).account.retrieve();
    expect(fetch.calls[0]?.url).toBe("http://127.0.0.1:4010/api/auth/me");
  });

  it("explains a 404 from a server that is not MolochAI", async () => {
    const fetch = mockFetch(json(404, { error: { message: "Not Found" } }));
    const c = new MolochAI({ apiKey: "k", baseURL: "http://127.0.0.1:8000/v1", fetch });
    const err = await c.account.retrieve().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).status).toBe(404);
    expect((err as Error).message).toMatch(/MolochAI endpoint/);
    expect(fetch.calls[0]?.url).toBe("http://127.0.0.1:8000/auth/me");
  });

  it("refuses a base URL that does not end in /v1", async () => {
    const fetch = mockFetch(json(200, ME));
    const c = new MolochAI({ apiKey: "k", baseURL: "http://127.0.0.1:8000/openai", fetch });
    await expect(c.account.retrieve()).rejects.toThrow(/must end in \/v1/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes other errors through", async () => {
    const fetch = mockFetch(json(401, { message: "Unauthenticated." }));
    await expect(client(fetch).account.retrieve()).rejects.toThrow("401 Unauthenticated.");
  });
});

describe("other OpenAI-compatible servers (baseURL override)", () => {
  it("chat and models work against a generic server", async () => {
    const generic = { ...completion(), usage: undefined };
    const fetch = mockFetch(
      json(200, generic),
      json(200, {
        object: "list",
        data: [{ id: "local", object: "model", created: 1, owned_by: "me" }],
      }),
    );
    const c = new MolochAI({ apiKey: "local", baseURL: "http://127.0.0.1:8000/v1", fetch });
    const reply = await c.chat.completions.create({ model: "local", messages: MESSAGES });
    expect(reply.choices[0]?.message.content).toBe("Hello there");
    const models = await c.models.list();
    expect(models[0]?.name).toBeUndefined();
    expect(fetch.calls[0]?.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });
});

describe("key masking", () => {
  it("masks the key in inspect and JSON output", () => {
    const c = client(mockFetch(json(200, {})));
    const inspected = inspect(c, { showHidden: true, depth: 10 });
    expect(inspected).not.toContain(API_KEY);
    expect(inspected).toContain("****mnop");
    expect(JSON.stringify(c)).not.toContain(API_KEY);
    expect(inspect(c.chat.completions, { showHidden: true, depth: 10 })).not.toContain(API_KEY);
    expect(inspect(c.models, { showHidden: true, depth: 10 })).not.toContain(API_KEY);
  });

  it("masks short keys completely", () => {
    expect(maskKey("short")).toBe("****");
    expect(maskKey("x".repeat(19))).toBe("****");
    expect(maskKey(`${"x".repeat(16)}abcd`)).toBe("****abcd");
  });

  it("does not leak the key through connection errors", async () => {
    const fetch = mockFetch(new TypeError(`fetch failed for Bearer ${API_KEY}`));
    const err = await client(fetch, { maxRetries: 0 })
      .chat.completions.create({ model: "m", messages: MESSAGES })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect((err as Error).message).toMatch(/^Could not reach https:\/\/api\.molochai\.dev/);
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it("includes the cause code for network failures", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetch = mockFetch(new TypeError("fetch failed", { cause }));
    const err = await client(fetch, { maxRetries: 0 })
      .models.list()
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("Could not reach https://api.molochai.dev (ECONNREFUSED).");
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it("a non-Error rejection still becomes APIConnectionError", async () => {
    const fetch = mockFetch(() => Promise.reject("boom"));
    const err = await client(fetch, { maxRetries: 0 })
      .models.list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
  });
});
