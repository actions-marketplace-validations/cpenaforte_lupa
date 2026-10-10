import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Extends the vitest defaults (node_modules, .git, .cache, ...). lib/ holds tsc output, which
    // contains compiled copies of the tests, and dist/ holds the bundle: neither is collected.
    exclude: [...configDefaults.exclude, "lib/**", "dist/**"],
  },
});
