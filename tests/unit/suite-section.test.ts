// The suite on a pricing page.
//
// Five of the products sold the product alone and never mentioned that there
// was a suite — the suite being the commercial model: every product is sold
// standalone, and one contract can set up a workspace across all of them. A
// buyer who reads this page is a buyer the owner could have had a different
// conversation with.
//
// The prices of the *other* products are a cross-host fact, so they are
// checked across hosts by the deploy sweep — the same sweep that compares
// each app's llms.txt with its own pricing page. What this test holds is the
// shape: the section is there, it names products, each one links to its own
// sign-up, and each one says what it costs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const PRICING = readFileSync(new URL("../../src/app/pricing/page.tsx", import.meta.url), "utf8");

/** The suite section, from its heading to the next heading. */
function suiteSection(): string {
  const start = PRICING.indexOf("Also in the Abetworks suite");
  if (start < 0) return "";
  const rest = PRICING.slice(start);
  const end = rest.indexOf("<h2", 10);
  return end < 0 ? rest : rest.slice(0, end);
}

test("the pricing page tells the buyer there is a suite", () => {
  const section = suiteSection();
  assert.ok(section, "the pricing page has no 'Also in the Abetworks suite' section");
  assert.ok(
    section.includes("one contract can set up a workspace across all of them"),
    "the section must say what one contract buys",
  );
  assert.ok(
    section.includes("mailto:support@abetworks.in"),
    "and it must be one click from that sentence",
  );
});

test("every companion links to its own sign-up and says what it costs", () => {
  const section = suiteSection();
  assert.ok(section, "the pricing page has no 'Also in the Abetworks suite' section");
  const entries = [...section.matchAll(/<a href="(https:\/\/[^"]+)"[\s\S]*?<\/a>/g)].map((m) => m[0]);
  assert.ok(entries.length >= 3, `the section names ${entries.length} companions, and it should name at least three`);
  for (const entry of entries) {
    const host = /href="https:\/\/([^/"]+)/.exec(entry)?.[1] ?? "";
    const name = /<span className="font-semibold text-gray-900">([^<]+)<\/span>/.exec(entry)?.[1] ?? "";
    const price = /(\$[0-9][0-9,]*)/.exec(entry)?.[1] ?? "";
    assert.ok(name, "every companion needs a name");
    assert.ok(price, `${name} is listed without a price`);
    // The link is the product's own home: a buyer who wants that product
    // should be able to start there, not write a letter — and a companion
    // that points off the suite is a broken cross-sell.
    assert.ok(
      host.endsWith(".abetworks.in"),
      `${name} links to ${host}, which is not a home in the suite`,
    );
  }
});
