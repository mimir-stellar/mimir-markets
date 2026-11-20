/** Export a captured drafting batch. Never imports the live creator worker. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDryRunBatchManifest,
  serializeDryRunBatchManifest,
  type BatchManifestInput,
} from "../agents/market-creator/batch-manifest.js";

export function exportBatchManifest(argv: readonly string[]): number {
  let inputPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === "--help" || option === "-h") {
      console.log("Usage: npm run market-creator:manifest -- --input <batch.json> [--out <manifest.json>]");
      return 0;
    }
    if (option !== "--input" && option !== "--out") throw new Error("Unknown manifest option");
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error("Manifest option requires a file path");
    if (option === "--input") {
      if (inputPath) throw new Error("--input must be supplied once");
      inputPath = value;
    } else {
      if (outPath) throw new Error("--out must be supplied once");
      outPath = value;
    }
  }
  if (!inputPath) throw new Error("--input is required");
  if (outPath && resolve(inputPath) === resolve(outPath)) throw new Error("Output must differ from the input file");
  const input: BatchManifestInput = JSON.parse(readFileSync(inputPath, "utf8"));
  if (!input || typeof input !== "object" || !input.budget) throw new Error("Invalid batch input");
  const manifest = buildDryRunBatchManifest(input);
  const output = serializeDryRunBatchManifest(manifest);
  if (outPath) writeFileSync(outPath, output, { encoding: "utf8", flag: "wx", mode: 0o600 });
  else process.stdout.write(output);
  return manifest.error ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = exportBatchManifest(process.argv.slice(2));
  } catch {
    // Do not echo source responses, paths, or credentials from file errors.
    console.error("Batch manifest export failed; check the input schema and output path. No live actions were performed.");
    process.exitCode = 1;
  }
}
