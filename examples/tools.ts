// Tool calling, typed. Runs directly on Node >= 22.18 (built-in type stripping):
//
//   MOLOCHAI_API_KEY=your-api-key node examples/tools.ts
import { type ChatMessage, type FunctionTool, MolochAI } from "molochai";

const MODEL = "glm-5.3-flash";

const tools: FunctionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

// Your implementation. The model only asks; your code decides what runs.
function getWeather(args: { city: string }): { city: string; temp_c: number; sky: string } {
  return { city: args.city, temp_c: 4, sky: "overcast" };
}

function parseArgs(raw: string): { city: string } {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { city?: unknown }).city !== "string"
  ) {
    throw new Error(`Invalid get_weather arguments: ${raw}`);
  }
  return value as { city: string };
}

const client = new MolochAI();
const messages: ChatMessage[] = [
  { role: "user", content: "What's the weather in Oslo right now?" },
];

for (let turn = 0; turn < 5; turn++) {
  const reply = await client.chat.completions.create({ model: MODEL, messages, tools });
  const choice = reply.choices[0];
  if (!choice) throw new Error("No choices in the reply");
  const calls = choice.message.tool_calls ?? [];

  if (choice.finish_reason !== "tool_calls" || calls.length === 0) {
    console.log(choice.message.content);
    break;
  }

  // Keep the assistant turn (with its tool calls and reasoning) in the history.
  messages.push({
    role: "assistant",
    content: choice.message.content,
    tool_calls: calls,
    reasoning_content: choice.message.reasoning_content ?? null,
  });
  for (const call of calls) {
    console.log(`-> ${call.function.name}(${call.function.arguments})`);
    const result =
      call.function.name === "get_weather"
        ? getWeather(parseArgs(call.function.arguments))
        : { error: `unknown tool ${call.function.name}` };
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
  }
}
