import { describe, expect, it } from "vitest";
import { makeStatusError, parseRetryAfter, redact } from "../src/errors.js";
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  ContextLengthExceededError,
  ModelUnavailableError,
  MolochAIError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  ServerBusyError,
  StreamError,
  UnprocessableEntityError,
  UpstreamError,
} from "../src/index.js";

function make(status: number, body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return makeStatusError(status, new Headers(headers), raw, "sk-secret-key-123456");
}

describe("makeStatusError: shape C (bare message)", () => {
  it("401 Unauthenticated", () => {
    const err = make(401, { message: "Unauthenticated." });
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(MolochAIError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.type).toBeNull();
    expect(err.message).toBe("401 Unauthenticated.");
    expect(err.name).toBe("AuthenticationError");
    expect(err.body).toEqual({ message: "Unauthenticated." });
  });

  it("403 email_unverified", () => {
    const err = make(403, {
      message: "Verify your email to continue. Check your inbox.",
      code: "email_unverified",
    });
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err.type).toBe("email_unverified");
    expect((err as PermissionDeniedError).code).toBe("email_unverified");
    expect(err.message).toBe("403 Verify your email to continue. Check your inbox.");
  });

  it("429 Too Many Attempts with Retry-After seconds", () => {
    const err = make(429, { message: "Too Many Attempts." }, { "Retry-After": "17" });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).not.toBeInstanceOf(QuotaExceededError);
    expect((err as RateLimitError).retryAfter).toBe(17);
  });

  it("429 without Retry-After", () => {
    const err = make(429, { message: "Too Many Attempts." });
    expect((err as RateLimitError).retryAfter).toBeNull();
  });
});

describe("makeStatusError: shape A (gateway error object)", () => {
  it("402 no_active_plan", () => {
    const err = make(402, {
      error: { type: "no_active_plan", message: "No active plan.", plan: null },
    });
    expect(err).toBeInstanceOf(PaymentRequiredError);
    expect(err.type).toBe("no_active_plan");
    expect(err.message).toBe("402 no_active_plan: No active plan.");
    expect((err as PaymentRequiredError).plan).toBeNull();
    expect(
      (make(402, { error: { type: "no_active_plan", plan: "lite" } }) as PaymentRequiredError).plan,
    ).toBe("lite");
  });

  it("413 context_length_exceeded", () => {
    const err = make(413, {
      error: {
        type: "context_length_exceeded",
        message: "Prompt too large.",
        estimated_tokens: 70123,
        context_cap: 65536,
        bound_by: "plan",
        plan: "pro",
      },
    }) as ContextLengthExceededError;
    expect(err).toBeInstanceOf(ContextLengthExceededError);
    expect(err.estimatedTokens).toBe(70123);
    expect(err.contextCap).toBe(65536);
    expect(err.boundBy).toBe("plan");
    expect(err.plan).toBe("pro");
  });

  it("413 with missing fields gives nulls", () => {
    const err = make(413, {
      error: { type: "context_length_exceeded" },
    }) as ContextLengthExceededError;
    expect(err.estimatedTokens).toBeNull();
    expect(err.contextCap).toBeNull();
    expect(err.boundBy).toBeNull();
    expect(err.message).toBe("413 context_length_exceeded");
  });

  it("429 quota_exceeded (monthly)", () => {
    const err = make(429, {
      error: {
        type: "quota_exceeded",
        message: "Monthly quota used.",
        resets_at: "2026-12-01T00:00:00Z",
        plan: "pro",
        monthly_used: 1000,
        monthly_cap: 1000,
      },
    }) as QuotaExceededError;
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.kind).toBe("monthly");
    expect(err.resetsAt).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(err.plan).toBe("pro");
    expect(err.used).toBe(1000);
    expect(err.cap).toBe(1000);
  });

  it("429 quota_exceeded (weekly)", () => {
    const err = make(429, {
      error: {
        type: "quota_exceeded",
        resets_at: "2026-11-20T00:00:00Z",
        weekly_used: "5",
        weekly_cap: "5",
      },
    }) as QuotaExceededError;
    expect(err.kind).toBe("weekly");
    expect(err.used).toBe(5);
    expect(err.cap).toBe(5);
  });

  it("429 session_quota_exceeded", () => {
    const err = make(429, {
      error: {
        type: "session_quota_exceeded",
        message: "Session cap.",
        resets_at: "2026-11-13T05:00:00Z",
      },
    }) as QuotaExceededError;
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.kind).toBe("session");
    expect(err.resetsAt?.toISOString()).toBe("2026-11-13T05:00:00.000Z");
  });

  it("429 quota with an unknown kind and a bad date", () => {
    const err = make(429, {
      error: { type: "quota_exceeded", resets_at: "soon" },
    }) as QuotaExceededError;
    expect(err.kind).toBeNull();
    expect(err.resetsAt).toBeNull();
  });

  it("503 model_unavailable", () => {
    const err = make(503, {
      error: { type: "model_unavailable", message: "Not served.", model: "glm-5.3-flash" },
    }) as ModelUnavailableError;
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err.model).toBe("glm-5.3-flash");
  });

  it("503 server_busy", () => {
    expect(make(503, { error: { type: "server_busy", message: "Busy." } })).toBeInstanceOf(
      ServerBusyError,
    );
  });

  it("503 with an HTML body is ServerBusyError", () => {
    expect(make(503, "<html>Service Unavailable</html>")).toBeInstanceOf(ServerBusyError);
  });

  it.each([
    [502, "upstream_unreachable"],
    [502, "upstream_timeout"],
    [502, "no_usage_accounting"],
    [504, "upstream_timeout"],
  ])("%i %s is UpstreamError", (status, type) => {
    const err = make(status, { error: { type, message: "x", request_id: "req_1" } });
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.type).toBe(type);
    expect(err.requestId).toBe("req_1");
  });

  it("upstream_error keeps the upstream status", () => {
    const err = make(502, {
      error: { type: "upstream_error", message: "x", status: 500, body: "boom", request_id: "r" },
    }) as UpstreamError;
    expect(err.upstreamStatus).toBe(500);
  });

  it("4xx upstream_error is UpstreamError too", () => {
    const err = make(400, { error: { type: "upstream_error", status: 400 } });
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(400);
  });
});

describe("makeStatusError: shape B (validation)", () => {
  it("422 with errors", () => {
    const err = make(422, {
      message: "The selected model is invalid.",
      errors: { model: ["The selected model is invalid."], temperature: "too high" },
    }) as UnprocessableEntityError;
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect(err.errors).toEqual({
      model: ["The selected model is invalid."],
      temperature: ["too high"],
    });
    expect(err.message).toBe("422 The selected model is invalid.");
  });

  it("422 without errors", () => {
    expect((make(422, { message: "Bad." }) as UnprocessableEntityError).errors).toEqual({});
  });
});

describe("makeStatusError: non-JSON and odd bodies", () => {
  it("524 Cloudflare HTML", () => {
    const err = make(524, "<!DOCTYPE html><html><title>A timeout occurred</title></html>");
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.type).toBeNull();
    expect(err.message).toMatch(/^524 .*stream: true/);
    expect(err.body).toContain("A timeout occurred");
  });

  it("500 with an empty body", () => {
    const err = make(500, "");
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.body).toBeNull();
    expect(err.message).toBe("500 (empty response body)");
  });

  it("502 plain text", () => {
    const err = make(502, "Bad gateway");
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toBe("502 (non-JSON response body)");
    expect(err.body).toBe("Bad gateway");
  });

  it("JSON without a known shape", () => {
    const err = make(400, [1, 2]);
    expect(err.constructor).toBe(APIStatusError);
    expect(err.message).toBe("400 (unrecognized error body)");
  });

  it("404 Not found.", () => {
    const err = make(404, { message: "Not found." });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.message).toBe("404 Not found.");
  });

  it("other 4xx falls back to APIStatusError", () => {
    const err = make(409, { message: "Conflict." });
    expect(err.constructor).toBe(APIStatusError);
    expect(err.name).toBe("APIStatusError");
  });

  it("reads x-request-id when the body has none", () => {
    expect(make(500, "", { "x-request-id": "hdr-1" }).requestId).toBe("hdr-1");
    expect(make(500, "").requestId).toBeNull();
  });

  it("redacts the API key if a server echoes it", () => {
    const err = make(400, {
      message: "Bad header: Bearer sk-secret-key-123456",
    });
    expect(err.message).not.toContain("sk-secret-key-123456");
    expect(JSON.stringify(err.body)).not.toContain("sk-secret-key-123456");
    expect(err.message).toContain("[redacted]");
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    const now = Date.parse("2026-11-13T00:00:00Z");
    expect(parseRetryAfter("5", now)).toBe(5);
    expect(parseRetryAfter(" 2.5 ", now)).toBe(2.5);
    expect(parseRetryAfter("Fri, 13 Nov 2026 00:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Thu, 12 Nov 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("later", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe("redact", () => {
  it("ignores very short secrets", () => {
    expect(redact("abc abc", "abc")).toBe("abc abc");
    expect(redact("x", "")).toBe("x");
  });
});

describe("other error classes", () => {
  it("have the right names and hierarchy", () => {
    expect(new APITimeoutError()).toBeInstanceOf(APIConnectionError);
    expect(new APITimeoutError().name).toBe("APITimeoutError");
    expect(new APIConnectionError().message).toBe("Connection error.");
    expect(new APIUserAbortError()).toBeInstanceOf(MolochAIError);
    expect(new APIUserAbortError()).not.toBeInstanceOf(APIConnectionError);
  });

  it("StreamError reads the event fields", () => {
    const err = new StreamError({
      type: "upstream_timeout",
      message: "Server busy or request took too long.",
      elapsed_s: 181.2,
    });
    expect(err.type).toBe("upstream_timeout");
    expect(err.elapsedSeconds).toBe(181.2);
    expect(err.status).toBeNull();
    expect(err.message).toBe(
      "Stream error (upstream_timeout): Server busy or request took too long.",
    );
    const bare = new StreamError({});
    expect(bare.type).toBe("unknown");
    expect(bare.requestId).toBeNull();
  });
});
