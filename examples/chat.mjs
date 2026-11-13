// One non-streamed chat completion.
//
//   MOLOCHAI_API_KEY=your-api-key node examples/chat.mjs "What is a mutex?"
//
// Reads MOLOCHAI_API_KEY and, optionally, MOLOCHAI_BASE_URL (for the mock server).
import { MolochAI, splitThink } from "molochai";

// Current ids come from `client.models.list()`; this is one of them.
const MODEL = "glm-5.3-flash";

const client = new MolochAI();
const question = process.argv[2] ?? "Explain what a mutex is in two sentences.";

const reply = await client.chat.completions.create({
  model: MODEL,
  messages: [{ role: "user", content: question }],
});

const message = reply.choices[0].message;
// Non-streamed replies can carry reasoning inline as <think>...</think>.
const inline = splitThink(message.content);
const reasoning = message.reasoning_content ?? inline.reasoning;

if (reasoning) console.log(`[reasoning]\n${reasoning}\n`);
console.log(inline.answer);
console.log(
  `\n[${reply.choices[0].finish_reason}] ${reply.usage.total_tokens} tokens ` +
    `(prompt ${reply.usage.prompt_tokens}, completion ${reply.usage.completion_tokens}); ` +
    `rate limit ${reply.rateLimit.remaining}/${reply.rateLimit.limit} left this minute`,
);
