# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Tests and contributor docs only; the SDK's code is unchanged.

### Changed

- The authenticated live tests (`test/live/`) now also check a stream on a reasoning model
  against its raw bytes (`textDeltas()`, `finalCompletion()`, reasoning, the usage chunk and
  `[DONE]`), a tool call and its follow-up, the rate-limit headers, and two errors that cost
  nothing (an unknown model id, a model that is not being served). The completion goes to the
  non-reasoning model when it is served. An account with no plan or credit fails one test with a
  "top up the test account" message and the rest are skipped. The account test no longer
  compares the email. `MOLOCHAI_LIVE_MODEL` (also a `model` input of the Live API workflow)
  picks the model, and `MOLOCHAI_LIVE_BASE_URL` replaces `MOLOCHAI_BASE_URL` for pointing the
  suite at the mock server. CONTRIBUTING.md lists the requests of one run.

## [0.1.1] - 2026-11-13

Prepares the package for the npm registry; it is not published there yet, and the install
instruction is still the GitHub one. The SDK's code and API are the same as in 0.1.0; what
changed is the package around it and the files that ship in it.

### Changed

- README: the install command points at the `v0.1.1` tag on GitHub, and the README says
  plainly that the package is not on npm yet and that `npm install molochai` must not be used
  until it is (we have not published that name). The two in-page links ("Using the OpenAI SDK
  instead", "Security considerations") are now absolute GitHub links: npm's README renderer
  prefixes heading ids with `user-content-`, so a bare `#anchor` link is not sure to land on
  npmjs.com. Relative links to repository files are unchanged; npm rewrites them to the GitHub
  repository. The `ERR_REQUIRE_ESM` row now says that `require("molochai")` works on Node
  20.19+ and 22.12+, and which TypeScript settings accept it.
- `package.json`: `homepage` is the MolochAI docs page instead of the GitHub README (the
  repository link stays in `repository`); more `keywords`.
- `VERSION`, and with it the `User-Agent` header, is `0.1.1`.

### Added

- Release workflow (`.github/workflows/release.yml`). Publishing a GitHub release checks that
  the tag matches `package.json`, runs lint, typecheck, unit and integration tests, packs the
  package once, checks that tarball with publint and Are the Types Wrong, attaches it to the
  release and, when the repository variable `PUBLISH_TO_NPM` is `true`, publishes the same file
  to npm through trusted publishing with provenance. Run by hand, it only builds and checks.
- `RELEASING.md`: the first, manual npm publish (in the same change that switches the README
  to `npm install molochai`), trusted publisher setup, each release, and how to verify
  provenance.
- `npm run lint:package` (publint and `@arethetypeswrong/cli`, pinned as dev dependencies); CI
  runs it on every Node version.
- Opt-in live tests against the real API in `test/live/` (`MOLOCHAI_LIVE=1 npm run test:live`):
  an invalid key must get `AuthenticationError` (401) from all three endpoints, and with a real
  `MOLOCHAI_API_KEY` one tiny completion and one tiny stream are checked for shape. They are
  excluded from `npm test`. The `Live API` workflow runs them weekly and on demand; the
  authenticated tier runs only when the `MOLOCHAI_API_KEY` repository secret exists.

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
