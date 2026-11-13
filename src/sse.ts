/**
 * Incremental server-sent events decoder (WHATWG event-stream rules).
 *
 * Bytes can arrive split anywhere: in the middle of a line, of a UTF-8
 * character, or between the `\r` and `\n` of a CRLF. Comment lines (starting
 * with `:`) are returned as `comment` items so callers can read queue progress;
 * everything else about them is ignored.
 *
 * @internal
 * @module
 */

/** @internal */
export type SSEItem =
  | { kind: "event"; event: string | null; data: string; id: string | null }
  | { kind: "comment"; text: string };

/** @internal */
export class SSEDecoder {
  #decoder = new TextDecoder("utf-8");
  #buffer = "";
  #pendingCR = false;
  #data: string[] = [];
  #hasData = false;
  #event: string | null = null;
  #id: string | null = null;

  /** Feed a chunk of bytes; returns the complete items it produced. */
  push(chunk: Uint8Array): SSEItem[] {
    return this.#feed(this.#decoder.decode(chunk, { stream: true }));
  }

  /**
   * Flush at end of input. A trailing event without its blank line is still
   * dispatched (lenient: some servers end with `data: [DONE]\n`).
   */
  end(): SSEItem[] {
    const out = this.#feed(this.#decoder.decode());
    if (this.#buffer.length > 0) {
      this.#line(this.#buffer, out);
      this.#buffer = "";
    }
    this.#dispatch(out);
    return out;
  }

  #feed(text: string): SSEItem[] {
    const out: SSEItem[] = [];
    let s = text;
    if (this.#pendingCR && s.length > 0) {
      if (s.charCodeAt(0) === 10) s = s.slice(1);
      this.#pendingCR = false;
    }
    const buf = this.#buffer + s;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.#line(buf.slice(start, i), out);
      if (c === 13) {
        if (i + 1 < buf.length) {
          if (buf.charCodeAt(i + 1) === 10) i++;
        } else {
          this.#pendingCR = true;
        }
      }
      start = i + 1;
    }
    this.#buffer = buf.slice(start);
    return out;
  }

  #line(line: string, out: SSEItem[]): void {
    if (line.length === 0) {
      this.#dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58 /* : */) {
      const text = line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1);
      out.push({ kind: "comment", text });
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case "data":
        this.#data.push(value);
        this.#hasData = true;
        break;
      case "event":
        this.#event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.#id = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
  }

  #dispatch(out: SSEItem[]): void {
    if (this.#hasData) {
      out.push({ kind: "event", event: this.#event, data: this.#data.join("\n"), id: this.#id });
    }
    this.#data = [];
    this.#hasData = false;
    this.#event = null;
  }
}
