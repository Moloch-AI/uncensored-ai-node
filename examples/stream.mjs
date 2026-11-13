// Stream a reply: queue progress, reasoning, answer, usage. Ctrl+C aborts cleanly.
//
//   MOLOCHAI_API_KEY=your-api-key node examples/stream.mjs "Write a haiku about latency."
import { APIUserAbortError, CAP_NOTICE, MolochAI, StreamError } from "molochai";

const MODEL = "glm-5.3-flash";

const client = new MolochAI();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());

const stream = await client.chat.completions.create({
  model: MODEL,
  messages: [{ role: "user", content: process.argv[2] ?? "Write a haiku about latency." }],
  stream: true,
  signal: controller.signal,
  // `: queued · position 2 of 3 · waiting 4s` comments, parsed.
  onQueue: (q) =>
    process.stderr.write(`[queued: position ${q.position} of ${q.waiting}, ${q.waitedSeconds}s]\n`),
});

let inReasoning = false;
try {
  for await (const chunk of stream) {
    // The last chunk carries usage and has `choices: []`.
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.reasoning_content) {
      if (!inReasoning) process.stdout.write("[reasoning] ");
      inReasoning = true;
      process.stdout.write(delta.reasoning_content);
    }
    if (delta.content) {
      if (inReasoning) process.stdout.write("\n\n");
      inReasoning = false;
      process.stdout.write(delta.content);
    }
  }
} catch (err) {
  if (err instanceof StreamError) {
    // The stream had opened (HTTP 200) and then failed: keep what arrived, decide whether to retry.
    console.error(`\n[stream failed: ${err.type}] ${err.message}`);
    process.exit(1);
  }
  if (err instanceof APIUserAbortError) {
    console.error("\n[aborted]");
    process.exit(130);
  }
  throw err;
}

const final = await stream.finalCompletion();
const choice = final.choices[0];
if (choice.finish_reason === "length" && choice.message.content?.endsWith(CAP_NOTICE)) {
  console.error("\n[hit the plan's output cap]");
}
console.log(`\n\n[${choice.finish_reason}] ${final.usage.total_tokens} tokens`);
