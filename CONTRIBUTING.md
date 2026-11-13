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

- **Unauthenticated tier** (needs nothing, costs nothing): an invalid key against chat
  completions, `/models` and `/api/auth/me` must throw `AuthenticationError` with status 401.
  Each test logs the status, body and rate-limit headers it got.
- **Authenticated tier** (also needs `MOLOCHAI_API_KEY`, for an account with a plan or credit):
  lists models, reads the account, and sends one tiny completion and one tiny stream ("Reply
  with the single word: pong") to the first available model. It checks the shape of the
  responses, not the text. A reasoning model also spends some reasoning tokens on the two
  replies.

```bash
MOLOCHAI_LIVE=1 npm run test:live                                 # unauthenticated tier only
MOLOCHAI_LIVE=1 MOLOCHAI_API_KEY=your-api-key npm run test:live   # both tiers
```

`MOLOCHAI_BASE_URL` points the suite at another server. Against the mock server the
authenticated tier passes with `mock-key`; the unauthenticated tier fails there by design,
because the mock accepts any non-empty key.

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
