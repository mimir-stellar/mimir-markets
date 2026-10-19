import { expect, test } from "@playwright/test";

import { expectMainLandmark, trackPageErrors } from "./helpers";

test("basket agent search has a persistent accessible name", async ({ page }) => {
  const errors: string[] = [];
  trackPageErrors(page, errors);
  await page.goto("/en/baskets/new", { waitUntil: "domcontentloaded" });
  await expectMainLandmark(page);

  const search = page.getByRole("searchbox", { name: "Search agents by name" });
  await expect(search).toBeVisible();
  await search.fill("no-such-agent-339");
  await expect(search).toHaveAccessibleName("Search agents by name");
  await search.fill("");
  await expect(search).toHaveValue("");
  await expect(search).toHaveAccessibleName("Search agents by name");
  expect(errors).toEqual([]);
});

test("a no-match search updates one polite status", async ({ page }) => {
  await page.goto("/en/baskets/new", { waitUntil: "domcontentloaded" });
  await expectMainLandmark(page);

  const message = page.getByRole("main").getByRole("status");
  await expect(message).toHaveCount(1);
  const region = await message.elementHandle();
  await page.getByRole("searchbox", { name: "Search agents by name" }).fill("no-such-agent-339");
  await expect(message).toHaveText("No agent matches “no-such-agent-339”.");
  await expect(message).toHaveAttribute("aria-live", "polite");
  expect(await region?.evaluate((element) => element.isConnected)).toBe(true);
});
