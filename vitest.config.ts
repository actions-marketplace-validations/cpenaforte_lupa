import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default test globs. lib/ holds tsc output (compiled copies of the tests) and dist/ the bundle:
    // neither may be collected as tests.
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["lib/**", "dist/**", "node_modules/**"],
  },
});
