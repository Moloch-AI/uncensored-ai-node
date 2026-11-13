/**
 * Live, unauthenticated tier: an obviously invalid key against the real API.
 * Costs nothing (the gateway rejects the key before any model work) and needs
 * no secret. Runs only with MOLOCHAI_LIVE=1; see test/live/live.ts.
 */
import { describe, expect, it } from "vitest";
import { AuthenticationError, MolochAI } from "../../src/index.js";
import { BASE_URL, describeError, failure, LIVE, PONG } from "./live.js";

const INVALID_KEY = "invalid-key-for-testing";

describe.skipIf(!LIVE)(`live, unauthenticated (${BASE_URL})`, () => {
  // No retries: one request per endpoint.
  const client = new MolochAI({
    apiKey: INVALID_KEY,
    baseURL: BASE_URL,
    maxRetries: 0,
    timeout: 30_000,
  });

  const calls: [string, () => Promise<unknown>][] = [
    [
      "POST /chat/completions",
      // The key is checked before the body, so the model id does not matter here.
      () =>
        client.chat.completions.create({
          model: "glm-5.3-flash",
          messages: [{ role: "user", content: PONG }],
        }),
    ],
    ["GET /models", () => client.models.list()],
    ["GET /api/auth/me", () => client.account.retrieve()],
  ];

  it.each(calls)("%s with an invalid key throws AuthenticationError (401)", async (label, call) => {
    const err = await failure(call());
    const seen = describeError(err);
    console.info(`${label} -> ${seen}`);
    expect(err, seen).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).status).toBe(401);
    // The SDK never echoes the key back, even if a server does.
    expect(String((err as Error).message)).not.toContain(INVALID_KEY);
  });
});
