/**
 * Prisma 7: the CLI's datasource URL moved out of the schema and into this
 * file, and `.env` is no longer loaded on its own. `process.env` is read
 * directly — with the same dev fallback as `src/lib/db.ts` — rather than via
 * `env()` from `prisma/config`, because that helper throws when the variable
 * is unset and CI runs `prisma generate` with no DATABASE_URL at all.
 *
 * The fallback keeps v6's file: `file:./dev.db` in the schema used to resolve
 * against the schema directory, so the database lives at `prisma/dev.db`.
 */
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "file:./prisma/dev.db",
  },
});
