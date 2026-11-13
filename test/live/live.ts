/**
 * Shared settings for the live suite (test/live). These tests call the real API,
 * so they are excluded from `npm test` and skip unless MOLOCHAI_LIVE=1:
 *
 *   MOLOCHAI_LIVE=1 npm run test:live                          # unauthenticated tier only
 *   MOLOCHAI_LIVE=1 MOLOCHAI_API_KEY=... npm run test:live     # both tiers
 *
 * Optional:
 * - MOLOCHAI_LIVE_MODEL sends every generation request to this model id instead
 *   of the automatic pick.
 * - MOLOCHAI_LIVE_BASE_URL points the suite at another deployment, such as the
 *   mock server while working on these tests. MOLOCHAI_BASE_URL is ignored on
 *   purpose, so a shell that points at the mock cannot turn these into mock tests.
 */
import {
  APIStatusError,
  AuthenticationError,
  DEFAULT_BASE_URL,
  type Fetch,
  type FunctionTool,
  PaymentRequiredError,
  PermissionDeniedError,
  QuotaExceededError,
} from "../../src/index.js";

export const LIVE = process.env.MOLOCHAI_LIVE === "1";
export const BASE_URL = process.env.MOLOCHAI_LIVE_BASE_URL?.trim() || DEFAULT_BASE_URL;
export const API_KEY = process.env.MOLOCHAI_API_KEY?.trim() ?? "";
export const MODEL_OVERRIDE = process.env.MOLOCHAI_LIVE_MODEL?.trim() ?? "";

/** The prompt for the tiny completions. Tests assert the response shape, never the text. */
export const PONG = "Reply with the single word: pong";

/**
 * Preferences only: which models exist and are served comes from GET /models.
 * In the public catalog every model reasons except NON_REASONING, which keeps
 * the replies short.
 */
export const NON_REASONING = "llama-3.3-70b-instruct-abliterated";
export const REASONING = ["glm-4.7-flash-uncensored", "gemma4-26b-a4b-qat"];
export const UNKNOWN_MODEL = "molochai-live-test-no-such-model";

/** A tool with no required arguments, for the tool-call round trip. */
export const GET_TIME: FunctionTool = {
  type: "function",
  function: {
    name: "get_time",
    description: "Returns the current UTC time.",
    parameters: { type: "object", properties: {} },
  },
};

/** Finish reasons of a text reply (no tools involved). */
export const REPLY_REASONS = ["stop", "length"];

const BILLING_URL =
  "https://dash.molochai.dev/billing?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node";

export async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the request to fail, but it succeeded");
}

/**
 * One sentence when the account, not the SDK, is the problem: no plan or credit,
 * a refused key, an unverified email, a used-up quota. `null` otherwise.
 */
export function accountProblem(err: unknown): string | null {
  if (err instanceof PaymentRequiredError) {
    return `Top up the test account: the account behind MOLOCHAI_API_KEY has no plan and no credit (HTTP 402 no_active_plan). Add credit at ${BILLING_URL} and run again.`;
  }
  if (err instanceof AuthenticationError) {
    return "MOLOCHAI_API_KEY was not accepted (HTTP 401): it is mistyped or revoked.";
  }
  if (err instanceof PermissionDeniedError) {
    return `The account behind MOLOCHAI_API_KEY was refused (HTTP 403 ${err.type ?? ""}). Verify its email address and run again.`;
  }
  if (err instanceof QuotaExceededError) {
    const resets = err.resetsAt ? err.resetsAt.toISOString() : "an unknown time";
    return `The test account's ${err.kind ?? ""} quota is used up (HTTP 429 ${err.type ?? ""}); it resets at ${resets}.`;
  }
  return null;
}

/**
 * What the server sent, for the test log: status, type, body, the values of the
 * rate-limit headers and the names of all other headers.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof APIStatusError)) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  const headers: Record<string, string> = {};
  const otherHeaders: string[] = [];
  err.headers.forEach((value, name) => {
    if (/ratelimit|^retry-after$|^content-type$/.test(name)) headers[name] = value;
    else otherHeaders.push(name);
  });
  return JSON.stringify({
    error: err.name,
    status: err.status,
    type: err.type,
    body: err.body,
    headers,
    otherHeaders: otherHeaders.sort(),
  });
}

/**
 * A `fetch` that keeps a copy of every event-stream body as the SDK reads it.
 * The stream test parses those bytes itself and compares the result with what
 * the SDK's helpers return, so one streamed request checks both.
 */
export class StreamRecorder {
  readonly #bodies: Promise<string>[] = [];

  readonly fetch: Fetch = async (url, init) => {
    const response = await globalThis.fetch(url, init);
    const type = response.headers.get("content-type") ?? "";
    if (!response.body || !type.startsWith("text/event-stream")) return response;
    const [forSdk, forTest] = response.body.tee();
    const text = new Response(forTest).text();
    text.catch(() => {});
    this.#bodies.push(text);
    return new Response(forSdk, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  /** The last event-stream body, once it has been read to the end. */
  async last(): Promise<string> {
    const body = this.#bodies.at(-1);
    if (!body) throw new Error("no event-stream response was recorded");
    return body;
  }
}

/** The `data` of each server-sent event, parsed without the SDK. Comments are dropped. */
export function sseData(text: string): string[] {
  const events: string[] = [];
  let data: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      if (data.length > 0) events.push(data.join("\n"));
      data = [];
    } else if (line.startsWith("data:")) {
      const value = line.slice("data:".length);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (data.length > 0) events.push(data.join("\n"));
  return events;
}
