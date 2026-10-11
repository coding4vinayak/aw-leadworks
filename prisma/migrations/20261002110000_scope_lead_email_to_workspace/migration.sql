-- Redefines the lead identity from "this address exists somewhere in the fleet"
-- to "this workspace already has this address". A global unique on Lead.email
-- made a second customer's insert fail on the first customer's data.
DROP INDEX "Lead_workspaceId_email_idx";
DROP INDEX "Lead_email_key";

-- The (workspaceId, email) pair is what the scraper upsert and the API conflict
-- path both key on, so the constraint and the lookup are the same shape.
CREATE UNIQUE INDEX "Lead_workspaceId_email_key" ON "Lead"("workspaceId", "email");
