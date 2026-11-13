/**
 * Live, authenticated tier: needs MOLOCHAI_LIVE=1 and a real MOLOCHAI_API_KEY
 * whose account has an active plan or credit. Every request is tiny; see
 * CONTRIBUTING.md for how many one run sends.
 *
 * - GET /models and GET /api/auth/me (shape; the email and credit are never
 *   logged or compared).
 * - One non-streamed completion and its rate-limit headers, on the non-reasoning
 *   model when it is available.
 * - One stream on a reasoning model, checked against the raw bytes.
 * - One tool call and its follow-up.
 * - Two errors that cost nothing: an unknown model id (422) and a model that
 *   GET /models lists as unavailable (503 model_unavailable).
 *
 * An account problem (402 no plan or credit, 401, 403, quota) fails the test that
 * meets it with one sentence; the tests after it are skipped, not failed.
 * Assertions check the shape of the responses, never the text.
 */
import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
  type ChatCompletion,
  type ChatMessage,
  type CompletionUsage,
  type Model,
  ModelUnavailableError,
  MolochAI,
  type QueueInfo,
  UnprocessableEntityError,
} from "../../src/index.js";
import {
  API_KEY,
  accountProblem,
  BASE_URL,
  describeError,
  GET_TIME,
  LIVE,
  MODEL_OVERRIDE,
  NON_REASONING,
  PONG,
  REASONING,
  REPLY_REASONS,
  StreamRecorder,
  sseData,
  UNKNOWN_MODEL,
} from "./live.js";

const ACCOUNT_FIELDS = [
  "id",
  "email",
  "plan",
  "plan_expires_at",
  "tier",
  "credit_usd",
  "email_verified",
  "api_base",
  "default_model",
  "context_limit",
  "models",
];
const PONG_MESSAGES: ChatMessage[] = [{ role: "user", content: PONG }];
const TOOL_MESSAGES: ChatMessage[] = [
  { role: "user", content: "What time is it? Use the get_time tool." },
];

function checkUsage(usage: CompletionUsage | null | undefined): void {
  expect(usage, "no usage in the reply").toBeTruthy();
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  expect(prompt).toBeGreaterThan(0);
  expect(completion).toBeGreaterThan(0);
  expect(usage?.total_tokens, "total_tokens is not prompt + completion").toBe(prompt + completion);
}

/** A finished text reply: shape, model echo, finish reason and usage. Not the wording. */
function checkReply(reply: ChatCompletion, model: string): void {
  expect(reply.object).toBe("chat.completion");
  expect(reply.id).toEqual(expect.any(String));
  expect(reply.created).toEqual(expect.any(Number));
  // The API contract: `model` is always the public id that was asked for.
  expect(reply.model).toBe(model);
  expect(reply.choices).toHaveLength(1);
  const choice = reply.choices[0];
  expect(REPLY_REASONS).toContain(choice?.finish_reason);
  expect(choice?.message.role).toBe("assistant");
  expect(choice?.message.tool_calls ?? []).toEqual([]);
  const answered = Boolean(choice?.message.content || choice?.message.reasoning_content);
  expect(answered, "the reply has neither content nor reasoning").toBe(true);
  checkUsage(reply.usage);
}

describe.skipIf(!LIVE || !API_KEY)(`live, authenticated (${BASE_URL})`, () => {
  const recorder = new StreamRecorder();
  let client: MolochAI;
  beforeAll(() => {
    // One retry absorbs a transient server_busy without multiplying the cost.
    client = new MolochAI({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      maxRetries: 1,
      fetch: recorder.fetch,
    });
  });

  let problem: string | null = null;
  const results = new Map<string, { ok: boolean; value?: unknown }>();

  function skipAfterProblem(ctx: TestContext): void {
    if (problem) ctx.skip("not run: an earlier test failed on an account problem");
  }

  /** Run a request; an account problem fails this test with one sentence and skips the rest. */
  async function call<T>(ctx: TestContext, request: () => Promise<T>): Promise<T> {
    skipAfterProblem(ctx);
    try {
      return await request();
    } catch (err) {
      const found = accountProblem(err);
      if (!found) throw err;
      problem = found;
      throw new Error(found);
    }
  }

  /** Like `call`, for a request that should fail: resolves to the error, or `undefined`. */
  async function rejection(ctx: TestContext, request: () => Promise<unknown>): Promise<unknown> {
    skipAfterProblem(ctx);
    try {
      await request();
    } catch (err) {
      const found = accountProblem(err);
      if (!found) return err;
      problem = found;
      throw new Error(found);
    }
    return undefined;
  }

  /** The result of a request shared by several tests, made on first use. */
  async function once<T>(ctx: TestContext, name: string, request: () => Promise<T>): Promise<T> {
    skipAfterProblem(ctx);
    const known = results.get(name);
    if (known && !known.ok) ctx.skip(`not run: ${name} failed earlier in this run`);
    if (known) return known.value as T;
    results.set(name, { ok: false });
    const value = await call(ctx, request);
    results.set(name, { ok: true, value });
    return value;
  }

  const listModels = (ctx: TestContext): Promise<Model[]> =>
    once(ctx, "GET /models", () => client.models.list());

  async function availableModels(ctx: TestContext): Promise<string[]> {
    const available = (await listModels(ctx)).filter((m) => m.available).map((m) => m.id);
    if (available.length === 0) {
      ctx.skip("not run: GET /models lists no available model (see the models test)");
    }
    if (MODEL_OVERRIDE && !available.includes(MODEL_OVERRIDE)) {
      ctx.skip(`not run: MOLOCHAI_LIVE_MODEL=${MODEL_OVERRIDE} is not available`);
    }
    return available;
  }

  /** The non-reasoning model when it is served, else the first available one. */
  async function chatModel(ctx: TestContext): Promise<string> {
    const available = await availableModels(ctx);
    if (MODEL_OVERRIDE) return MODEL_OVERRIDE;
    return available.includes(NON_REASONING) ? NON_REASONING : (available[0] as string);
  }

  async function reasoningModel(ctx: TestContext): Promise<string> {
    const available = await availableModels(ctx);
    if (MODEL_OVERRIDE) return MODEL_OVERRIDE;
    const picks = [
      ...REASONING.filter((m) => available.includes(m)),
      ...available.filter((m) => m !== NON_REASONING),
    ];
    const pick = picks[0];
    if (!pick) {
      ctx.skip(`no reasoning model is available right now (only ${available.join(", ")})`);
    }
    return pick;
  }

  /** The one non-streamed completion, shared by the completion and rate-limit tests. */
  async function pong(ctx: TestContext): Promise<{ model: string; reply: ChatCompletion }> {
    const model = await chatModel(ctx);
    const reply = await once(ctx, "the completion", () =>
      client.chat.completions.create({ model, messages: PONG_MESSAGES }),
    );
    return { model, reply };
  }

  // First: GET /models is behind the quota check, so an account without plan or
  // credit fails here with one message and the tests below are skipped.
  it("models.list(): id, name and available on every entry; at least one model available", async (ctx) => {
    const models = await listModels(ctx);
    expect(models.length, "GET /models returned an empty list").toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id).toEqual(expect.any(String));
      expect(m.object).toBe("model");
      expect(m.owned_by).toEqual(expect.any(String));
      expect(typeof m.name === "string" && m.name !== "", `${m.id} has no display name`).toBe(true);
      expect(typeof m.available, `${m.id}: available`).toBe("boolean");
    }
    console.info(
      `models: ${models.map((m) => `${m.id}${m.available ? "" : " (unavailable)"}`).join(", ")}`,
    );
    const available = models.filter((m) => m.available).map((m) => m.id);
    if (available.length === 0) {
      throw new Error(
        `GET /models lists ${models.length} models and none is available: no server is serving any model right now. That is an outage, not a test problem.`,
      );
    }
    if (MODEL_OVERRIDE && !available.includes(MODEL_OVERRIDE)) {
      const listed = models.some((m) => m.id === MODEL_OVERRIDE);
      throw new Error(
        `MOLOCHAI_LIVE_MODEL=${MODEL_OVERRIDE} ${listed ? "is not available" : "is not listed"} in GET /models.`,
      );
    }
  });

  it("account.retrieve(): tier, plan, credit_usd and per-model context_limit (values not logged)", async (ctx) => {
    const me = await once(ctx, "GET /api/auth/me", () => client.account.retrieve());
    // Only booleans and field names reach expect(): a failing comparison prints the
    // value, and the email and credit must stay out of a public log.
    const missing = ACCOUNT_FIELDS.filter((field) => !(field in me));
    expect(missing, "fields missing from /api/auth/me").toEqual([]);
    const tierOk = typeof me.tier === "string" && me.tier !== "";
    expect(tierOk, "tier is empty, but the account can spend (GET /models passed)").toBe(true);
    const planOk = me.plan === null || (typeof me.plan === "string" && me.plan !== "");
    expect(planOk, "plan is neither a plan name nor null").toBe(true);
    const creditOk = typeof me.credit_usd === "number" && Number.isFinite(me.credit_usd);
    expect(creditOk, "credit_usd is not a number").toBe(true);
    expect(typeof me.email_verified === "boolean", "email_verified is not a boolean").toBe(true);
    const limit = me.context_limit;
    const limitOk = limit === null || (Number.isInteger(limit) && limit > 0);
    expect(limitOk, "context_limit is not a positive number of tokens").toBe(true);
    expect(Array.isArray(me.models) && me.models.length > 0, "no models listed").toBe(true);
    for (const m of me.models) {
      expect(m.id).toEqual(expect.any(String));
      expect(typeof m.available, `${m.id}: available`).toBe("boolean");
      if (m.available) {
        expect(m.context_limit, `${m.id} is available but has no context_limit`).toBeGreaterThan(0);
      } else if (m.context_limit !== null) {
        expect(m.context_limit).toBeGreaterThan(0);
      }
    }
    console.info(`account: tier ${me.tier}, ${me.models.length} models`);
  });

  it("chat.completions.create(): shape, model echo, finish_reason, usage total = prompt + completion", async (ctx) => {
    const { model, reply } = await pong(ctx);
    checkReply(reply, model);
    console.info(
      `completion: ${model}, finish_reason ${reply.choices[0]?.finish_reason}, usage ${JSON.stringify(reply.usage)}`,
    );
  });

  it("rateLimit: X-RateLimit-Limit and X-RateLimit-Remaining on the completion (no extra request)", async (ctx) => {
    const { limit, remaining } = (await pong(ctx)).reply.rateLimit;
    expect(limit, "X-RateLimit-Limit").toEqual(expect.any(Number));
    expect(limit).toBeGreaterThan(0);
    expect(remaining, "X-RateLimit-Remaining").toEqual(expect.any(Number));
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(limit ?? 0);
    console.info(`rate limit: ${remaining} of ${limit} left`);
  });

  // The only request that goes to a reasoning model (unless no other model is served).
  it("stream on a reasoning model: deltas, usage chunk, [DONE]; textDeltas() and finalCompletion() match the raw chunks", async (ctx) => {
    const model = await reasoningModel(ctx);
    const queue: QueueInfo[] = [];
    const stream = await call(ctx, () =>
      client.chat.completions.create({
        model,
        messages: PONG_MESSAGES,
        stream: true,
        onQueue: (q) => queue.push(q),
      }),
    );
    const deltas: string[] = [];
    for await (const text of stream.textDeltas()) deltas.push(text);
    const final = await stream.finalCompletion();

    // The raw chunks, from the bytes on the wire.
    const events = sseData(await recorder.last());
    expect(events.at(-1), "the stream did not end with data: [DONE]").toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e) as Record<string, unknown>);
    expect(chunks.length, "the stream sent no chunks before [DONE]").toBeGreaterThan(0);
    expect(
      chunks.some((c) => "error" in c),
      "the stream sent an error event",
    ).toBe(false);
    for (const c of chunks) expect(c.object).toBe("chat.completion.chunk");
    type WireChoice = {
      index?: number;
      delta?: { content?: unknown; reasoning_content?: unknown };
      finish_reason?: string | null;
    };
    const choices = chunks
      .flatMap((c) => (Array.isArray(c.choices) ? (c.choices as WireChoice[]) : []))
      .filter((c) => (c.index ?? 0) === 0);
    const strings = (key: "content" | "reasoning_content"): string[] =>
      choices.map((c) => c.delta?.[key]).filter((v): v is string => typeof v === "string");
    const content = strings("content");
    const reasoning = strings("reasoning_content");
    const finish = choices.map((c) => c.finish_reason).filter((f): f is string => Boolean(f));
    expect(
      content.some(Boolean) || reasoning.some(Boolean),
      "no content or reasoning deltas arrived",
    ).toBe(true);
    expect(finish.length, "no chunk carried a finish_reason").toBeGreaterThan(0);
    const usageChunk = chunks.at(-1);
    expect(usageChunk?.choices, "the last chunk is not the usage chunk (no choices)").toEqual([]);
    expect(usageChunk?.usage, "the last chunk carries no usage").toEqual(expect.any(Object));

    // The SDK's helpers agree with the raw chunks.
    expect(deltas, "textDeltas() differs from the content deltas on the wire").toEqual(
      content.filter(Boolean),
    );
    expect(final.id).toBe(chunks[0]?.id);
    expect(final.model).toBe(model);
    const choice = final.choices[0];
    expect(choice?.finish_reason).toBe(finish.at(-1));
    expect(REPLY_REASONS).toContain(choice?.finish_reason);
    expect(choice?.message.content).toBe(content.length > 0 ? content.join("") : null);
    expect(choice?.message.reasoning_content).toBe(
      reasoning.length > 0 ? reasoning.join("") : undefined,
    );
    expect(final.usage).toEqual(usageChunk?.usage);
    checkUsage(final.usage);
    console.info(
      `stream: ${model}, ${chunks.length} chunks (${content.length} content, ${reasoning.length} reasoning), ${queue.length} queue notices, finish_reason ${choice?.finish_reason}, usage ${JSON.stringify(final.usage)}`,
    );
  });

  it("tool call: forced get_time ends in finish_reason tool_calls with JSON arguments; the tool result gets a normal reply", async (ctx) => {
    const model = await chatModel(ctx);
    const first = await call(ctx, () =>
      client.chat.completions.create({
        model,
        messages: TOOL_MESSAGES,
        tools: [GET_TIME],
        tool_choice: { type: "function", function: { name: "get_time" } },
      }),
    );
    expect(first.model).toBe(model);
    expect(first.choices).toHaveLength(1);
    const choice = first.choices[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    const toolCall = choice?.message.tool_calls?.[0];
    if (!choice || !toolCall) throw new Error("finish_reason is tool_calls but there is no call");
    expect(toolCall.id).not.toBe("");
    expect(toolCall.type).toBe("function");
    expect(toolCall.function.name).toBe("get_time");
    let args: unknown;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new Error(`the tool call's arguments are not JSON: ${toolCall.function.arguments}`);
    }
    const isObject = typeof args === "object" && args !== null && !Array.isArray(args);
    expect(isObject, "the tool call's arguments are not a JSON object").toBe(true);
    checkUsage(first.usage);

    // Send the tool's result back. tool_choice "none" keeps the model from calling it again.
    const second = await call(ctx, () =>
      client.chat.completions.create({
        model,
        messages: [
          ...TOOL_MESSAGES,
          choice.message,
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ utc: "2026-01-01T12:00:00Z" }),
          },
        ],
        tools: [GET_TIME],
        tool_choice: "none",
      }),
    );
    checkReply(second, model);
    console.info(
      `tool call: ${model}, arguments ${toolCall.function.arguments}, then finish_reason ${second.choices[0]?.finish_reason}`,
    );
  });

  it("unknown model id: UnprocessableEntityError (422) with errors.model", async (ctx) => {
    // Rejected by validation before any model work: costs nothing.
    const err = await rejection(ctx, () =>
      client.chat.completions.create({ model: UNKNOWN_MODEL, messages: PONG_MESSAGES }),
    );
    const seen = describeError(err);
    console.info(`${UNKNOWN_MODEL} -> ${seen}`);
    expect(err, seen).toBeInstanceOf(UnprocessableEntityError);
    const error = err as UnprocessableEntityError;
    expect(error.status).toBe(422);
    expect(Object.keys(error.errors)).toContain("model");
  });

  it("model listed as unavailable: ModelUnavailableError (503 model_unavailable)", async (ctx) => {
    const model = (await listModels(ctx)).find((m) => m.available === false)?.id;
    if (!model) {
      return ctx.skip(
        "GET /models reports every model as available, so model_unavailable cannot be checked without generating",
      );
    }
    const err = await rejection(ctx, () =>
      client.chat.completions.create({ model, messages: PONG_MESSAGES }),
    );
    if (err === undefined) {
      return ctx.skip(`${model} started being served between GET /models and this request`);
    }
    const seen = describeError(err);
    console.info(`${model} -> ${seen}`);
    expect(err, seen).toBeInstanceOf(ModelUnavailableError);
    const error = err as ModelUnavailableError;
    expect(error.status).toBe(503);
    expect(error.type).toBe("model_unavailable");
    expect(error.model).toBe(model);
  });
});
