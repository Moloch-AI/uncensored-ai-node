# Contributing

Thanks for helping. Bug reports, fixes and documentation improvements are welcome. For larger
changes (new public API, different retry behavior), open an issue first so we can agree on the
design: the Python SDK ([uncensored-ai-python](https://github.com/Moloch-AI/uncensored-ai-python))
keeps the same shape, and both should stay in step.

## Setup

Requires Node 20 or newer and npm.

```bash
git clone https://github.com/Moloch-AI/uncensored-ai-node.git
cd uncensored-ai-node
npm ci          # installs dev tools and runs `prepare`, which builds dist/
```

## Commands

| Command | What it does |
|---|---|
| `npm run lint` | Biome lint and format check |
| `npm run format` | Biome: apply safe fixes and formatting |
| `npm run typecheck` | `tsc` over `src/`, `test/`, `examples/` |
| `npm test` | Unit tests (vitest, offline, mocked `fetch`) |
| `npm run test:coverage` | Unit tests with a v8 coverage report and thresholds |
| `npm run build` | Compile `src/` to `dist/` (`.js` + `.d.ts`) |
| `npm run lint:package` | Pack the package and check it with publint and Are the Types Wrong (attw) |
| `npm run check` | All of the above, as CI runs them |
| `npm pack --dry-run` | Show what the package would contain (nothing is published) |
| `npm run test:live` | Live tests against the real API; skipped unless `MOLOCHAI_LIVE=1` (see below) |

attw runs with `--ignore-rules cjs-resolves-to-esm`: the package is ESM only, and attw reports
every `require()` of an ES module, although Node 20.19+ and 22.12+ support it.

## Integration tests against the mock server

The mock server lives in [uncensored-ai-api](https://github.com/Moloch-AI/uncensored-ai-api)
(`mock-server/server.mjs`, zero dependencies). It returns canned replies, not model output, and
simulates the gateway's errors, queue comments and in-stream failures.

```bash
# in a checkout of uncensored-ai-api
node mock-server/server.mjs --port 4012 --quiet

# in this repository, another terminal
MOLOCHAI_MOCK_BASE_URL=http://127.0.0.1:4012/api/v1 npm run test:integration
```

Without `MOLOCHAI_MOCK_BASE_URL` the integration suite is skipped. The examples run against the
same server:

```bash
MOLOCHAI_BASE_URL=http://127.0.0.1:4012/api/v1 MOLOCHAI_API_KEY=mock-key node examples/stream.mjs
```

`examples/tools.ts` runs directly on Node 22.18 or newer (built-in type stripping). The examples
import `molochai` by package name, which resolves to `dist/`, so run `npm run build` after
changing `src/`.

## Live tests against the real API

`test/live/` calls the real API at `https://api.molochai.dev/api/v1`. It is excluded from
`npm test`, and its suites skip unless `MOLOCHAI_LIVE=1`.

```bash
MOLOCHAI_LIVE=1 npm run test:live                                 # unauthenticated tier only
MOLOCHAI_LIVE=1 MOLOCHAI_API_KEY=your-api-key npm run test:live   # both tiers
```

**Unauthenticated tier** (needs nothing, costs nothing): an invalid key against chat
completions, `/models` and `/api/auth/me` must throw `AuthenticationError` with status 401. Each
test logs the status, body and rate-limit headers it got.

**Authenticated tier** (also needs `MOLOCHAI_API_KEY`, for an account with a plan or credit),
in this order:

1. `models.list()`: every entry has an id, a display name and `available`, and at least one
   model is available (none available is an outage and fails the run).
2. `account.retrieve()`: `tier`, `plan`, `credit_usd`, `email_verified`, and a `context_limit`
   for every available model. The email and the credit amount are never logged or compared.
3. One completion ("Reply with the single word: pong") on
   `llama-3.3-70b-instruct-abliterated`, which does not reason, or on the first available model
   when that one is not served: the shape, the `model` echo, `finish_reason`, and usage with
   total = prompt + completion.
4. `rateLimit` (`X-RateLimit-Limit` and `X-RateLimit-Remaining`) of that same response, so no
   extra request.
5. One stream on a reasoning model (`glm-4.7-flash-uncensored` or `gemma4-26b-a4b-qat` when
   available, else any other; skipped when none is served): content or reasoning deltas, the
   usage chunk with empty `choices`, and `[DONE]`. A recording `fetch` keeps the raw bytes, and
   `textDeltas()` and `finalCompletion()` (content, reasoning, finish reason, usage) must match
   them.
6. One tool call (`get_time`, forced with `tool_choice`) on the same model as step 3: it must end
   in `finish_reason: "tool_calls"` with JSON arguments, and the follow-up with the
   `role: "tool"` result must get a normal reply.
7. An unknown model id must throw `UnprocessableEntityError` (422). When `/models` lists a model
   as unavailable, a request to it must throw `ModelUnavailableError` (503 `model_unavailable`);
   otherwise that test is skipped.

Tests check the shape of the responses, never the text. An account problem (402 no plan and no
credit, 401, 403, a used-up quota) fails the first test that meets it with one sentence, such as
"Top up the test account ..." for 402, and the tests after it are skipped.

What one run sends:

| Tier | Requests | Of which generate a reply |
|---|---|---|
| Unauthenticated | 3 | none: all are refused with 401 |
| Authenticated | 8, or 7 when every model is available | 4: the completion, the stream, the tool call and its follow-up |

The four generating requests are tiny: a one-line prompt and a reply of a word or a short
sentence. Only the stream goes to a reasoning model, which may also spend a few hundred reasoning
tokens. The other requests (models, account, the 422 and the 503) generate nothing. When the
non-reasoning model is not being served, steps 3 and 6 also go to a reasoning model, and a
transient server error can add a retry (the suite allows one per request).

Two optional variables:

- `MOLOCHAI_LIVE_MODEL=<id>` sends every generating request to that model. The workflow's
  "Run workflow" button has the same option as its `model` input.
- `MOLOCHAI_LIVE_BASE_URL` points the suite at another deployment, for example the mock server
  while you work on these tests. `MOLOCHAI_BASE_URL` is ignored on purpose, so a shell set up
  for the mock cannot turn the live tests into mock tests. The mock accepts any non-empty key,
  so run only the authenticated file there:

  ```bash
  node mock-server/server.mjs --port 4012 --quiet --unavailable qwen3.8-27b-uncensored
  MOLOCHAI_LIVE=1 MOLOCHAI_API_KEY=mock-key MOLOCHAI_LIVE_BASE_URL=http://127.0.0.1:4012/api/v1 \
    npm run test:live -- test/live/authenticated.test.ts
  ```

The [Live API workflow](.github/workflows/live.yml) runs every Monday and on demand. It always
runs the unauthenticated tier, and runs the authenticated tier only when the repository secret
`MOLOCHAI_API_KEY` exists (Settings → Secrets and variables → Actions → New repository secret);
without it, that tier is skipped and the run stays green. Keys are not scoped (a key can read
account details and create invoices), so use a key from an account kept for this purpose.

## Conventions

- Zero runtime dependencies. Native `fetch`, `ReadableStream`, `TextDecoder`, `AbortSignal` only.
- Response fields stay snake_case, as on the wire. Options and error fields are camelCase.
- Errors: branch on class, `status`, `type` and typed fields; never on message text.
- Only document what the API does. If a parameter has no effect on MolochAI, say so.
- Tests must pass offline. Use the `mockFetch` helpers in `test/fixtures.ts` and fake timers for
  anything involving retries or timeouts.
- Write in plain language and keep the tone factual.
- Every link to molochai.dev or dash.molochai.dev carries
  `?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node` (before any `#fragment`).
  API URLs (`api.molochai.dev`) are never tagged.
- Never commit API keys, `.env` files or real account data.

## Releases

[RELEASING.md](RELEASING.md) describes how a version reaches npm: the release workflow, the
first manual publish, trusted publishing and how to verify provenance.

## Pull requests

1. Branch from `main`.
2. Add or update tests for behavior changes; `npm run check` must pass.
3. Add a line to `CHANGELOG.md` under "Unreleased".
4. Describe what changed and why.

Participation is covered by the organization-wide code of conduct in the
[Moloch-AI/.github](https://github.com/Moloch-AI/.github) repository.
