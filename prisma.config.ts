/**
 * Prisma 7: the CLI's datasource URL moved out of the schema and into this
 * file, and `.env` is no longer loaded on its own. `process.env` is read
 * directly — with the same dev fallback as `src/lib/db.ts` — rather than via
 * `env()` from `prisma/config`, because that helper throws when the variable
 * is unset and CI runs `prisma generate` with no DATABASE_URL at all.
 *
 * The fallback matches `docker-compose.yml`: local development needs nothing
 * but `docker compose up -d`.
 */
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://leadworks:leadworks@localhost:5432/leadworks",
  },
});
