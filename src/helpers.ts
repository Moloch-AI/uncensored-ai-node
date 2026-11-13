/**
 * Helpers for reply text: the output-cap notice and inline `<think>` blocks.
 *
 * @module
 */

/**
 * Appended by the gateway to the content when a reply stops at your plan's output
 * cap without a tool call (`finish_reason` is then `"length"`).
 */
export const CAP_NOTICE =
  "\n\n[Response is too large for your current plan. Try a smaller request.]";

const CAP_SENTENCE = CAP_NOTICE.trimStart();

/**
 * Remove the cap notice from the end of `text`, if present. Other text is returned
 * unchanged; `null` and `undefined` pass through.
 */
export function stripCapNotice<T extends string | null | undefined>(text: T): T {
  if (typeof text !== "string") return text;
  if (text.endsWith(CAP_NOTICE)) return text.slice(0, -CAP_NOTICE.length) as T;
  if (text.endsWith(CAP_SENTENCE)) return text.slice(0, -CAP_SENTENCE.length).trimEnd() as T;
  return text;
}

/** Result of {@link splitThink}. */
export interface SplitThink {
  /** Text inside the `<think>` block(s), trimmed; `null` when there was no block. */
  reasoning: string | null;
  /** Everything outside the block(s), with leading whitespace removed. */
  answer: string;
}

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Split a non-streamed reply into reasoning and answer.
 *
 * When the serving server leaves reasoning inline, a non-streamed `content`
 * starts with `<think>...</think>` (the gateway strips these only while
 * streaming). Handles several blocks, an unclosed block (a reply cut off at the
 * cap: everything after `<think>` is reasoning) and a lone `</think>` with no
 * opening tag (some chat templates put the opening tag in the prompt).
 * Content without any tag is returned unchanged as `answer`.
 */
export function splitThink(content: string | null | undefined): SplitThink {
  if (!content) return { reasoning: null, answer: content ?? "" };
  const open = content.indexOf(OPEN);
  const close = content.indexOf(CLOSE);
  if (open === -1 && close === -1) return { reasoning: null, answer: content };

  const parts: string[] = [];
  let answer = "";
  let rest = content;

  if (close !== -1 && (open === -1 || close < open)) {
    parts.push(rest.slice(0, close));
    rest = rest.slice(close + CLOSE.length);
  }

  for (;;) {
    const o = rest.indexOf(OPEN);
    if (o === -1) {
      answer += rest;
      break;
    }
    answer += rest.slice(0, o);
    const c = rest.indexOf(CLOSE, o + OPEN.length);
    if (c === -1) {
      parts.push(rest.slice(o + OPEN.length));
      break;
    }
    parts.push(rest.slice(o + OPEN.length, c));
    rest = rest.slice(c + CLOSE.length);
  }

  const reasoning = parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n\n");
  return { reasoning, answer: answer.trimStart() };
}
