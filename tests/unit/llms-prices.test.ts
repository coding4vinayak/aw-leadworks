// The AI-readable price list, and the price list the product sells.
//
// /llms.txt is what an AI assistant reads, and it quotes the price it finds
// there. So a price in the llms.txt that the app's own pricing page does not
// carry is a price nobody sells — the worst kind of invented price, because
// it is the one an assistant repeats.
//
// The llms.txt is a static file and the pricing page is rendered from the
// app's own copy, so nothing but this test keeps the two in step. It caught
// nothing when it was written, which is exactly why it is here: the two were
// never going to be compared by hand after every price change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LLMS = readFileSync(new URL("../../public/llms.txt", import.meta.url), "utf8");
const PRICING = readFileSync(new URL("../../src/app/pricing/page.tsx", import.meta.url), "utf8");

/**
 * The product's own price, from the llms.txt's Pricing block — the lines
 * from "Pricing" to the next blank one.
 */
function statedPrices(): string[] {
  const lines = LLMS.split("\n");
  const start = lines.findIndex((line) => line.startsWith("Pricing"));
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(start)) {
    if (block.length && line.trim() === "") break;
    block.push(line);
  }
  // A range — the suite's "$19–$99" — is a claim about the suite rather than
  // about this product, so it is not read as two prices.
  const text = block.join(" ").replace(/\$[0-9][0-9,]*(\.[0-9]+)?[-–—]\$?[0-9][0-9,]*(\.[0-9]+)?/g, "a range");
  return [...new Set(text.match(/\$[0-9][0-9,]*(\.[0-9]+)?/g) ?? [])];
}

test("every price the llms.txt states is a price the pricing page states", () => {
  const stated = statedPrices();
  for (const amount of stated) {
    assert.ok(
      PRICING.includes(amount),
      `the llms.txt states ${amount}, and the pricing page does not — an assistant would quote a price nobody sells`,
    );
  }
});

test("the llms.txt states a price at all", () => {
  assert.ok(statedPrices().length > 0, "an llms.txt with no price is not the index an assistant needs");
});
