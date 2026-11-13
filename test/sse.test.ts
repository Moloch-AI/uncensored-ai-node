import { describe, expect, it } from "vitest";
import { SSEDecoder, type SSEItem } from "../src/sse.js";

const encoder = new TextEncoder();

function decodeAll(chunks: Uint8Array[]): SSEItem[] {
  const decoder = new SSEDecoder();
  const out: SSEItem[] = [];
  for (const c of chunks) out.push(...decoder.push(c));
  out.push(...decoder.end());
  return out;
}

/** Split `bytes` at every possible single boundary and at every byte. */
function splits(bytes: Uint8Array): Uint8Array[][] {
  const out: Uint8Array[][] = [[bytes]];
  for (let i = 1; i < bytes.length; i++) out.push([bytes.slice(0, i), bytes.slice(i)]);
  out.push(Array.from(bytes, (b) => Uint8Array.of(b)));
  return out;
}

const SAMPLE =
  ": queued · position 2 of 3 · waiting 4s\r\n\r\n" +
  'data: {"content":"héllo 日本 🙂"}\r\n\r\n' +
  ": ka\n\n" +
  "event: message\nid: 7\ndata: line one\ndata: line two\n\n" +
  "data: cr-only\r\r" +
  "data:no-space\n\n" +
  "retry: 1000\nunknown: x\ndata: [DONE]\n\n";

const EXPECTED: SSEItem[] = [
  { kind: "comment", text: "queued · position 2 of 3 · waiting 4s" },
  { kind: "event", event: null, data: '{"content":"héllo 日本 🙂"}', id: null },
  { kind: "comment", text: "ka" },
  { kind: "event", event: "message", data: "line one\nline two", id: "7" },
  { kind: "event", event: null, data: "cr-only", id: "7" },
  { kind: "event", event: null, data: "no-space", id: "7" },
  { kind: "event", event: null, data: "[DONE]", id: "7" },
];

describe("SSEDecoder", () => {
  it("parses a sample stream in one chunk", () => {
    expect(decodeAll([encoder.encode(SAMPLE)])).toEqual(EXPECTED);
  });

  it("gives the same result for every chunk boundary (mid-line, mid-UTF-8, mid-CRLF)", () => {
    const bytes = encoder.encode(SAMPLE);
    for (const chunks of splits(bytes)) {
      expect(decodeAll(chunks)).toEqual(EXPECTED);
    }
  });

  it("handles a CRLF split exactly between CR and LF", () => {
    const decoder = new SSEDecoder();
    const out = [
      ...decoder.push(encoder.encode("data: a\r")),
      ...decoder.push(encoder.encode("\n\r")),
      ...decoder.push(encoder.encode("\ndata: b\r\n\r\n")),
    ];
    expect(out.map((i) => (i.kind === "event" ? i.data : i.text))).toEqual(["a", "b"]);
  });

  it("decodes a 4-byte character split across three chunks", () => {
    const bytes = encoder.encode("data: 🙂\n\n");
    const decoder = new SSEDecoder();
    const out = [
      ...decoder.push(bytes.slice(0, 7)),
      ...decoder.push(bytes.slice(7, 8)),
      ...decoder.push(bytes.slice(8)),
    ];
    expect(out).toEqual([{ kind: "event", event: null, data: "🙂", id: null }]);
  });

  it("dispatches a trailing event that has no blank line", () => {
    expect(decodeAll([encoder.encode("data: [DONE]")])).toEqual([
      { kind: "event", event: null, data: "[DONE]", id: null },
    ]);
  });

  it("ignores blank lines without data and keeps empty data lines", () => {
    expect(decodeAll([encoder.encode("\n\n\ndata:\n\n")])).toEqual([
      { kind: "event", event: null, data: "", id: null },
    ]);
  });

  it("treats a bare colon as an empty comment", () => {
    expect(decodeAll([encoder.encode(":\n\n")])).toEqual([{ kind: "comment", text: "" }]);
  });

  it("strips a leading byte-order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("data: x\n\n")]);
    expect(decodeAll([bytes])).toEqual([{ kind: "event", event: null, data: "x", id: null }]);
  });

  it("ignores an id containing NUL", () => {
    expect(decodeAll([encoder.encode("id: a\0b\ndata: x\n\n")])).toEqual([
      { kind: "event", event: null, data: "x", id: null },
    ]);
  });
});
