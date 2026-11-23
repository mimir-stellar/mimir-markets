/**
 * Credential-free release check-plan generator.
 *
 * Usage: npm run release:check-plan
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TASKS = {
  "agents:create-wallets": {
    deps: [],
    check: () => true, // No credentials needed
  },
  "agents:fund": {
    deps: ["agents:create-wallets"],
    check: () => !!process.env.MASTER_SECRET,
  },
  "deploy:contract": {
    deps: ["agents:fund"],
    check: () => !!process.env.DATABASE_URL,
  },
  "verify:artifacts": {
    deps: [],
    check: () => true, // Offline
  },
  "verify:deployment": {
    deps: ["deploy:contract"],
    check: () => !!process.env.DATABASE_URL,
  },
  "smoke:onchain": {
    deps: ["verify:deployment"],
    check: () => true,
  },
};

function check(taskName) {
  const task = TASKS[taskName];
  if (!task) return { status: "UNKNOWN", message: "Unknown task" };

  // Check dependencies recursively
  for (const dep of task.deps) {
    const depStatus = check(dep);
    if (depStatus.status === "BLOCKER") {
      return { status: "BLOCKER", message: `Dependency ${dep} is blocked` };
    }
  }

  // Check self
  if (!task.check()) {
    return { status: "BLOCKER", message: "Missing environment configuration" };
  }

  return { status: "READY", message: "OK" };
}

function main() {
  console.log("Release Check Plan:");
  for (const [name, task] of Object.entries(TASKS)) {
    const result = check(name);
    console.log(`[${result.status}] npm run ${name}${result.status === "BLOCKER" ? ` (${result.message})` : ""}`);
  }
}

main();
