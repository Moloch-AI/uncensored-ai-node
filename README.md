# uncensored-ai-node

[![CI](https://github.com/Moloch-AI/uncensored-ai-node/actions/workflows/ci.yml/badge.svg)](https://github.com/Moloch-AI/uncensored-ai-node/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A typed TypeScript/Node SDK for the MolochAI API that handles the gateway's specific behavior:
typed errors, safe retries, queue progress and in-stream errors.

## Overview

MolochAI is an OpenAI-compatible API serving five less-restricted open-weight models. This
package (`molochai` on import) is a small client for it, written in TypeScript with zero runtime
dependencies. It is for developers calling the API from Node: back-end services, scripts, CLIs
and agents.

"Uncensored" here means reduced refusal behavior. The models still sometimes decline, they are
not more accurate than their base models, and the
[Acceptable Use Policy](https://molochai.dev/acceptable-use?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node)
still applies. If you put one in front of end users, your app needs its own rules and
moderation.

```
your Node code
     │  import { MolochAI } from "molochai"
     ▼
┌────────────────────────────────┐   HTTPS, Bearer key    ┌───────────────────────────┐
│ molochai (this SDK)            │ ─────────────────────▶ │ api.molochai.dev/api/v1   │
│ retries, timeouts, SSE parser, │ ◀───────────────────── │ or the local mock server  │
│ typed errors, queue events     │  JSON / event-stream   └───────────────────────────┘
└────────────────────────────────┘
```

Where it fits in the Moloch-AI repositories:

- [uncensored-ai-api](https://github.com/Moloch-AI/uncensored-ai-api): the HTTP contract
  (OpenAPI spec), curl examples and the mock server this SDK's integration tests run against.
- [uncensored-ai-python](https://github.com/Moloch-AI/uncensored-ai-python): the Python SDK with
  the same design.
- [uncensored-llm-examples](https://github.com/Moloch-AI/uncensored-llm-examples): task-oriented
  examples in Python, JavaScript and TypeScript.
- [uncensored-ai](https://github.com/Moloch-AI/uncensored-ai): the reference guide.

### Why a dedicated SDK

The official OpenAI SDKs work with MolochAI (see
[Using the OpenAI SDK instead](https://github.com/Moloch-AI/uncensored-ai-node#using-the-openai-sdk-instead)).
This SDK exists for the parts they leave to you:

- SSE comment lines such as `: queued · position 2 of 3 · waiting 4s` are dropped by the OpenAI
  SDKs. Here they reach an `onQueue` callback.
- The gateway's three error body shapes become typed errors with the fields you act on:
  `resetsAt` for quotas, `contextCap` and `boundBy` for oversized prompts, `retryAfter` for rate
  limits.
- Quota errors (429 `quota_exceeded`) are not retried, because they will not pass before
  `resets_at`. Rate limits (429 `Too Many Attempts.`) are.
- `GET /api/auth/me` (plan, credit, per-model context limits) has a method.
- Error events inside an open stream throw `StreamError`; the cap notice has a constant and a
  helper.

## Features

- `chat.completions.create()` with TypeScript overloads: `stream: true` returns a
  `ChatCompletionStream`, otherwise a `ChatCompletion`.
- Streaming: async iteration over chunks (the final usage chunk included), `textDeltas()`,
  `finalCompletion()` (content, reasoning, tool calls with fragments merged, finish reason,
  usage), `abort()`.
- An SSE parser that handles chunks split anywhere (mid-line, mid-UTF-8 character, between CR
  and LF) and ignores keep-alive comments.
- Retries with exponential backoff and full jitter, `Retry-After` handling with a cap, and no
  retries for errors that cannot succeed. Streams retry only before their first chunk.
- An idle timeout that covers connecting, waiting for headers and gaps between stream chunks.
- `AbortSignal` support on every call.
- `models.list()` and `account.retrieve()` (MolochAI only).
- Rate-limit headers on every completion: `reply.rateLimit` is `{ limit, remaining }`.
- Helpers: `splitThink()`, `stripCapNotice()`, `CAP_NOTICE`, `parseQueueComment()`.
- The API key is masked in `inspect` and `JSON.stringify` output and redacted from errors.
- ESM, `.d.ts` types, no runtime dependencies.

## Requirements

- Node.js 20 or newer (uses the built-in `fetch`).
- A MolochAI API key, created in the dashboard at
  [dash.molochai.dev/account](https://dash.molochai.dev/account?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node)
  (Account → API keys). For offline work, the
  [mock server](https://github.com/Moloch-AI/uncensored-ai-api) accepts `mock-key`.

## Installation

The package is not on the npm registry yet. Install it from GitHub, pinned to a release tag:

```bash
npm install github:Moloch-AI/uncensored-ai-node#v0.1.1
```

Do not run `npm install molochai` for now: we have not published that name, so it would
install whatever someone else may have put there, into a project that holds your API key.
This README will say so when the package is on npm.

npm clones the repository, installs its build tools and runs the `prepare` script, which
compiles `dist/`. This takes longer than a registry install. Nothing is added to your runtime
dependencies beyond `molochai` itself.

## Quickstart

```bash
export MOLOCHAI_API_KEY=your-api-key
```

```js
// quickstart.mjs
import { MolochAI } from "molochai";

const client = new MolochAI(); // reads MOLOCHAI_API_KEY

const reply = await client.chat.completions.create({
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "Explain what a mutex is in two sentences." }],
});

console.log(reply.choices[0].message.content);
console.log(reply.usage.total_tokens, "tokens;", reply.rateLimit.remaining, "requests left this minute");
```

Node can load a `.env` file for you (see [.env.example](.env.example)):
`node --env-file=.env quickstart.mjs`.

Model ids change over time. Fetch the current list instead of hard-coding it:

```js
const models = await client.models.list();
const usable = models.filter((m) => m.available).map((m) => m.id);
```

## Usage examples

Runnable versions are in [examples/](examples/). Each reads `MOLOCHAI_API_KEY` and, optionally,
`MOLOCHAI_BASE_URL`; CI runs all of them against the mock server.

| File | Shows |
|---|---|
| [chat.mjs](examples/chat.mjs) | One completion, reasoning, usage, rate-limit headers |
| [stream.mjs](examples/stream.mjs) | Streaming reasoning and answer, queue progress, Ctrl+C abort, `StreamError` |
| [tools.ts](examples/tools.ts) | A typed tool-calling loop (Node 22.18+ runs `.ts` directly) |
| [errors.mjs](examples/errors.mjs) | What each error class means and what to do |
| [account.mjs](examples/account.mjs) | Plan, credit and per-model context limits |

```bash
MOLOCHAI_API_KEY=your-api-key node examples/stream.mjs "Write a haiku about latency."
```

### Streaming

```js
const stream = await client.chat.completions.create({
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "Write a haiku about latency." }],
  stream: true,
  onQueue: (q) => console.error(`queued: ${q.position} of ${q.waiting}, ${q.waitedSeconds}s`),
});

for await (const text of stream.textDeltas()) process.stdout.write(text);

const final = await stream.finalCompletion(); // assembled from the chunks already read
console.log(final.choices[0].finish_reason, final.usage.total_tokens);
```

Iterating the stream directly gives every `ChatCompletionChunk`. Reasoning arrives in
`delta.reasoning_content`, the answer in `delta.content`, and the last chunk has `choices: []`
with `usage`, so check the length before indexing. A stream can be iterated once;
`finalCompletion()` works before, during or after that iteration.

### Errors inside a stream

Once a stream has opened with HTTP 200, a failure arrives as an event and becomes a
`StreamError`. The text you already received stays valid.

```js
import { StreamError } from "molochai";

try {
  for await (const text of stream.textDeltas()) process.stdout.write(text);
} catch (err) {
  if (err instanceof StreamError && err.type === "preempted") {
    // The server was reclaimed mid-reply. Retry in about a minute.
  } else {
    throw err;
  }
}
```

### Tool calls

```js
const reply = await client.chat.completions.create({ model, messages, tools });
const choice = reply.choices[0];
if (choice.finish_reason === "tool_calls") {
  messages.push({
    role: "assistant",
    content: choice.message.content,
    tool_calls: choice.message.tool_calls,
  });
  for (const call of choice.message.tool_calls) {
    const args = JSON.parse(call.function.arguments); // validate before use
    const result = await runTool(call.function.name, args); // your code
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
  // then call create() again with the extended messages
}
```

MolochAI sends each tool call whole in one chunk when streaming; `finalCompletion()` also merges
fragmented arguments from servers that split them.

### Reasoning and the cap notice

```js
import { CAP_NOTICE, splitThink, stripCapNotice } from "molochai";

const message = reply.choices[0].message;
// Usually separate; some servers leave it inline as <think>...</think> in non-streamed replies.
const { reasoning, answer } = splitThink(message.content);
const thinking = message.reasoning_content ?? reasoning;

if (reply.choices[0].finish_reason === "length" && message.content?.endsWith(CAP_NOTICE)) {
  // The reply hit your plan's output cap and the gateway appended CAP_NOTICE.
  console.log(stripCapNotice(answer));
}
```

### Aborting

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);
await client.chat.completions.create({ model, messages, signal: controller.signal });
// throws APIUserAbortError when aborted; stream.abort() does the same for a stream
```

### Against the mock server or another OpenAI-compatible server

```bash
MOLOCHAI_BASE_URL=http://127.0.0.1:4010/api/v1 MOLOCHAI_API_KEY=mock-key node examples/chat.mjs
```

`chat.completions` and `models` work against any OpenAI-compatible server. `account.retrieve()`
is MolochAI-only and throws a `NotFoundError` that says so when the server has no `/auth/me`.

## Configuration

| Option | Environment variable | Default | Notes |
|---|---|---|---|
| `apiKey` | `MOLOCHAI_API_KEY` | required | Throws `MolochAIError` if missing. |
| `baseURL` | `MOLOCHAI_BASE_URL` | `https://api.molochai.dev/api/v1` | Trailing slashes are removed. |
| `timeout` | `MOLOCHAI_TIMEOUT` (seconds) | `120000` (ms) | Idle timeout: connect, headers, and each gap between stream chunks. `Infinity` disables it. |
| `maxRetries` | `MOLOCHAI_MAX_RETRIES` | `2` | Retries after the first attempt. `0` disables retries. |
| `maxRetryAfter` | | `60000` (ms) | Longest `Retry-After` to wait on a rate limit. Longer: `RateLimitError` at once. |
| `fetch` | | global `fetch` | Any `(url, init) => Promise<Response>`. |
| `defaultHeaders` | | `{}` | Sent with every request. `Authorization` always comes from `apiKey`. |
| `dangerouslyAllowBrowser` | | `false` | See [Security considerations](https://github.com/Moloch-AI/uncensored-ai-node#security-considerations). |

Options override environment variables. Invalid values (`MOLOCHAI_TIMEOUT=abc`, a non-http
`baseURL`) throw when the client is created.

Every method also takes `signal`, `timeout` and `maxRetries` for that call. Durations in options
are milliseconds; `MOLOCHAI_TIMEOUT` is seconds, as are `RateLimitError.retryAfter` and
`QueueInfo.waitedSeconds`, which mirror the wire.

The gateway's sampling defaults, output cap and context limits are set per model and plan; see
[pricing](https://molochai.dev/pricing?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node)
and the [docs](https://molochai.dev/docs?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node).

## API reference

### `new MolochAI(options?)`

Properties: `baseURL`, `timeout`, `maxRetries`, `maxRetryAfter` (resolved values), `chat`,
`models`, `account`. `toJSON()` returns those settings with the key masked.

### `client.chat.completions.create(params)`

`POST /chat/completions`.

| Param | Type | Notes |
|---|---|---|
| `model` | `string` | Required. Unknown id: `UnprocessableEntityError`. |
| `messages` | `ChatMessage[]` | Required, at least one. Roles `system`, `user`, `assistant`, `tool`. Content is a string or an array of `text` / `image_url` parts. Send `reasoning_content` back on assistant messages to keep reasoning across turns. |
| `temperature` | `number` | 0 to 2. |
| `top_p` | `number` | 0 to 1. |
| `tools`, `tool_choice` | OpenAI format | `tool_choice` is forwarded unchanged. |
| `max_tokens` | `number` | Accepted but has no effect on MolochAI: your plan's output cap applies. |
| `stream` | `boolean` | `true` resolves to a `ChatCompletionStream` once headers arrive. |
| `onQueue` | `(q: QueueInfo) => void` | Streaming only. |
| `signal`, `timeout`, `maxRetries` | | Per-call options, not sent to the server. |
| `extraBody` | `Record<string, unknown>` | Extra JSON fields, for other servers. |

MolochAI silently drops `stop`, `n`, `seed`, `response_format`, `top_k`, `frequency_penalty`,
`presence_penalty`, `logprobs`, `logit_bias`, `user` and `stream_options`, so they are not in
the types. There is no JSON mode: ask for JSON in the prompt and validate what comes back.

Returns `ChatCompletion`: `id`, `object`, `created`, `model` (the id you asked for), `choices[]`
(`index`, `finish_reason`: `stop` | `length` | `tool_calls`, `message` with `role`, `content`,
optional `reasoning_content` and `tool_calls`), `usage` (`prompt_tokens`, `completion_tokens`,
`total_tokens`; the total includes reasoning and counts against quota) and `rateLimit`
(`{ limit, remaining }` from the headers, not enumerable, so `JSON.stringify` leaves it out).

### `ChatCompletionStream`

| Member | Description |
|---|---|
| `for await (const chunk of stream)` | Every `ChatCompletionChunk`, including the usage chunk. Once only. |
| `textDeltas()` | Async iterable of non-empty `delta.content` strings. |
| `finalCompletion()` | `Promise<ChatCompletion>` assembled from the chunks. Rejects with the iteration's error. |
| `abort()` | Closes the connection; reads throw `APIUserAbortError`. |
| `controller` | The stream's `AbortController`. |
| `response`, `rateLimit` | The HTTP response and its rate-limit headers. |

### `client.models.list(options?)`

`GET /models` → `Model[]`: `id`, `object`, `created`, `owned_by`, plus the MolochAI extensions
`name` (display name) and `available` (a server is serving it now). Behind the quota check: no
plan and no credit gives `PaymentRequiredError`.

### `client.account.retrieve(options?)`

`GET /api/auth/me`, derived from `baseURL` by replacing the trailing `/v1` with `/auth/me`.
Returns `Account`: `id`, `email`, `plan`, `plan_expires_at`, `tier` (`payg` on credit with no
plan), `credit_usd`, `email_verified`, `api_base`, `default_model`, `context_limit`, and
`models[]` with `id`, `name`, `available`, `context_limit` (the smaller of your plan's and the
serving server's limit; `null` when unavailable).

### Errors

All errors extend `MolochAIError`. HTTP errors extend `APIStatusError`, which has `status`,
`type` (`error.type` or `code` from the body, else `null`), `message`, `body` (parsed JSON, raw
text for non-JSON bodies, or `null`), `headers` and `requestId`. Branch on classes and fields,
not on message text.

| Class | When | Extra fields | Retried |
|---|---|---|---|
| `AuthenticationError` | 401 | | no |
| `PaymentRequiredError` | 402 `no_active_plan` | `plan` | no |
| `PermissionDeniedError` | 403 `email_unverified` | `code` | no |
| `NotFoundError` | 404 | | no |
| `ContextLengthExceededError` | 413 `context_length_exceeded` | `estimatedTokens`, `contextCap`, `boundBy`, `plan` | no (trim, then retry yourself) |
| `UnprocessableEntityError` | 422 | `errors` (field → messages) | no |
| `RateLimitError` | 429 `Too Many Attempts.` | `retryAfter` (seconds) | yes, if `Retry-After` ≤ `maxRetryAfter` |
| `QuotaExceededError` | 429 `quota_exceeded`, `session_quota_exceeded` | `resetsAt` (`Date`), `kind` (`session` / `monthly` / `weekly`), `plan`, `used`, `cap` | no |
| `ModelUnavailableError` | 503 `model_unavailable` | `model` | no (pick another model) |
| `ServerBusyError` | 503 `server_busy`, other 503 | | yes |
| `UpstreamError` | 502, 504, 524, other 5xx, `upstream_error` | `upstreamStatus` | yes for 5xx |
| `APIStatusError` | any other status | | no |
| `APIConnectionError` | network failure, connection closed mid-stream | `cause` | yes |
| `APITimeoutError` (extends `APIConnectionError`) | nothing received within `timeout` | | yes |
| `APIUserAbortError` | your signal fired, or `stream.abort()` | | no |
| `StreamError` | error event in an open stream | `type`, `status`, `elapsedSeconds`, `requestId`, `data` | only before the first chunk, for `server_busy`, `upstream_unreachable`, `upstream_timeout`, 5xx `upstream_error` |

Non-JSON bodies (a Cloudflare 524 page, for example) are handled: `type` is `null` and `body` is
the raw text.

### Retry policy

Backoff delay before retry *n* (0-based) is a random value between 0 and
`min(8 s, 0.5 s × 2^n)` (full jitter). Rate limits wait exactly `Retry-After`. Retries happen
only before a stream yields its first chunk; after that, failures are thrown so you never get
duplicated text. If you wrap calls in your own retry loop, set `maxRetries: 0` so the two layers
do not multiply.

### Helpers and constants

| Export | Description |
|---|---|
| `splitThink(content)` | `{ reasoning, answer }` from content with `<think>` blocks; handles several blocks, an unclosed block and a lone `</think>`. `reasoning` is `null` when there was no block. |
| `stripCapNotice(text)` | Removes the cap notice from the end; `null` passes through. |
| `CAP_NOTICE` | `"\n\n[Response is too large for your current plan. Try a smaller request.]"` |
| `parseQueueComment(text)` | `QueueInfo` (`position`, `waiting`, `waitedSeconds`, `raw`) or `null`. |
| `VERSION` | Package version; sent as `User-Agent: molochai-node/<version>`. |
| `DEFAULT_BASE_URL`, `DEFAULT_TIMEOUT`, `DEFAULT_MAX_RETRIES`, `DEFAULT_MAX_RETRY_AFTER` | Defaults. |

Exported types include `ClientOptions`, `RequestOptions`, `ChatMessage` (and each message type),
`ContentPart`, `FunctionTool`, `ToolCall`, `ToolChoice`, `ChatCompletionCreateParams`
(streaming and non-streaming), `ChatCompletion`, `ChatCompletionChunk`, `CompletionUsage`,
`FinishReason`, `RateLimit`, `QueueInfo`, `Model`, `Account`, `AccountModel` and `Fetch`.

### Models

Checked on 2026-11-07; the current list is at
[molochai.dev/models](https://molochai.dev/models?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node).
In code, use `client.models.list()`.

| API id | Base model (per its card) | Reasoning |
|---|---|---|
| [`glm-5.3-flash`](https://molochai.dev/models/glm-5-3-flash?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node) | GLM-5.3-Flash (Z.ai, MIT) | on, high effort |
| [`glm-4.7-flash-uncensored`](https://molochai.dev/models/glm-4-7-flash-uncensored?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node) | GLM-4.7-Flash (Z.ai, MIT) | on, medium |
| [`gemma4-26b-a4b-qat`](https://molochai.dev/models/gemma4-26b-a4b-qat?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node) | Gemma 4 26B A4B (Google DeepMind, Apache 2.0) | on, medium |
| [`qwen3.8-27b-uncensored`](https://molochai.dev/models/qwen3-8-27b-uncensored?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node) | Qwen3.8-27B (Qwen Team, Apache 2.0) | on, medium |
| [`llama-3.3-70b-instruct-abliterated`](https://molochai.dev/models/llama-3-3-70b-instruct-abliterated?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node) | Llama-3.3-70B-Instruct (Meta, Llama 3.3 Community License) | off |

All five are refusal-reduced builds that the base developers do not publish or endorse.
Reasoning is fixed per model. There is no version pinning: the build behind an id can change.

## Using the OpenAI SDK instead

The official `openai` package works with MolochAI and is a fine choice:

```js
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "https://api.molochai.dev/api/v1",
  apiKey: process.env.MOLOCHAI_API_KEY,
});
```

It also reads `OPENAI_BASE_URL` and `OPENAI_API_KEY`. What you handle yourself in that case:
queue comments are dropped; errors arrive as generic status errors, so read `resets_at`,
`context_cap` and `bound_by` from the body; it retries the rate-limit 429 but not quota errors,
which MolochAI marks `X-Should-Retry: false`; there is no `/auth/me` method; in-stream error
events and the cap notice are yours to detect; and `reasoning_content` is present in responses
but not in its TypeScript types. Do not stack this SDK and the OpenAI SDK's retries on the same
call.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Missing API key` | Set `MOLOCHAI_API_KEY` or pass `apiKey`. |
| `AuthenticationError` (401) | Key missing, mistyped or revoked. Create a new one in the dashboard. |
| `PaymentRequiredError` (402) | No active plan and no credit, including on `models.list()`. |
| `PermissionDeniedError` with `code: "email_unverified"` | Confirm your email address. |
| `QuotaExceededError` | Not retried. Wait until `err.resetsAt`. `kind` says which quota. |
| `RateLimitError` | Over 60 requests per minute. Retried while `Retry-After` is at most `maxRetryAfter` (60 s by default); thrown when it is longer or retries run out. Slow down or raise `maxRetryAfter`. |
| `ContextLengthExceededError` | Trim the conversation below `err.contextCap` tokens. `account.retrieve()` shows each model's limit. |
| `ModelUnavailableError` | No server is serving that id right now. Pick another from `models.list()` where `available` is true. |
| `UpstreamError` with status 524 | Cloudflare gave up on a long non-streamed reply after about 100 seconds. Use `stream: true`. |
| `APITimeoutError` | Nothing arrived for `timeout` ms. Streams receive keep-alives about once a second, so a stream timeout usually means a dead connection. |
| `<think>...</think>` in `content` | Some servers leave reasoning inline in non-streamed replies. Use `splitThink()`, or stream. |
| Reply ends with `[Response is too large...]` | The plan's output cap; `finish_reason` is `"length"`. `max_tokens` cannot raise it. |
| `TypeError` reading `chunk.choices[0]` | The last chunk has `choices: []` (it carries usage). |
| `account.retrieve()` throws `NotFoundError` | `baseURL` points at a server that is not MolochAI. |
| `ERR_REQUIRE_ESM` | The package is ESM only. Use `import`. From CommonJS, `require("molochai")` works on Node 20.19+ and 22.12+; on older versions use `await import("molochai")`. In CommonJS TypeScript files, `require` of the package type-checks with `"module": "nodenext"` (TypeScript 5.8+), not with `"node16"`. |
| Type errors about `Response` or `AbortSignal` | Install `@types/node` or include the `DOM` lib in `tsconfig.json`. |

More help: [docs](https://molochai.dev/docs?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node)
and [support](https://molochai.dev/contact?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node)
(through dashboard Messages).

## Security considerations

- API keys are not scoped: a key can read account details and create invoices. Keep it on a
  server, in an environment variable or a secret store. Never ship it to a browser or mobile app.
  `new MolochAI()` throws when it detects a browser unless you pass
  `dangerouslyAllowBrowser: true`, which is meant only for local tools you run yourself.
- The SDK keeps the key in a private field, masks it in `inspect` and `JSON.stringify` output,
  and redacts it from error messages and bodies.
- Treat model output as untrusted input. Validate tool-call `arguments` before running anything,
  and do not pass model text to a shell, SQL or `eval` without checks.
- Reduced refusal behavior means fewer built-in guardrails. Apps that face end users need their
  own policy and moderation, and the
  [Acceptable Use Policy](https://molochai.dev/acceptable-use?utm_source=github&utm_medium=oss&utm_campaign=uncensored-ai-node)
  applies.
- Report vulnerabilities in this SDK as described in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands, the mock-server integration tests
and the opt-in live tests. Changes are listed in [CHANGELOG.md](CHANGELOG.md); the release
process is in [RELEASING.md](RELEASING.md).

## License

MIT. See [LICENSE](LICENSE).
