import { defineConfig } from "vitest/config";

// Live tests against the real API. Opt-in: the suites skip unless MOLOCHAI_LIVE=1.
// See CONTRIBUTING.md ("Live tests against the real API").
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    environment: "node",
    // A reasoning model can think for a while before it answers "pong".
    testTimeout: 180_000,
    // One file at a time, tests in order: keeps the request rate low and the log readable.
    fileParallelism: false,
  },
});
