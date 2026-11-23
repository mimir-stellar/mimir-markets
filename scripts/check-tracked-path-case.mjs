import { execFileSync } from "node:child_process";

const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" });
const spellings = new Map();
for (const file of tracked.split("\0").filter(Boolean)) {
  // Include directories: Docs/a and docs/b would merge on a case-insensitive checkout.
  let path = "";
  for (const component of file.split("/")) {
    path = path ? path + "/" + component : component;
    const key = path.toLowerCase();
    if (!spellings.has(key)) spellings.set(key, new Set());
    spellings.get(key).add(path);
  }
}

for (const key of [...spellings.keys()].sort()) {
  const paths = [...spellings.get(key)].sort();
  if (paths.length > 1) {
    console.error("Case-only tracked path collision:", paths.map((path) => JSON.stringify(path)).join(" / "));
    process.exitCode = 1;
  }
}
