/**
 * Streaming chat completions.
 *
 * @module
 */

import {
  type Attempt,
  type RequestSpec,
  type RetryBudget,
  readRateLimit,
  type Transport,
  toConnectionError,
  withRateLimit,
} from "./core.js";
import {
  APIConnectionError,
  APIUserAbortError,
  asRecord,
  MolochAIError,
  StreamError,
} from "./errors.js";
import { SSEDecoder, type SSEItem } from "./sse.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  CompletionUsage,
  FinishReason,
  QueueInfo,
  RateLimit,
  ToolCall,
  ToolCallDelta,
} from "./types.js";

/**
 * Parse a queue comment such as `queued · position 2 of 3 · waiting 4s`.
 * Returns `null` for any other comment (keep-alives like `ka` and `hb`).
 */
export function parseQueueComment(text: string): QueueInfo | null {
  const raw = text.trim();
  if (!/^queued\b/i.test(raw)) return null;
  const pos = /position\s+(\d+)(?:\s+of\s+(\d+))?/i.exec(raw);
  const waited = /waiting\s+(\d+(?:\.\d+)?)\s*s\b/i.exec(raw);
  return {
    position: pos?.[1] !== undefined ? Number(pos[1]) : null,
    waiting: pos?.[2] !== undefined ? Number(pos[2]) : null,
    waitedSeconds: waited?.[1] !== undefined ? Number(waited[1]) : null,
    raw,
  };
}

/** @internal */
export interface StreamInit {
  transport: Transport;
  spec: RequestSpec;
  budget: RetryBudget;
  attempt: Attempt;
  controller: AbortController;
  onQueue: ((info: QueueInfo) => void) | undefined;
  cleanup: () => void;
}

/**
 * A streamed chat completion. Iterate it once with `for await`, or use
 * `textDeltas()` or `finalCompletion()`.
 *
 * - Comment lines are handled for you (`: queued ...` goes to `onQueue`).
 * - The final usage chunk (with `choices: []`) is yielded like any other chunk.
 * - An error event inside the stream throws {@link StreamError}.
 * - Before the first chunk is yielded, retryable failures are retried with the
 *   client's policy. After that, nothing is retried.
 */
export class ChatCompletionStream implements AsyncIterable<ChatCompletionChunk> {
  /** Aborts the HTTP request. `abort()` calls it. */
  readonly controller: AbortController;
  #transport: Transport;
  #spec: RequestSpec;
  #budget: RetryBudget;
  #attempt: Attempt;
  #onQueue: ((info: QueueInfo) => void) | undefined;
  #cleanup: () => void;
  #state: "new" | "reading" | "closed" = "new";
  #acc = new Accumulator();
  #final: Promise<ChatCompletion>;
  #resolveFinal!: (value: ChatCompletion) => void;
  #rejectFinal!: (err: unknown) => void;

  /** @internal */
  constructor(init: StreamInit) {
    this.controller = init.controller;
    this.#transport = init.transport;
    this.#spec = init.spec;
    this.#budget = init.budget;
    this.#attempt = init.attempt;
    this.#onQueue = init.onQueue;
    this.#cleanup = init.cleanup;
    this.#final = new Promise<ChatCompletion>((resolve, reject) => {
      this.#resolveFinal = resolve;
      this.#rejectFinal = reject;
    });
    this.#final.catch(() => {});
  }

  /** The HTTP response currently being read (changes if a pre-yield retry happened). */
  get response(): Response {
    return this.#attempt.response;
  }

  /** `X-RateLimit-Limit` / `X-RateLimit-Remaining` from the response headers. */
  get rateLimit(): RateLimit {
    return readRateLimit(this.response.headers);
  }

  [Symbol.asyncIterator](): AsyncIterator<ChatCompletionChunk> {
    if (this.#state !== "new") {
      throw new MolochAIError("This stream was already read. A stream can be iterated only once.");
    }
    this.#state = "reading";
    return this.#iterate();
  }

  /** Iterate only the answer text (`delta.content` of the first choice), skipping empty pieces. */
  async *textDeltas(): AsyncGenerator<string, void, undefined> {
    for await (const chunk of this) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }

  /**
   * The whole reply assembled from the chunks: content, reasoning, tool calls
   * (fragments merged), finish reason and usage. Reads the rest of the stream if
   * nobody is iterating it; otherwise waits for that iteration to finish.
   * Rejects with the same error the iteration threw.
   */
  async finalCompletion(): Promise<ChatCompletion> {
    if (this.#state === "new") {
      for await (const _ of this) {
        // drain
      }
    }
    return this.#final;
  }

  /** Close the connection. A pending or later read throws {@link APIUserAbortError}. */
  abort(): void {
    this.controller.abort(new APIUserAbortError());
    if (this.#state === "new") {
      this.#state = "closed";
      this.#rejectFinal(new APIUserAbortError());
      this.#attempt.response.body?.cancel().catch(() => {});
      this.#attempt.close();
      this.#cleanup();
    }
  }

  async *#iterate(): AsyncGenerator<ChatCompletionChunk, void, undefined> {
    let yielded = false;
    let settled = false;
    try {
      for (;;) {
        let retryable: MolochAIError | null = null;
        let done = false;
        try {
          for await (const item of this.#events(this.#attempt)) {
            if (item.kind === "comment") {
              this.#comment(item.text);
              continue;
            }
            if (item.data === "[DONE]") {
              done = true;
              break;
            }
            const payload = parseEvent(item.data);
            const error = asRecord(payload.error);
            if (error) {
              const err = new StreamError(error);
              if (yielded) throw err;
              retryable = err;
              break;
            }
            const chunk = payload as unknown as ChatCompletionChunk;
            this.#acc.add(chunk);
            yielded = true;
            yield chunk;
          }
          if (!done && !retryable) {
            if (this.#acc.finished) {
              done = true; // lenient: some servers close without [DONE]
            } else {
              const err = new APIConnectionError("The stream ended before [DONE].");
              if (yielded) throw err;
              retryable = err;
            }
          }
        } catch (err) {
          const mapped = toConnectionError(err, "The connection closed while streaming.");
          if (yielded || !(mapped instanceof APIConnectionError)) throw mapped;
          retryable = mapped;
        }
        if (done) break;
        const failure = retryable as MolochAIError;
        const next = await this.#transport.retryStream(this.#spec, this.#budget, failure);
        if (!next) throw failure;
        this.#attempt.close();
        this.#attempt = next;
      }
      settled = true;
      this.#resolveFinal(withRateLimit(this.#acc.build(), this.response.headers));
    } catch (err) {
      settled = true;
      const mapped =
        this.controller.signal.aborted && !(err instanceof MolochAIError)
          ? new APIUserAbortError()
          : err;
      this.#rejectFinal(mapped);
      throw mapped;
    } finally {
      this.#state = "closed";
      if (!settled) {
        this.#rejectFinal(new MolochAIError("The stream was closed before it finished."));
      }
      this.#attempt.close();
      this.#cleanup();
    }
  }

  async *#events(attempt: Attempt): AsyncGenerator<SSEItem, void, undefined> {
    const body = attempt.response.body;
    if (!body) throw new APIConnectionError("The response has no body to stream.");
    const reader = body.getReader();
    const decoder = new SSEDecoder();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await attempt.wait(reader.read());
        if (done) {
          finished = true;
          yield* decoder.end();
          return;
        }
        yield* decoder.push(value);
      }
    } finally {
      if (!finished) reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // a read may still be pending after an abort
      }
    }
  }

  #comment(text: string): void {
    if (!this.#onQueue) return;
    const info = parseQueueComment(text);
    if (info) this.#onQueue(info);
  }
}

function parseEvent(data: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new MolochAIError(`Could not parse a stream event as JSON: ${data.slice(0, 200)}`);
  }
  const record = asRecord(parsed);
  if (!record) throw new MolochAIError(`Unexpected stream event: ${data.slice(0, 200)}`);
  return record;
}

interface ChoiceState {
  index: number;
  content: string | null;
  reasoning: string | null;
  tools: (ToolCall & { index: number })[];
  finishReason: FinishReason | null;
}

/** Assembles chunks into a ChatCompletion. @internal */
export class Accumulator {
  id = "";
  created = 0;
  model = "";
  usage: CompletionUsage | null = null;
  #choices = new Map<number, ChoiceState>();

  get finished(): boolean {
    for (const c of this.#choices.values()) if (c.finishReason !== null) return true;
    return false;
  }

  add(chunk: ChatCompletionChunk): void {
    if (!this.id && typeof chunk.id === "string") this.id = chunk.id;
    if (!this.created && typeof chunk.created === "number") this.created = chunk.created;
    if (!this.model && typeof chunk.model === "string") this.model = chunk.model;
    if (chunk.usage) this.usage = chunk.usage;
    if (!Array.isArray(chunk.choices)) return;
    for (const choice of chunk.choices) {
      const index = typeof choice.index === "number" ? choice.index : 0;
      let state = this.#choices.get(index);
      if (!state) {
        state = { index, content: null, reasoning: null, tools: [], finishReason: null };
        this.#choices.set(index, state);
      }
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") state.content = (state.content ?? "") + delta.content;
      if (typeof delta.reasoning_content === "string") {
        state.reasoning = (state.reasoning ?? "") + delta.reasoning_content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const fragment of delta.tool_calls) mergeToolCall(state.tools, fragment);
      }
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
    }
  }

  build(): ChatCompletion {
    const choices = [...this.#choices.values()]
      .sort((a, b) => a.index - b.index)
      .map((s) => {
        const message: ChatCompletion["choices"][number]["message"] = {
          role: "assistant",
          content: s.content,
        };
        if (s.reasoning !== null) message.reasoning_content = s.reasoning;
        if (s.tools.length > 0) {
          message.tool_calls = [...s.tools]
            .sort((a, b) => a.index - b.index)
            .map(({ id, type, function: fn }) => ({
              id,
              type,
              function: { name: fn.name, arguments: fn.arguments },
            }));
        }
        return { index: s.index, message, finish_reason: s.finishReason };
      });
    const completion = {
      id: this.id,
      object: "chat.completion" as const,
      created: this.created,
      model: this.model,
      choices,
    } as Omit<ChatCompletion, "usage" | "rateLimit"> & { usage?: CompletionUsage };
    if (this.usage) completion.usage = this.usage;
    return completion as ChatCompletion;
  }
}

/**
 * Merge one tool-call fragment. MolochAI sends each call whole in one chunk;
 * other providers split `arguments` across chunks, keyed by `index`.
 */
function mergeToolCall(list: (ToolCall & { index: number })[], fragment: ToolCallDelta): void {
  let target: (ToolCall & { index: number }) | undefined;
  if (typeof fragment.index === "number") {
    target = list.find((t) => t.index === fragment.index);
  } else if (fragment.id) {
    target = list.find((t) => t.id === fragment.id);
  } else {
    target = list[list.length - 1];
  }
  if (!target) {
    target = {
      index: typeof fragment.index === "number" ? fragment.index : list.length,
      id: "",
      type: "function",
      function: { name: "", arguments: "" },
    };
    list.push(target);
  }
  if (fragment.id) target.id = fragment.id;
  if (fragment.type) target.type = fragment.type;
  if (fragment.function?.name) target.function.name = fragment.function.name;
  if (typeof fragment.function?.arguments === "string") {
    target.function.arguments += fragment.function.arguments;
  }
}
