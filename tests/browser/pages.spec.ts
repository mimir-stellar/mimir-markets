/**
 * Page smoke: the public surface renders on a cold, unconfigured build.
 *
 * Every route here must produce a rendered page — a `main` region and its
 * signature heading — and must not throw an uncaught page error. The smoke
 * build has no database, no contract ids and no secrets, so these tests pin
 * the "fail closed and still serve UI" contract: a page that 500s, blanks
 * out, or leaks a client exception fails here.
 */

import { expect, test } from "@playwright/test";

import { expectMainLandmark, trackPageErrors } from "./helpers";

const PUBLIC_PAGES: ReadonlyArray<readonly [string, RegExp]> = [
  // Locale home: the hero headline.
  ["/en/", /don't argue/i],
  // Arena feed: DB-less build serves the empty arena, not a crash.
  ["/en/explorer", /ready to challenge/i],
  ["/en/stats", /live on-chain stats/i],
  ["/en/dashboard", /connect your wallet/i],
  ["/en/council", /twenty ai frames/i],
  ["/en/agents", /ai agents and humans/i],
  ["/en/baskets", /agent baskets/i],
  ["/en/revenue", /agent revenue/i],
  ["/en/vs/create", /set the terms and initialize challenge/i],
  ["/en/emerging-narratives", /emerging narratives/i],
  ["/en/docs", /how mimir works/i],
];

for (const [route, heading] of PUBLIC_PAGES) {
  test(`renders ${route}`, async ({ page }) => {
    const errors: string[] = [];
    trackPageErrors(page, errors);

    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expectMainLandmark(page);

    // Signature heading (may be client-rendered; Playwright polls for it).
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();

    if (route !== "/en/") {
      const connectButton = page
        .getByRole("banner")
        .getByRole("button", { name: "Connect", exact: true });
      await expect(connectButton).toBeVisible();
      await expect(connectButton).toHaveAccessibleName("Connect");
    }

    // The page is real content, not a blank shell.
    const bodyLength = await page.evaluate(() => document.body.innerText.length);
    expect(bodyLength).toBeGreaterThan(200);

    expect(errors).toEqual([]);
  });
}

test("renders branded 404 page for unknown routes with 404 status and layout", async ({
  page,
}) => {
  const errors: string[] = [];
  trackPageErrors(page, errors);

  const response = await page.goto("/en/does-not-exist", {
    waitUntil: "domcontentloaded",
  });

  expect(response?.status()).toBe(404);
  await expectMainLandmark(page);

  // Assert 404 page heading and copy
  await expect(
    page.getByRole("heading", { name: /page not found/i }),
  ).toBeVisible();
  await expect(
    page.getByText("The page you are looking for does not exist or has been moved."),
  ).toBeVisible();

  // Assert link back to explorer
  const explorerLink = page.getByRole("link", { name: "Back to Explorer" });
  await expect(explorerLink).toBeVisible();
  await expect(explorerLink).toHaveAttribute("href", "/en/explorer");

  // Assert layout (header banner and footer)
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();

  expect(errors).toEqual([]);
});