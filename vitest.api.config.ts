import { defineConfig } from "vitest/config";
import path from "node:path";

// HTTP-level tests: boots a fresh database + the real built Next server + mock provider APIs (run `npm run build` first).
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["tests/api/**/*.test.ts"], testTimeout: 90_000, hookTimeout: 120_000, fileParallelism: false, pool: "forks" },
});
