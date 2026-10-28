import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,   // tests share one database and reason about global audit-chain state
    env: {
      DATABASE_URL: "postgres://grainspan_app:grainspan_app_dev@127.0.0.1:54329/grainspan_test",
      MIGRATION_DATABASE_URL: "postgres://postgres@127.0.0.1:54329/grainspan_test",
      NODE_ENV: "test",
      APP_TIMEZONE: "Asia/Kolkata",
      SESSION_SECRET: "test-session-secret-test-session-secret-0000",
    },
  },
});
