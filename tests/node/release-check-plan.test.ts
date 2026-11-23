import { test } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";

test("release-check-plan prints plan", () => {
  // Use shell to run the npm script, capturing output
  const output = execSync("npm run release:check-plan").toString();
  assert.ok(output.includes("Release Check Plan:"), "Output should contain header");
  assert.ok(output.includes("[READY] npm run agents:create-wallets"), "Should show READY status for create-wallets");
});
