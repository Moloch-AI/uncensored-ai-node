# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-13

First release. Installed from GitHub (`npm install github:Moloch-AI/uncensored-ai-node#v0.1.0`);
not published to the npm registry.

### Added

- `MolochAI` client with `chat.completions.create()`, `models.list()` and `account.retrieve()`.
  Configuration from options or `MOLOCHAI_API_KEY`, `MOLOCHAI_BASE_URL`, `MOLOCHAI_TIMEOUT`
  (seconds) and `MOLOCHAI_MAX_RETRIES`.
- Streaming with `ChatCompletionStream`: async iteration over chunks (usage chunk included),
  `textDeltas()`, `finalCompletion()` (content, reasoning, merged tool calls, finish reason,
  usage), `abort()`, and an `onQueue` callback for `: queued · position ...` comments.
- Typed errors for every documented status and body shape, including `QuotaExceededError`
  (`resetsAt`, `kind`), `ContextLengthExceededError` (`estimatedTokens`, `contextCap`, `boundBy`),
  `RateLimitError` (`retryAfter`), `ModelUnavailableError` and `StreamError` for error events
  inside an open stream.
- Retries with exponential backoff and full jitter for connection errors, timeouts and 5xx
  (except `model_unavailable`); `Retry-After` waits for rate limits, capped by `maxRetryAfter`;
  no retries for quota, auth, validation or context errors. Streams retry only before the first
  chunk is yielded.
- Idle timeout covering the connection, the response headers and the gap between stream chunks.
- Helpers: `splitThink()`, `stripCapNotice()`, `CAP_NOTICE`, `parseQueueComment()`.
- API key masked in `inspect`/`JSON.stringify` output and redacted from error messages.
- Examples for chat, streaming, tools, errors and account limits.
