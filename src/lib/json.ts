import type { Prisma } from "@/generated/prisma/client";

/**
 * Re-wrap a JSON blob read back from our own database for a Prisma write.
 *
 * Prisma types DB reads as JsonValue (nullable, mutable) but write inputs as
 * InputJsonValue (non-null, readonly-compatible). Anything we wrote ourselves
 * satisfies the write side; this documents the single place the conversion
 * happens instead of scattering `as` casts across every job runner.
 */
export function asInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Spread-safe view of a stored JSON object (config blobs, filter maps). */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
