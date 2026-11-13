import { describe, expect, it } from "vitest";
import { CAP_NOTICE, parseQueueComment, splitThink, stripCapNotice } from "../src/index.js";

describe("CAP_NOTICE / stripCapNotice", () => {
  it("is the exact gateway text", () => {
    expect(CAP_NOTICE).toBe(
      "\n\n[Response is too large for your current plan. Try a smaller request.]",
    );
  });

  it("removes the notice from the end", () => {
    expect(stripCapNotice(`Partial answer${CAP_NOTICE}`)).toBe("Partial answer");
  });

  it("removes the notice when the separator is missing", () => {
    expect(stripCapNotice(CAP_NOTICE.trimStart())).toBe("");
    expect(stripCapNotice(`Partial\n${CAP_NOTICE.trimStart()}`)).toBe("Partial");
  });

  it("leaves other text alone", () => {
    expect(stripCapNotice("Complete answer.")).toBe("Complete answer.");
    expect(stripCapNotice(`${CAP_NOTICE} and more`)).toBe(`${CAP_NOTICE} and more`);
  });

  it("passes null and undefined through", () => {
    expect(stripCapNotice(null)).toBeNull();
    expect(stripCapNotice(undefined)).toBeUndefined();
  });
});

describe("splitThink", () => {
  it("splits a leading think block", () => {
    expect(splitThink("<think>\nLet me see.\n</think>\n\nThe answer is 4.")).toEqual({
      reasoning: "Let me see.",
      answer: "The answer is 4.",
    });
  });

  it("returns content without tags unchanged", () => {
    expect(splitThink("  Just an answer.\n")).toEqual({
      reasoning: null,
      answer: "  Just an answer.\n",
    });
  });

  it("joins several blocks", () => {
    expect(splitThink("<think>a</think>One <think>b</think>two")).toEqual({
      reasoning: "a\n\nb",
      answer: "One two",
    });
  });

  it("treats an unclosed block as reasoning (reply cut at the cap)", () => {
    expect(splitThink("<think>still thinking when the cap hit")).toEqual({
      reasoning: "still thinking when the cap hit",
      answer: "",
    });
  });

  it("handles a closing tag without an opening tag", () => {
    expect(splitThink("reasoning first\n</think>\n\nAnswer.")).toEqual({
      reasoning: "reasoning first",
      answer: "Answer.",
    });
  });

  it("returns an empty reasoning string for an empty block", () => {
    expect(splitThink("<think>\n\n</think>\n\nHi")).toEqual({ reasoning: "", answer: "Hi" });
  });

  it("accepts null and empty content", () => {
    expect(splitThink(null)).toEqual({ reasoning: null, answer: "" });
    expect(splitThink(undefined)).toEqual({ reasoning: null, answer: "" });
    expect(splitThink("")).toEqual({ reasoning: null, answer: "" });
  });
});

describe("parseQueueComment", () => {
  it("parses the gateway format", () => {
    expect(parseQueueComment("queued · position 2 of 3 · waiting 4s")).toEqual({
      position: 2,
      waiting: 3,
      waitedSeconds: 4,
      raw: "queued · position 2 of 3 · waiting 4s",
    });
  });

  it("tolerates missing parts and other separators", () => {
    expect(parseQueueComment("queued - position 5")).toEqual({
      position: 5,
      waiting: null,
      waitedSeconds: null,
      raw: "queued - position 5",
    });
    expect(parseQueueComment("queued")).toMatchObject({ position: null, waitedSeconds: null });
  });

  it("ignores other comments", () => {
    expect(parseQueueComment("ka")).toBeNull();
    expect(parseQueueComment("hb")).toBeNull();
    expect(parseQueueComment("")).toBeNull();
  });
});
