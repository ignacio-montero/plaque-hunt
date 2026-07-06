import { defineConfig } from "vitest/config";
import path from "node:path";

// Point every test run at an isolated SQLite file so the seeded dev.db is never
// touched. globalSetup provisions the schema; per-test helpers seed fixtures.
process.env.DATABASE_URL = "file:./test.db";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    globalSetup: ["./tests/globalSetup.ts"],
    environment: "node",
    // OCR is stubbed; nothing here is slow, but keep runs serial so the shared
    // test.db isn't hit by parallel files with conflicting fixtures.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    include: ["tests/**/*.test.ts"],
  },
});
