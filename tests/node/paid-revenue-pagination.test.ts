import { expect, test } from "vitest";
import { recordPayment, getRevenueSummary } from "../../lib/paid-revenue";

test("paginates in-memory revenue summary", async () => {
  for (let i = 0; i < 30; i++) {
    await recordPayment({
      resource: "test",
      scheme: "test",
      network: "stellar:testnet",
      assetAddress: "test",
      amountAtomic: 1000000n,
      payer: "G123",
      seller: "G456",
      transactionHash: "hash" + i,
      paymentIdentifier: "id" + i,
      facilitator: "F",
      settledAt: 1000 + i,
    });
  }

  // Without offset, limit 10: gets the most recent 10 (29 down to 20)
  const page1 = await getRevenueSummary(10, 0);
  expect(page1.recent.length).toBe(10);
  expect(page1.recent[0].paymentIdentifier).toBe("id29");
  expect(page1.recent[9].paymentIdentifier).toBe("id20");

  // With offset 10, limit 10: gets the next 10 (19 down to 10)
  const page2 = await getRevenueSummary(10, 10);
  expect(page2.recent.length).toBe(10);
  expect(page2.recent[0].paymentIdentifier).toBe("id19");
  expect(page2.recent[9].paymentIdentifier).toBe("id10");

  // Out of bounds offset
  const page3 = await getRevenueSummary(10, 50);
  expect(page3.recent.length).toBe(0);
});
