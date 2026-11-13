/**
 * Shared settings for the live suite (test/live). These tests call the real API,
 * so they are excluded from `npm test` and skip unless MOLOCHAI_LIVE=1:
 *
 *   MOLOCHAI_LIVE=1 npm run test:live                          # unauthenticated tier only
 *   MOLOCHAI_LIVE=1 MOLOCHAI_API_KEY=... npm run test:live     # both tiers
 *
 * MOLOCHAI_BASE_URL points the suite at another deployment (default: the public API).
 */
import { APIStatusError, DEFAULT_BASE_URL } from "../../src/index.js";

export const LIVE = process.env.MOLOCHAI_LIVE === "1";
export const BASE_URL = process.env.MOLOCHAI_BASE_URL?.trim() || DEFAULT_BASE_URL;
export const API_KEY = process.env.MOLOCHAI_API_KEY?.trim() ?? "";

/** The prompt for the tiny completions. Tests assert the response shape, never the text. */
export const PONG = "Reply with the single word: pong";

export const FINISH_REASONS = ["stop", "length", "tool_calls"];

export async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the request to fail, but it succeeded");
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
