/**
 * Request and response types. Field names are snake_case, exactly as on the wire.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface TextContentPart {
  type: "text";
  text: string;
}

/**
 * An image as a data URL (`data:image/png;base64,...`). Forwarded unchanged; it
 * only works when the model takes images per its card and the serving server has
 * vision enabled.
 */
export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface SystemMessage {
  role: "system";
  content: string | TextContentPart[];
  name?: string;
}

export interface UserMessage {
  role: "user";
  content: string | ContentPart[];
  name?: string;
}

export interface AssistantMessage {
  role: "assistant";
  content?: string | TextContentPart[] | null;
  /** Send the previous reply's reasoning back to keep it across turns. Non-strings are dropped. */
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolMessage {
  role: "tool";
  content: string | TextContentPart[];
  tool_call_id: string;
  name?: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Tools (OpenAI format)
// ---------------------------------------------------------------------------

export interface FunctionDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. */
  parameters?: Record<string, unknown>;
}

export interface FunctionTool {
  type: "function";
  function: FunctionDefinition;
}

/** Forwarded to the model unchanged. */
export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** A JSON string produced by the model. Parse and validate it before use. */
    arguments: string;
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Per-request options, accepted by every method. They are not sent to the server. */
export interface RequestOptions {
  /** Abort the request (and the stream). Raises `APIUserAbortError`. */
  signal?: AbortSignal;
  /** Override the client's `timeout` (milliseconds) for this request. */
  timeout?: number;
  /** Override the client's `maxRetries` for this request. */
  maxRetries?: number;
}

/**
 * Parameters for `POST /chat/completions`.
 *
 * Only parameters that reach the model are typed. MolochAI silently drops `stop`,
 * `n`, `seed`, `response_format` (there is no JSON mode), `top_k`,
 * `frequency_penalty`, `presence_penalty`, `logprobs`, `logit_bias`, `user` and
 * `stream_options`. If you point `baseURL` at another server that supports them,
 * pass them through `extraBody`.
 */
export interface ChatCompletionCreateParamsBase extends RequestOptions {
  /** Model id. Fetch the current list with `client.models.list()`. */
  model: string;
  /** At least one message. */
  messages: ChatMessage[];
  /** 0 to 2. Default depends on the model (0.6 with reasoning on, 0.7 with it off). */
  temperature?: number;
  /** 0 to 1. Default depends on the model (0.95 with reasoning on, 0.8 with it off). */
  top_p?: number;
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  /**
   * Accepted (1 to 65536) but has no effect on MolochAI: your plan's output cap
   * always applies. Other servers may honor it.
   */
  max_tokens?: number;
  /** Extra JSON fields merged into the request body, for servers other than MolochAI. */
  extraBody?: Record<string, unknown>;
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
  stream?: false | null;
  /** Queue progress is only reported for streamed requests. */
  onQueue?: undefined;
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
  stream: true;
  /**
   * Called for each `: queued · position 2 of 3 · waiting 4s` comment the
   * gateway sends while your request waits for a free slot.
   */
  onQueue?: (info: QueueInfo) => void;
}

export type ChatCompletionCreateParams =
  | ChatCompletionCreateParamsNonStreaming
  | ChatCompletionCreateParamsStreaming;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** `stop`, `length` (output cap reached) or `tool_calls`. Other servers may send other values. */
export type FinishReason = "stop" | "length" | "tool_calls" | (string & {});

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Includes reasoning tokens. This is what counts against quota. */
  total_tokens: number;
}

/** `X-RateLimit-Limit` / `X-RateLimit-Remaining` from the response headers (`null` when absent). */
export interface RateLimit {
  limit: number | null;
  remaining: number | null;
}

export interface ChatCompletionMessage {
  role: "assistant";
  /**
   * The answer. `null` when the reply is only tool calls. Non-streamed replies
   * can contain an inline `<think>...</think>` block: see `splitThink()`.
   */
  content: string | null;
  /** Reasoning, for thinking models when the server separates it. */
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: FinishReason | null;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  /** Always the public id you asked for. */
  model: string;
  choices: ChatCompletionChoice[];
  /** Always sent by MolochAI. A server behind a different `baseURL` may omit it. */
  usage: CompletionUsage;
  /**
   * Rate-limit headers of the response that produced this object. Not part of the
   * JSON body (non-enumerable, so `JSON.stringify` leaves it out).
   */
  readonly rateLimit: RateLimit;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionChunkDelta {
  role?: "assistant";
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCallDelta[];
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: FinishReason | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  /** Empty in the final usage chunk: check the length before indexing. */
  choices: ChatCompletionChunkChoice[];
  usage?: CompletionUsage | null;
}

/** Parsed from a `: queued · position 2 of 3 · waiting 4s` comment. Fields are `null` if absent. */
export interface QueueInfo {
  /** Your place in the queue (1 is next). */
  position: number | null;
  /** How many requests are waiting. */
  waiting: number | null;
  /** How long this request has waited so far, in seconds. */
  waitedSeconds: number | null;
  /** The comment text without the leading `:`. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Models and account
// ---------------------------------------------------------------------------

export interface Model {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Display name (MolochAI extension; absent on other servers). */
  name?: string;
  /** A server is serving it right now (MolochAI extension; absent on other servers). */
  available?: boolean;
}

export interface AccountModel {
  id: string;
  name: string;
  available: boolean;
  /** Smaller of your plan's and the serving server's context limit; `null` when unavailable. */
  context_limit: number | null;
}

/** `GET /api/auth/me`. MolochAI only. */
export interface Account {
  id: number;
  email: string;
  plan: string | null;
  plan_expires_at: string | null;
  /** The tier actually enforced; `payg` when running on credit with no plan. */
  tier: string;
  credit_usd: number;
  email_verified: boolean;
  api_base: string;
  default_model: string;
  /** Context limit for `default_model`, in tokens. */
  context_limit: number | null;
  models: AccountModel[];
}
