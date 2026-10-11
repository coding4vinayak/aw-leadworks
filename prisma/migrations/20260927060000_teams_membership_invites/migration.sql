/*
  Warnings:

  - You are about to drop the `_UserToWorkspace` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "acceptedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Invite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Membership_workspaceId_idx" ON "Membership"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_workspaceId_key" ON "Membership"("userId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Invite_tokenHash_key" ON "Invite"("tokenHash");

-- CreateIndex
CREATE INDEX "Invite_workspaceId_idx" ON "Invite"("workspaceId");

-- CreateIndex
CREATE INDEX "Invite_email_idx" ON "Invite"("email");

-- Preserve existing seats: only rows whose user and workspace both still
-- exist are carried over, credited OWNER. Orphaned rows (users deleted by hand,
-- raw-SQL writes with the columns swapped) are left behind on purpose — they
-- name accounts that do not exist and must not become seats.
INSERT INTO "Membership" ("id", "userId", "workspaceId", "role", "createdAt")
SELECT lower(hex(randomblob(12))), "B", "A", 'OWNER', CURRENT_TIMESTAMP
FROM "_UserToWorkspace"
WHERE EXISTS (SELECT 1 FROM "User" WHERE "User"."id" = "_UserToWorkspace"."B")
  AND EXISTS (SELECT 1 FROM "Workspace" WHERE "Workspace"."id" = "_UserToWorkspace"."A");


-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "_UserToWorkspace";
PRAGMA foreign_keys=on;

