import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SOURCE_ROOTS = ["app", "components", "hooks", "lib", "agents"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([".git", ".next", "coverage", "dist", "node_modules", ".output"]);

function sourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(path.join(directory, entry.name));
    }
  };
  for (const sourceRoot of SOURCE_ROOTS) {
    const directory = path.join(root, sourceRoot);
    try {
      visit(directory);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files.sort();
}

function hasMessage(messages, key) {
  return key.split(".").reduce((value, segment) => {
    if (!value || typeof value !== "object" || !(segment in value)) return undefined;
    return value[segment];
  }, messages) !== undefined;
}

export function findMissingTranslations(sourceEntries, messages) {
  const missing = [];
  const bindingPattern = /\b(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*["']([^"']+)["']\s*\)/g;
  const callPattern = /\b(\w+)\(\s*["']([^"']+)["']/g;

  for (const { file, source } of sourceEntries) {
    const bindings = new Map();
    for (const match of source.matchAll(bindingPattern)) bindings.set(match[1], match[2]);
    for (const match of source.matchAll(callPattern)) {
      const namespace = bindings.get(match[1]);
      if (!namespace) continue;
      const key = match[2];
      if (!hasMessage(messages[namespace], key)) {
        const line = source.slice(0, match.index).split("\n").length;
        missing.push({ file, line, key: `${namespace}.${key}` });
      }
    }
  }
  return missing;
}

export function checkI18nCompleteness(root = process.cwd()) {
  const messages = JSON.parse(readFileSync(path.join(root, "messages", "en.json"), "utf8"));
  const sourceEntries = sourceFiles(root).map((file) => ({
    file: path.relative(root, file),
    source: readFileSync(file, "utf8"),
  }));
  return findMissingTranslations(sourceEntries, messages);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = checkI18nCompleteness();
  if (missing.length > 0) {
    console.error("Missing i18n messages:");
    for (const item of missing) console.error(`- ${item.file}:${item.line} -> ${item.key}`);
    process.exitCode = 1;
  } else {
    console.log("i18n completeness check passed");
  }
}
