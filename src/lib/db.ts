import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

/**
 * Prisma 7 requires a driver adapter — the Rust query engine, and with it the
 * automatic datasource URL, is gone. Postgres is the only runtime database:
 * the fallback matches `docker-compose.yml`, so `docker compose up -d` is all
 * local development needs, and an explicit DATABASE_URL (production) wins.
 */
function createClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "postgresql://leadworks:leadworks@localhost:5432/leadworks",
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
