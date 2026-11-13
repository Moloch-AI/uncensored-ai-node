/**
 * Runs against the MolochAI mock server from
 * https://github.com/Moloch-AI/uncensored-ai-api (mock-server/server.mjs).
 * Skipped unless MOLOCHAI_MOCK_BASE_URL is set, e.g.
 *   MOLOCHAI_MOCK_BASE_URL=http://127.0.0.1:4012/api/v1 npm run test:integration
 */
import { describe, expect, it } from "vitest";
import {
  APITimeoutError,
  AuthenticationError,
  CAP_NOTICE,
  ContextLengthExceededError,
  ModelUnavailableError,
  MolochAI,
  PaymentRequiredError,
  PermissionDeniedError,
  type QueueInfo,
  QuotaExceededError,
  RateLimitError,
  ServerBusyError,
  StreamError,
  splitThink,
  UnprocessableEntityError,
  UpstreamError,
} from "../../src/index.js";

const BASE_URL = process.env.MOLOCHAI_MOCK_BASE_URL;
const MODEL = "glm-5.3-flash";
const nonce = () => Math.random().toString(36).slice(2);

function mock(apiKey = "mock-key", options: { maxRetries?: number; timeout?: number } = {}) {
  return new MolochAI({ apiKey, baseURL: BASE_URL, ...options });
}

function ask(content: string) {
  return { model: MODEL, messages: [{ role: "user" as const, content }] };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe.skipIf(!BASE_URL)("integration: mock server", () => {
  it("lists models with name and available", async () => {
    const models = await mock().models.list();
    expect(models.map((m) => m.id)).toContain(MODEL);
    for (const m of models) {
      expect(typeof m.name).toBe("string");
      expect(typeof m.available).toBe("boolean");
    }
  });

  it("retrieves the account with per-model context limits", async () => {
    const me = await mock().account.retrieve();
    expect(me.email_verified).toBe(true);
    expect(me.context_limit).toBe(65536);
    expect(me.models.find((m) => m.id === MODEL)?.context_limit).toBe(65536);
  });

  it("non-streaming chat: content, reasoning, usage, rate-limit headers", async () => {
    const reply = await mock().chat.completions.create(ask("Hi"));
    const choice = reply.choices[0];
    expect(choice?.message.content).toBe(`Mock reply from ${MODEL}: Hi`);
    expect(choice?.message.reasoning_content).toBe(`Mock reasoning for ${MODEL}.`);
    expect(choice?.finish_reason).toBe("stop");
    expect(reply.model).toBe(MODEL);
    expect(reply.usage.total_tokens).toBe(
      reply.usage.prompt_tokens + reply.usage.completion_tokens,
    );
    expect(reply.rateLimit.limit).toBeGreaterThan(0);
    expect(reply.rateLimit.remaining).not.toBeNull();
  });

  it("streaming chat: deltas, usage chunk and final completion agree", async () => {
    const stream = await mock().chat.completions.create({ ...ask("Hello stream"), stream: true });
    let text = "";
    let usageChunks = 0;
    for await (const chunk of stream) {
      if (chunk.choices.length === 0) {
        usageChunks++;
        expect(chunk.usage?.total_tokens).toBeGreaterThan(0);
      }
      text += chunk.choices[0]?.delta.content ?? "";
    }
    const final = await stream.finalCompletion();
    expect(text).toBe(`Mock reply from ${MODEL}: Hello stream`);
    expect(final.choices[0]?.message.content).toBe(text);
    expect(final.choices[0]?.message.reasoning_content).toBe(`Mock reasoning for ${MODEL}.`);
    expect(usageChunks).toBe(1);
    expect(final.usage.total_tokens).toBeGreaterThan(0);
  });

  it("reports queue progress", async () => {
    const queue: QueueInfo[] = [];
    const stream = await mock().chat.completions.create({
      ...ask("[mock:queue] hi"),
      stream: true,
      onQueue: (q) => queue.push(q),
    });
    let text = "";
    for await (const t of stream.textDeltas()) text += t;
    expect(text).toContain("Mock reply");
    expect(queue.map((q) => q.position)).toEqual([2, 1]);
    expect(queue.map((q) => q.waitedSeconds)).toEqual([1, 2]);
  });

  it("tool calls: non-streaming, streaming, and the follow-up turn", async () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "get_weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" }, days: { type: "integer" } },
          },
        },
      },
    ];
    const client = mock();
    const reply = await client.chat.completions.create({ ...ask("Weather in Oslo?"), tools });
    const call = reply.choices[0]?.message.tool_calls?.[0];
    expect(reply.choices[0]?.finish_reason).toBe("tool_calls");
    expect(reply.choices[0]?.message.content).toBeNull();
    expect(call?.function.name).toBe("get_weather");
    expect(JSON.parse(call?.function.arguments ?? "")).toEqual({ city: "example", days: 1 });

    const stream = await client.chat.completions.create({
      ...ask("Weather?"),
      tools,
      stream: true,
    });
    const final = await stream.finalCompletion();
    expect(final.choices[0]?.finish_reason).toBe("tool_calls");
    expect(final.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("get_weather");

    if (!call) throw new Error("no tool call");
    const next = await client.chat.completions.create({
      model: MODEL,
      tools,
      messages: [
        { role: "user", content: "Weather in Oslo?" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: '{"temp_c": 4}' },
      ],
    });
    expect(next.choices[0]?.message.content).toBe(
      `Mock reply from ${MODEL} after tool get_weather: {"temp_c": 4}`,
    );
  });

  it("cap notice and inline think", async () => {
    const capped = await mock().chat.completions.create(ask("[mock:cap] long"));
    expect(capped.choices[0]?.finish_reason).toBe("length");
    expect(capped.choices[0]?.message.content?.endsWith(CAP_NOTICE)).toBe(true);

    const inline = await mock().chat.completions.create(ask("[mock:inline-think] hi"));
    const split = splitThink(inline.choices[0]?.message.content);
    expect(split.reasoning).toBe("Mock inline reasoning.");
    expect(split.answer).toMatch(/^Mock reply from/);
  });

  it("maps auth errors", async () => {
    expect(await failure(mock(" ").models.list())).toBeInstanceOf(AuthenticationError);
    const noPlan = await failure(mock("mock-no-plan").models.list());
    expect(noPlan).toBeInstanceOf(PaymentRequiredError);
    expect((noPlan as PaymentRequiredError).type).toBe("no_active_plan");
    const unverified = await failure(mock("mock-unverified").models.list());
    expect(unverified).toBeInstanceOf(PermissionDeniedError);
    expect((unverified as PermissionDeniedError).code).toBe("email_unverified");
  });

  it("maps validation, quota, context and availability errors", async () => {
    const client = mock();
    const invalid = await failure(client.chat.completions.create({ ...ask("hi"), model: "nope" }));
    expect(invalid).toBeInstanceOf(UnprocessableEntityError);
    expect(Object.keys((invalid as UnprocessableEntityError).errors)).toContain("model");

    const quota = (await failure(
      client.chat.completions.create(ask("[mock:quota]")),
    )) as QuotaExceededError;
    expect(quota).toBeInstanceOf(QuotaExceededError);
    expect(quota.kind).toBe("monthly");
    expect(quota.resetsAt).toBeInstanceOf(Date);

    const session = (await failure(
      client.chat.completions.create(ask("[mock:session-quota]")),
    )) as QuotaExceededError;
    expect(session.kind).toBe("session");

    const context = (await failure(
      client.chat.completions.create(ask("[mock:context]")),
    )) as ContextLengthExceededError;
    expect(context).toBeInstanceOf(ContextLengthExceededError);
    expect(context.contextCap).toBe(65536);
    expect(context.boundBy).toBe("plan");

    const unavailable = (await failure(
      client.chat.completions.create(ask("[mock:unavailable]")),
    )) as ModelUnavailableError;
    expect(unavailable).toBeInstanceOf(ModelUnavailableError);
    expect(unavailable.model).toBe(MODEL);
  });

  it("maps upstream errors (no retries)", async () => {
    const client = mock("mock-key", { maxRetries: 0 });
    expect(await failure(client.chat.completions.create(ask("[mock:busy]")))).toBeInstanceOf(
      ServerBusyError,
    );
    const upstream = (await failure(
      client.chat.completions.create(ask("[mock:upstream-error]")),
    )) as UpstreamError;
    expect(upstream).toBeInstanceOf(UpstreamError);
    expect(upstream.upstreamStatus).toBe(500);
    const edge = (await failure(
      client.chat.completions.create(ask("[mock:cloudflare-524]")),
    )) as UpstreamError;
    expect(edge.status).toBe(524);
    expect(edge.type).toBeNull();
    const timeout = (await failure(
      client.chat.completions.create(ask("[mock:timeout]")),
    )) as UpstreamError;
    expect(timeout.status).toBe(504);
    expect(timeout.type).toBe("upstream_timeout");
  });

  it("retries a flaky upstream until it succeeds", async () => {
    const reply = await mock().chat.completions.create(ask(`[mock:flaky=2] ${nonce()}`));
    expect(reply.choices[0]?.message.content).toMatch(/^Mock reply from/);
  });

  it("surfaces in-stream errors after content as StreamError", async () => {
    for (const [marker, type] of [
      ["[mock:timeout]", "upstream_timeout"],
      ["[mock:preempted]", "preempted"],
    ] as const) {
      const stream = await mock().chat.completions.create({ ...ask(marker), stream: true });
      let text = "";
      const err = await failure(
        (async () => {
          for await (const t of stream.textDeltas()) text += t;
        })(),
      );
      expect(err).toBeInstanceOf(StreamError);
      expect((err as StreamError).type).toBe(type);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("rate limit: Retry-After is read", async () => {
    const err = (await failure(
      mock("mock-key", { maxRetries: 0 }).chat.completions.create(ask("[mock:rate-limit]")),
    )) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfter).toBe(1);
  });

  it("times out a slow response", async () => {
    const err = await failure(
      mock("mock-key", { maxRetries: 0, timeout: 200 }).chat.completions.create(
        ask("[mock:slow=2000]"),
      ),
    );
    expect(err).toBeInstanceOf(APITimeoutError);
  });
});
