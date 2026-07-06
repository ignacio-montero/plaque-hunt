// Global setup: build a fresh, isolated SQLite database for the whole test run
// so the seeded dev.db (2,078 real plaques) is never mutated by tests.
//
// We copy the schema-only DB via `prisma db push` against DATABASE_URL=test.db,
// then tear it down afterwards.
import { execSync } from "node:child_process";
import { existsSync, unlinkSync, readdirSync } from "node:fs";
import path from "node:path";

const TEST_DB_URL = "file:./test.db";
// Prisma resolves file: URLs relative to the schema dir (prisma/), so the
// on-disk path is prisma/test.db.
const TEST_DB_PATH = path.resolve(__dirname, "..", "prisma", "test.db");

const TMP_UPLOADS_DIR = path.resolve(
  __dirname,
  "..",
  "data",
  "cache",
  "tmp-uploads",
);

function listTmp(): Set<string> {
  try {
    return new Set(readdirSync(TMP_UPLOADS_DIR));
  } catch {
    return new Set();
  }
}

export default async function setup() {
  process.env.DATABASE_URL = TEST_DB_URL;

  for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-journal`]) {
    if (existsSync(p)) unlinkSync(p);
  }

  // Snapshot pre-existing temp uploads so teardown removes only what the suite
  // creates (the capture flow always writes a temp file; abandoned/never-
  // confirmed ones would otherwise litter the dir).
  const tmpBefore = listTmp();

  // No --force-reset: we already deleted the file above, so this is a plain
  // create-and-sync on a fresh DB (Prisma blocks --force-reset under an AI agent
  // as a destructive-action guard; we don't need it here).
  execSync("npx prisma db push --skip-generate", {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: "ignore",
  });

  return () => {
    for (const p of [TEST_DB_PATH, `${TEST_DB_PATH}-journal`]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
    // Remove temp uploads created during the run.
    for (const f of listTmp()) {
      if (!tmpBefore.has(f)) {
        try {
          unlinkSync(path.join(TMP_UPLOADS_DIR, f));
        } catch {
          /* ignore */
        }
      }
    }
  };
}
