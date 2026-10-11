"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { mintApiKey } from "@/lib/apikeys";
import { requireSession } from "@/lib/session";
import type { FirstKeyResult } from "@/components/api-key-onboarding";

/**
 * Mint the workspace's first API key, from the browser session.
 *
 * The API-key routes authenticate with a bearer key, which a person signing up
 * does not have yet — so without this the only way in was to already have
 * credentials. The workspace comes from the session, never from the form, so a
 * signed-in customer cannot mint a key against somebody else's workspace by
 * tampering with the request.
 */
export async function createFirstKey(): Promise<FirstKeyResult> {
  const session = await requireSession();

  // Re-checked here rather than trusted from the page: between render and click
  // the last key may have been revoked elsewhere, and the prompt should only
  // appear while there is genuinely nothing to use.
  const live = await prisma.apiKey.count({
    where: { workspaceId: session.workspaceId, revokedAt: null },
  });
  if (live > 0) {
    return { ok: false, error: "This workspace already has an API key." };
  }

  const key = await mintApiKey(session.workspaceId, "First key");
  revalidatePath("/dashboard");
  return { ok: true, plaintext: key.plaintext, prefix: key.prefix };
}
