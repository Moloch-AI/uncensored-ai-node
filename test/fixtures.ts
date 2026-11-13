import { vi } from "vitest";
import type { ClientOptions } from "../src/index.js";
import { MolochAI } from "../src/index.js";

export const API_KEY = "sk-test-0123456789abcdefghijklmnop";
export const BASE_URL = "https://api.molochai.dev/api/v1";

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
  /** `Date.now()` when the call was made (fake clock in retry tests). */
  at: number;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/**
 * A fetch double. Each call uses the next handler; the last handler repeats.
 * A handler can be a Response factory or an Error to throw.
 */
export function mockFetch(...handlers: (Handler | Error)[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
      at: Date.now(),
    };
    calls.push(call);
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    if (handler === undefined) throw new Error("mockFetch: no handler");
    if (handler instanceof Error) throw handler;
    return handler(call);
  });
  return Object.assign(fn, { calls });
}

export function client(fetch: ClientOptions["fetch"], options: ClientOptions = {}): MolochAI {
  return new MolochAI({ apiKey: API_KEY, baseURL: BASE_URL, fetch, ...options });
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (): Response =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
}

export function text(status: number, body: string, headers: Record<string, string> = {}) {
  return (): Response => new Response(body, { status, headers });
}

const encoder = new TextEncoder();

/** A streaming response that emits each part as its own chunk. */
export function sse(parts: (string | Uint8Array)[], headers: Record<string, string> = {}) {
  return (): Response => {
    const queue = parts.map((p) => (typeof p === "string" ? encoder.encode(p) : p));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers },
    });
  };
}

/** A streaming response that emits `parts` and then never sends anything again. */
export function stalledSSE(parts: string[]) {
  return (): Response => {
    const queue = parts.map((p) => encoder.encode(p));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();
        if (next !== undefined) controller.enqueue(next);
        return next === undefined ? new Promise<void>(() => {}) : undefined;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

export function data(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function chunk(
  delta: Record<string, unknown>,
  extra: { finish_reason?: string | null; index?: number } = {},
) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "glm-5.3-flash",
    choices: [{ index: extra.index ?? 0, delta, finish_reason: extra.finish_reason ?? null }],
  };
}

export const USAGE = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };

export function usageChunk() {
  return {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "glm-5.3-flash",
    choices: [],
    usage: USAGE,
  };
}

/** A typical successful stream: role, reasoning, a keep-alive, content, finish, usage, [DONE]. */
export function happyStream(): string[] {
  return [
    data(chunk({ role: "assistant" })),
    data(chunk({ reasoning_content: "Thinking " })),
    data(chunk({ reasoning_content: "hard." })),
    ": ka\n\n",
    data(chunk({ content: "Hello" })),
    data(chunk({ content: " there" })),
    data(chunk({}, { finish_reason: "stop" })),
    data(usageChunk()),
    "data: [DONE]\n\n",
  ];
}

export function completion(content: string | null = "Hello there", extra: object = {}) {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "glm-5.3-flash",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, reasoning_content: "Thinking hard." },
        finish_reason: "stop",
      },
    ],
    usage: USAGE,
    ...extra,
  };
}

export const MESSAGES = [{ role: "user" as const, content: "Hi" }];

/** Drive fake timers until `promise` settles. */
export async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const result = Promise.allSettled([promise]);
  await vi.runAllTimersAsync();
  const [settled] = await result;
  return settled as PromiseSettledResult<T>;
}
