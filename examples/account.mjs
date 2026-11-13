// Plan, credit and per-model context limits (GET /api/auth/me), plus which models are up.
//
//   MOLOCHAI_API_KEY=your-api-key node examples/account.mjs
//
// account.retrieve() is MolochAI-only; against another OpenAI-compatible server it throws NotFoundError.
import { MolochAI } from "molochai";

const client = new MolochAI();
const me = await client.account.retrieve();

console.log(`plan: ${me.plan ?? "none"} (tier ${me.tier}), credit: $${me.credit_usd}`);
console.log(`default model: ${me.default_model}, context ${me.context_limit} tokens\n`);

for (const model of me.models) {
  const limit = model.context_limit === null ? "-" : `${model.context_limit} tokens`;
  console.log(`${model.available ? "up  " : "down"}  ${model.id.padEnd(36)} ${limit}`);
}
