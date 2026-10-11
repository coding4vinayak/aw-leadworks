import { prisma } from "../src/lib/db";
import { mintApiKey } from "../src/lib/apikeys";

async function main() {
  const workspace = await prisma.workspace.upsert({
    where: { slug: "demo" },
    update: {},
    create: { name: "Demo Workspace", slug: "demo" },
  });
  await prisma.apiKey.deleteMany({ where: { workspaceId: workspace.id, name: "Smoke key" } });
  const key = await mintApiKey(workspace.id, "Smoke key");
  console.log(key.plaintext);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
