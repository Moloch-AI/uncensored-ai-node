/**
 * TypeScript/Node SDK for the MolochAI API.
 *
 * @packageDocumentation
 */

export {
  AccountResource,
  Chat,
  type ClientOptions,
  Completions,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_AFTER,
  DEFAULT_TIMEOUT,
  Models,
  MolochAI,
} from "./client.js";
export type { Fetch } from "./core.js";
export {
  APIConnectionError,
  APIStatusError,
  type APIStatusErrorInit,
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
  type QuotaKind,
  RateLimitError,
  ServerBusyError,
  StreamError,
  UnprocessableEntityError,
  UpstreamError,
} from "./errors.js";
export { CAP_NOTICE, type SplitThink, splitThink, stripCapNotice } from "./helpers.js";
export { ChatCompletionStream, parseQueueComment } from "./streaming.js";
export type * from "./types.js";
export { VERSION } from "./version.js";

import { MolochAI } from "./client.js";
export default MolochAI;
