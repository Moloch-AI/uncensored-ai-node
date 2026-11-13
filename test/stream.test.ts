import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APITimeoutError,
  APIUserAbortError,
  CAP_NOTICE,
  ChatCompletionStream,
  MolochAIError,
  type QueueInfo,
  RateLimitError,
  StreamError,
  stripCapNotice,
} from "../src/index.js";
import {
  chunk,
  client,
  data,
  happyStream,
  json,
  MESSAGES,
  mockFetch,
  settle,
  sse,
  stalledSSE,
  USAGE,
  usageChunk,
} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(parts: string[], onQueue?: (q: QueueInfo) => void) {
  const fetch = mockFetch(sse(parts, { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "41" }));
  const stream = await client(fetch).chat.completions.create({
    model: "glm-5.3-flash",
    messages: MESSAGES,
    stream: true,
    onQueue,
  });
  return { stream, fetch };
}

describe("streaming", () => {
  it("yields every chunk including the usage chunk, and skips comments", async () => {
    const { stream, fetch } = await open(happyStream());
    expect(stream).toBeInstanceOf(ChatCompletionStream);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(7);
    expect(chunks.at(-1)).toEqual(usageChunk());
    expect(chunks.at(-1)?.choices).toEqual([]);
    expect(fetch.calls[0]?.headers.get("accept")).toBe("text/event-stream");
    expect(fetch.calls[0]?.body?.stream).toBe(true);
    expect(stream.rateLimit).toEqual({ limit: 60, remaining: 41 });
  });

  it("textDeltas() yields only content", async () => {
    const { stream } = await open(happyStream());
    const parts = [];
    for await (const t of stream.textDeltas()) parts.push(t);
    expect(parts).toEqual(["Hello", " there"]);
  });

  it("finalCompletion() assembles content, reasoning, finish reason and usage", async () => {
    const { stream } = await open(happyStream());
    const final = await stream.finalCompletion();
    expect(final).toEqual({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "glm-5.3-flash",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello there",
            reasoning_content: "Thinking hard.",
          },
          finish_reason: "stop",
        },
      ],
      usage: USAGE,
    });
    expect(final.rateLimit).toEqual({ limit: 60, remaining: 41 });
    expect(Object.keys(final)).not.toContain("rateLimit");
  });

  it("finalCompletion() after iterating returns the same result", async () => {
    const { stream } = await open(happyStream());
    let text = "";
    for await (const t of stream.textDeltas()) text += t;
    const final = await stream.finalCompletion();
    expect(final.choices[0]?.message.content).toBe(text);
  });

  it("finalCompletion() called during iteration waits for it", async () => {
    const { stream } = await open(happyStream());
    const pending = stream.finalCompletion();
    // finalCompletion started draining; a second iteration is refused.
    expect(() => stream[Symbol.asyncIterator]()).toThrow(MolochAIError);
    expect((await pending).usage.total_tokens).toBe(12);
    expect((await stream.finalCompletion()).usage.total_tokens).toBe(12);
  });

  it("merges tool-call fragments by index", async () => {
    const parts = [
      data(chunk({ role: "assistant" })),
      data(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        }),
      ),
      data(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })),
      data(
        chunk({
          tool_calls: [
            {
              index: 1,
              id: "call_b",
              type: "function",
              function: { name: "get_time", arguments: "{}" },
            },
          ],
        }),
      ),
      data(chunk({ tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] })),
      data(chunk({}, { finish_reason: "tool_calls" })),
      data(usageChunk()),
      "data: [DONE]\n\n",
    ];
    const { stream } = await open(parts);
    const final = await stream.finalCompletion();
    const choice = final.choices[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
      },
      { id: "call_b", type: "function", function: { name: "get_time", arguments: "{}" } },
    ]);
    expect(JSON.parse(choice?.message.tool_calls?.[0]?.function.arguments ?? "")).toEqual({
      city: "Oslo",
    });
  });

  it("merges tool-call fragments that have no index (by id, then last)", async () => {
    const parts = [
      data(chunk({ tool_calls: [{ id: "c1", function: { name: "f", arguments: "{" } }] })),
      data(chunk({ tool_calls: [{ function: { arguments: "}" } }] })),
      data(chunk({ tool_calls: [{ id: "c2", function: { name: "g", arguments: "[]" } }] })),
      data(chunk({}, { finish_reason: "tool_calls" })),
      "data: [DONE]\n\n",
    ];
    const { stream } = await open(parts);
    const calls = (await stream.finalCompletion()).choices[0]?.message.tool_calls;
    expect(calls).toEqual([
      { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "g", arguments: "[]" } },
    ]);
  });

  it("a tool call that arrives whole in one chunk (MolochAI)", async () => {
    const call = {
      index: 0,
      id: "call_mock_1",
      type: "function",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    };
    const { stream } = await open([
      data(chunk({ role: "assistant", tool_calls: [call] })),
      data(chunk({}, { finish_reason: "tool_calls" })),
      data(usageChunk()),
      "data: [DONE]\n\n",
    ]);
    const final = await stream.finalCompletion();
    expect(final.choices[0]?.message.tool_calls).toEqual([
      { id: "call_mock_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
    ]);
  });

  it("assembles several choices in index order", async () => {
    const { stream } = await open([
      data(chunk({ content: "B" }, { index: 1 })),
      data(chunk({ content: "A" }, { index: 0 })),
      data(chunk({}, { index: 0, finish_reason: "stop" })),
      "data: [DONE]\n\n",
    ]);
    const final = await stream.finalCompletion();
    expect(final.choices.map((c) => c.message.content)).toEqual(["A", "B"]);
    expect(final.choices[1]?.finish_reason).toBeNull();
  });

  it("keeps the cap notice in the content; stripCapNotice removes it", async () => {
    const { stream } = await open([
      data(chunk({ content: "Long answer" })),
      data(chunk({ content: CAP_NOTICE })),
      data(chunk({}, { finish_reason: "length" })),
      data(usageChunk()),
      "data: [DONE]\n\n",
    ]);
    const final = await stream.finalCompletion();
    expect(final.choices[0]?.finish_reason).toBe("length");
    expect(final.choices[0]?.message.content?.endsWith(CAP_NOTICE)).toBe(true);
    expect(stripCapNotice(final.choices[0]?.message.content)).toBe("Long answer");
  });

  it("reports queue comments to onQueue and ignores keep-alives", async () => {
    const seen: QueueInfo[] = [];
    const { stream } = await open(
      [
        ": queued · position 2 of 3 · waiting 1s\n\n",
        ": hb\n\n",
        ": queued · position 1 of 3 · waiting 2s\n\n",
        ...happyStream(),
      ],
      (q) => seen.push(q),
    );
    await stream.finalCompletion();
    expect(seen).toEqual([
      { position: 2, waiting: 3, waitedSeconds: 1, raw: "queued · position 2 of 3 · waiting 1s" },
      { position: 1, waiting: 3, waitedSeconds: 2, raw: "queued · position 1 of 3 · waiting 2s" },
    ]);
  });

  it("does not send onQueue, signal or other options to the server", async () => {
    const { fetch } = await open(happyStream(), () => {});
    expect(Object.keys(fetch.calls[0]?.body ?? {}).sort()).toEqual(["messages", "model", "stream"]);
  });

  it("throws StreamError for an error event after content (no retry)", async () => {
    const fetch = mockFetch(
      sse([
        data(chunk({ content: "Partial" })),
        data({
          error: {
            type: "upstream_timeout",
            message: "Server busy or request took too long.",
            elapsed_s: 181.2,
          },
        }),
        "data: [DONE]\n\n",
      ]),
    );
    const stream = await client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    const got: string[] = [];
    const err = await (async () => {
      try {
        for await (const t of stream.textDeltas()) got.push(t);
      } catch (e) {
        return e;
      }
    })();
    expect(got).toEqual(["Partial"]);
    expect(err).toBeInstanceOf(StreamError);
    expect((err as StreamError).type).toBe("upstream_timeout");
    expect((err as StreamError).elapsedSeconds).toBe(181.2);
    await expect(stream.finalCompletion()).rejects.toBe(err);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry preempted, even before any chunk", async () => {
    const fetch = mockFetch(
      sse([data({ error: { type: "preempted", message: "Reclaimed." } }), "data: [DONE]\n\n"]),
    );
    const stream = await client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    await expect(stream.finalCompletion()).rejects.toMatchObject({ type: "preempted" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an in-stream upstream_error with a 4xx status", async () => {
    const fetch = mockFetch(
      sse([
        data({ error: { type: "upstream_error", status: 400, message: "bad" } }),
        "data: [DONE]\n\n",
      ]),
    );
    const stream = await client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    await expect(stream.finalCompletion()).rejects.toMatchObject({
      type: "upstream_error",
      status: 400,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries server_busy that arrives before the first chunk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const queue: QueueInfo[] = [];
    const fetch = mockFetch(
      sse([
        ": queued · position 1 of 1 · waiting 30s\n\n",
        data({ error: { type: "server_busy", message: "Busy." } }),
        "data: [DONE]\n\n",
      ]),
      sse(happyStream()),
    );
    const stream = await client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
      onQueue: (q) => queue.push(q),
    });
    const result = await settle(stream.finalCompletion());
    expect(result.status).toBe("fulfilled");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.calls[1]?.at ?? 0) - (fetch.calls[0]?.at ?? 0)).toBe(250);
    expect(queue).toHaveLength(1);
  });

  it("a pre-yield retry shares the request's retry budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const busy = sse([
      data({ error: { type: "server_busy", message: "Busy." } }),
      "data: [DONE]\n\n",
    ]);
    const fetch = mockFetch(json(502, { error: { type: "upstream_unreachable" } }), busy);
    const stream = await settle(
      client(fetch, { maxRetries: 2 }).chat.completions.create({
        model: "m",
        messages: MESSAGES,
        stream: true,
      }),
    );
    if (stream.status !== "fulfilled") throw new Error("expected a stream");
    const result = await settle(stream.value.finalCompletion());
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(StreamError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries a stream that closes before any chunk", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetch = mockFetch(sse([": ka\n\n"]), sse(happyStream()));
    const stream = await client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    const result = await settle(stream.finalCompletion());
    expect(result.status).toBe("fulfilled");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws APIConnectionError when the stream ends early after content", async () => {
    const { stream } = await open([data(chunk({ content: "Hel" }))]);
    await expect(stream.finalCompletion()).rejects.toThrow(APIConnectionError);
  });

  it("accepts a stream that has a finish reason but no [DONE]", async () => {
    const { stream } = await open([
      data(chunk({ content: "Hi" })),
      data(chunk({}, { finish_reason: "stop" })),
    ]);
    expect((await stream.finalCompletion()).choices[0]?.message.content).toBe("Hi");
  });

  it("rejects malformed events", async () => {
    const { stream } = await open(["data: {not json\n\n"]);
    await expect(stream.finalCompletion()).rejects.toThrow(/Could not parse a stream event/);
    const { stream: s2 } = await open(["data: [1,2]\n\n"]);
    await expect(s2.finalCompletion()).rejects.toThrow(/Unexpected stream event/);
  });

  it("can be iterated only once", async () => {
    const { stream } = await open(happyStream());
    for await (const _ of stream) {
      // consume
    }
    expect(() => stream[Symbol.asyncIterator]()).toThrow(/only once/);
  });

  it("finalCompletion() rejects after the caller broke out early", async () => {
    const { stream } = await open(happyStream());
    for await (const _ of stream) break;
    await expect(stream.finalCompletion()).rejects.toThrow(/closed before it finished/);
  });

  it("abort() during iteration throws APIUserAbortError", async () => {
    const fetch = mockFetch(stalledSSE([data(chunk({ content: "Hi" }))]));
    const stream = await client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    const got: string[] = [];
    const run = (async () => {
      for await (const t of stream.textDeltas()) {
        got.push(t);
        setTimeout(() => stream.abort(), 5);
      }
    })();
    await expect(run).rejects.toThrow(APIUserAbortError);
    expect(got).toEqual(["Hi"]);
    expect(stream.controller.signal.aborted).toBe(true);
  });

  it("abort() before iterating closes the stream", async () => {
    const { stream } = await open(happyStream());
    stream.abort();
    await expect(stream.finalCompletion()).rejects.toThrow(APIUserAbortError);
    stream.abort(); // idempotent
  });

  it("the caller's signal aborts the stream", async () => {
    const ac = new AbortController();
    const fetch = mockFetch(stalledSSE([data(chunk({ content: "Hi" }))]));
    const stream = await client(fetch).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
      signal: ac.signal,
    });
    const run = (async () => {
      for await (const _ of stream) setTimeout(() => ac.abort(), 5);
    })();
    await expect(run).rejects.toThrow(APIUserAbortError);
  });

  it("an already-aborted signal fails before any request", async () => {
    const fetch = mockFetch(sse(happyStream()));
    const ac = new AbortController();
    ac.abort();
    await expect(
      client(fetch).chat.completions.create({
        model: "m",
        messages: MESSAGES,
        stream: true,
        signal: ac.signal,
      }),
    ).rejects.toThrow(APIUserAbortError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out when no data arrives between chunks for `timeout` ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetch = mockFetch(stalledSSE([data(chunk({ content: "Hi" }))]));
    const stream = await client(fetch, { timeout: 5_000 }).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    const start = Date.now();
    const result = await settle(stream.finalCompletion());
    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(APITimeoutError);
    expect(Date.now() - start).toBe(5_000);
    expect(fetch).toHaveBeenCalledTimes(1); // content was already yielded: no retry
  });

  it("keep-alive comments reset the idle timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 900));
          controller.enqueue(encoder.encode(": ka\n\n"));
        }
        for (const part of happyStream()) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
    const fetch = mockFetch(() => new Response(body, { status: 200 }));
    const stream = await client(fetch, { timeout: 1_000 }).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    const result = await settle(stream.finalCompletion());
    expect(result.status).toBe("fulfilled");
  });

  it("an HTTP error before the stream opens is thrown from create()", async () => {
    const fetch = mockFetch(json(429, { message: "Too Many Attempts." }, { "retry-after": "120" }));
    await expect(
      client(fetch).chat.completions.create({ model: "m", messages: MESSAGES, stream: true }),
    ).rejects.toThrow(RateLimitError);
  });

  it("a response without a body is a connection error", async () => {
    const fetch = mockFetch(() => new Response(null, { status: 200 }));
    const stream = await client(fetch, { maxRetries: 0 }).chat.completions.create({
      model: "m",
      messages: MESSAGES,
      stream: true,
    });
    await expect(stream.finalCompletion()).rejects.toThrow(/no body/);
  });
});
