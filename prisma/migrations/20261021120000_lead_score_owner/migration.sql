-- AlterTable: `Lead.score` gets an owner (lib/lead-score.ts) and a paper trail.
ALTER TABLE "Lead" ADD COLUMN     "scoreOverride" INTEGER,
ADD COLUMN     "scoreBreakdown" JSONB,
ADD COLUMN     "scoredAt" TIMESTAMP(3);
