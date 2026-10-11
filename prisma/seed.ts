import { prisma } from "../src/lib/db";
import { mintApiKey } from "../src/lib/apikeys";

/**
 * Create the demo row only if it is not there yet. Source, EnrichmentRule and
 * ExportProfile have no unique constraint on name (deliberately: a customer may
 * want two exports with the same label), so this cannot be an upsert — the
 * lookup is the findFirst and the demo workspace is the scope. Without it, every
 * `npm run db:seed` added a third copy of the demo data.
 */
async function once<T>(label: string, find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find();
  if (existing) {
    console.log(`Already present: ${label}`);
    return existing;
  }
  const created = await create();
  console.log(`Created: ${label}`);
  return created;
}

async function main() {
  console.log("Seeding LeadWorks...");

  const workspace = await prisma.workspace.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Workspace", slug: "demo" },
  });

  console.log("Created workspace:", workspace.id);

  const source = await once(
    "source LinkedIn Scraper",
    () => prisma.source.findFirst({ where: { workspaceId: workspace.id, name: "LinkedIn Scraper" } }),
    () => prisma.source.create({
      data: {
        workspaceId: workspace.id,
        name: "LinkedIn Scraper",
        type: "WEB_SCRAPER",
        config: {
          url: "https://www.linkedin.com/search/results/people/",
          selectors: {
            container: ".reusable-search__result-container",
            firstName: ".entity-result__title-text a span[aria-hidden=true]",
            lastName: "",
            title: ".entity-result__primary-subtitle",
            company: ".entity-result__secondary-subtitle",
            linkedinUrl: ".entity-result__title-text a",
          },
          pagination: { type: "next_button", selector: ".artdeco-pagination__button--next", maxPages: 3 },
        },
        schedule: "0 9 * * *",
        isActive: true,
      },
    }),
  );

  const rule = await once(
    "enrichment rule Auto-enrich new leads",
    () => prisma.enrichmentRule.findFirst({ where: { workspaceId: workspace.id, name: "Auto-enrich new leads" } }),
    () => prisma.enrichmentRule.create({
      data: {
        workspaceId: workspace.id,
        name: "Auto-enrich new leads",
        description: "Enrich leads with Apollo and Clearbit when created",
        trigger: "ON_CREATE",
        conditions: { status: "NEW" },
        actions: { fields: ["email", "phone", "title", "company", "technologies"] },
        providers: ["apollo", "clearbit"],
        priority: 1,
        isActive: true,
      },
    }),
  );

  const exportProfile = await once(
    "export profile Weekly Lead Export",
    () => prisma.exportProfile.findFirst({ where: { workspaceId: workspace.id, name: "Weekly Lead Export" } }),
    () => prisma.exportProfile.create({
      data: {
        workspaceId: workspace.id,
        name: "Weekly Lead Export",
        description: "Export all qualified leads weekly",
        format: "CSV",
        fields: ["email", "firstName", "lastName", "company", "title", "phone", "linkedinUrl", "score"],
        filterJson: { status: "QUALIFIED" },
        schedule: "0 9 * * 1", // Every Monday 9 AM
        isActive: true,
      },
    }),
  );

  console.log(`Demo rows: source ${source.id}, rule ${rule.id}, export ${exportProfile.id}`);

  
  // Demo API key for smoke tests and the live demo. The plaintext prints once
  // here and is never stored — copy it into smoke scripts, then rotate it.
  await prisma.apiKey.deleteMany({ where: { workspaceId: workspace.id, name: "Demo key" } });
  const demoKey = await mintApiKey(workspace.id, "Demo key");
  console.log("Demo key (copy now, never shown again):", demoKey.plaintext);
console.log("Seeding complete!");
  console.log("Workspace: demo");
  console.log("API running on port 3300");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });