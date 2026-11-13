/**
 * Live, authenticated tier: needs MOLOCHAI_LIVE=1 and a real MOLOCHAI_API_KEY
 * whose account has an active plan or credit. Makes four requests: one models
 * list, one account read, and one tiny completion and one tiny stream on the
 * first available model (two short replies; a reasoning model also spends some
 * reasoning tokens on them). Asserts the response shape, not the text.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { type ChatCompletionChunk, type Model, MolochAI, type QueueInfo } from "../../src/index.js";
import { API_KEY, BASE_URL, FINISH_REASONS, LIVE, PONG } from "./live.js";

describe.skipIf(!LIVE || !API_KEY)(`live, authenticated (${BASE_URL})`, () => {
  let client: MolochAI;
  beforeAll(() => {
    // One retry absorbs a transient server_busy without multiplying the cost.
    client = new MolochAI({ apiKey: API_KEY, baseURL: BASE_URL, maxRetries: 1 });
  });

  // One GET /models for the whole file, shared by the tests below.
  let catalog: Promise<Model[]> | undefined;
  const listModels = () => {
    catalog ??= client.models.list();
    return catalog;
  };
  const firstAvailableModel = async () => (await listModels()).find((m) => m.available)?.id;

  it("models.list() returns the catalog with name and available", async () => {
    const models = await listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id).toEqual(expect.any(String));
      expect(m.object).toBe("model");
      expect(m.owned_by).toEqual(expect.any(String));
      expect(m.name).toEqual(expect.any(String));
      expect(m.available).toEqual(expect.any(Boolean));
    }
    console.info(
      `models: ${models.map((m) => `${m.id}${m.available ? "" : " (unavailable)"}`).join(", ")}`,
    );
  });

  it("account.retrieve() returns plan, limits and per-model context limits", async () => {
    const me = await client.account.retrieve();
    expect(me.id).toEqual(expect.any(Number));
    expect(me.email).toEqual(expect.any(String));
    expect(me.tier).toEqual(expect.any(String));
    expect(me.credit_usd).toEqual(expect.any(Number));
    expect(me.email_verified).toEqual(expect.any(Boolean));
    expect(me.api_base).toEqual(expect.any(String));
    // The mock sends null when no model is available; accept that here too.
    if (me.default_model !== null) expect(me.default_model).toEqual(expect.any(String));
    expect(me.models.length).toBeGreaterThan(0);
    for (const m of me.models) {
      expect(m.id).toEqual(expect.any(String));
      expect(m.available).toEqual(expect.any(Boolean));
      if (m.context_limit !== null) expect(m.context_limit).toBeGreaterThan(0);
    }
    // No account details in the log: only the shape-level facts.
    console.info(`account: tier ${me.tier}, ${me.models.length} models`);
  });

  it("a tiny non-streamed completion has the documented shape", async (ctx) => {
    const model = await firstAvailableModel();
    if (!model) return ctx.skip("no model has available: true right now");

    const reply = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: PONG }],
    });

    expect(reply.object).toBe("chat.completion");
    expect(reply.id).toEqual(expect.any(String));
    expect(reply.created).toEqual(expect.any(Number));
    expect(reply.model).toBe(model);
    expect(reply.choices.length).toBeGreaterThan(0);
    const choice = reply.choices[0];
    expect(choice?.message.role).toBe("assistant");
    expect(choice?.message.content).toEqual(expect.any(String));
    expect(FINISH_REASONS).toContain(choice?.finish_reason);
    expect(reply.usage.prompt_tokens).toBeGreaterThan(0);
    expect(reply.usage.completion_tokens).toBeGreaterThan(0);
    expect(reply.usage.total_tokens).toBeGreaterThanOrEqual(
      reply.usage.prompt_tokens + reply.usage.completion_tokens,
    );
    expect(reply.rateLimit.limit).toEqual(expect.any(Number));
    expect(reply.rateLimit.remaining).toEqual(expect.any(Number));
    console.info(
      `completion: ${model}, finish_reason ${choice?.finish_reason}, usage ${JSON.stringify(reply.usage)}, rate limit ${JSON.stringify(reply.rateLimit)}`,
    );
  });

  it("a tiny stream yields chunks, a usage chunk and a final completion", async (ctx) => {
    const model = await firstAvailableModel();
    if (!model) return ctx.skip("no model has available: true right now");

    const queue: QueueInfo[] = [];
    const stream = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: PONG }],
      stream: true,
      onQueue: (q) => queue.push(q),
    });

    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.id).toEqual(expect.any(String));
    }
    // The last data event carries usage and no choices.
    const last = chunks[chunks.length - 1];
    expect(last?.choices).toEqual([]);
    expect(last?.usage?.total_tokens).toBeGreaterThan(0);

    const final = await stream.finalCompletion();
    expect(final.object).toBe("chat.completion");
    expect(final.model).toBe(model);
    expect(final.choices[0]?.message.role).toBe("assistant");
    expect(final.choices[0]?.message.content).toEqual(expect.any(String));
    expect(FINISH_REASONS).toContain(final.choices[0]?.finish_reason);
    expect(final.usage.total_tokens).toBe(last?.usage?.total_tokens);
    expect(stream.rateLimit.limit).toEqual(expect.any(Number));
    console.info(
      `stream: ${model}, ${chunks.length} chunks, ${queue.length} queue notices, finish_reason ${final.choices[0]?.finish_reason}, usage ${JSON.stringify(final.usage)}`,
    );
  });
});
