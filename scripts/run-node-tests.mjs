import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import satisfies from "semver/functions/satisfies.js";

export const RUNNER_VERSION = 1;
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_DIRECTORY = path.join(ROOT, "tests", "node");
export const DEFAULT_CACHE_ROOT = path.join(ROOT, ".cache", "node-tests");
export const DEFAULT_COVERAGE_DIRECTORY = path.join(ROOT, "coverage", "node");
export const COVERAGE_FILENAME = "node-tests.lcov";
export const FAILED_COVERAGE_FILENAME = "node-tests.failed.lcov";

const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  "TZ",
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "FORCE_COLOR",
  "NO_COLOR",
  "TERM",
];

const DATABASE_ENV_KEYS = ["DATABASE_URL", "TURSO_DATABASE_URL"];

// Path defaults are relative to the repository. A null path leaves the choice to the runner.
const FLAGS = [
  { name: "--coverage", key: "coverage", default: false, description: "write an LCOV report" },
  { name: "--coverage-dir", key: "coverageDir", argument: "path", default: "coverage/node", enables: "coverage", description: "choose the coverage output directory and enable coverage" },
  { name: "--cache", key: "cache", default: true, negations: ["--no-cache", "--no-compile-cache"], description: "use the Node compile cache when supported" },
  { name: "--cache-dir", key: "cacheDir", argument: "path", default: null, description: "choose the compile-cache root (otherwise MIMIR_NODE_TEST_CACHE_DIR or .cache/node-tests)" },
  { name: "--clear-cache", key: "clearCache", default: false, description: "clear the selected compile cache before running" },
  { name: "--with-db", key: "includeDatabase", default: false, description: "pass database URLs to the child (use a test DB only)" },
  { name: "--help", key: "help", aliases: ["-h"], default: false, description: "show this help" },
  { name: "--help-json", key: "helpJson", default: false, description: "print the flag definitions as JSON" },
];

const flagNames = new Map();
for (const flag of FLAGS) {
  for (const name of [flag.name, ...(flag.aliases ?? [])]) {
    flagNames.set(name, { flag, enabled: true });
  }
  for (const name of flag.negations ?? []) {
    flagNames.set(name, { flag, enabled: false });
  }
}

function usage() {
  const lines = [
    "Usage: npm run test:node -- [options] [test filters]",
    "",
    "Positional arguments are filename substrings or globs. Only matching",
    "files under tests/node/ are run.",
    "",
    "Options:",
  ];
  for (const flag of FLAGS) {
    const names = [...(flag.aliases ?? []), flag.name].join(", ");
    const label = flag.argument ? `${names} <${flag.argument}>` : names;
    lines.push(`  ${label.padEnd(30)} ${flag.description} (default: ${flag.default ?? "automatic"})`);
    if (flag.negations) lines.push(`  ${flag.negations.join(", ").padEnd(30)} disable ${flag.name}`);
  }
  return lines.join("\n");
}

function fail(message) {
  throw new Error(message);
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    fail(`${option} requires a value.`);
  }
  return value;
}

export function parseArgs(argv = [], root = ROOT) {
  const options = { filters: [], files: [] };
  for (const flag of FLAGS) {
    options[flag.key] = flag.argument === "path" && flag.default !== null
      ? path.resolve(root, flag.default)
      : flag.default ?? undefined;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      options.filters.push(...argv.slice(index + 1));
      break;
    }
    if (argument.startsWith("-")) {
      const separator = argument.indexOf("=");
      const name = separator < 0 ? argument : argument.slice(0, separator);
      const entry = flagNames.get(name);
      if (!entry || (separator >= 0 && !entry.flag.argument)) {
        fail("Unknown node test option. Use --help for supported options.");
      }
      const { flag, enabled } = entry;
      if (flag.argument) {
        const value = separator >= 0 ? argument.slice(separator + 1) : requireValue(argv, index, name);
        if (separator < 0) index += 1;
        options[flag.key] = path.resolve(root, value);
        if (flag.enables) options[flag.enables] = true;
      } else {
        options[flag.key] = enabled;
      }
      continue;
    }
    options.filters.push(argument);
  }

  return options;
}

function readFileHash(filePath) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return "missing";
  }
}

function readPackageVersion(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function supportsCompileCache(nodeVersion = process.versions.node) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 1);
}

export function supportsExplicitTestIsolation(nodeVersion = process.versions.node) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 8);
}

export function cacheIdentity(root = ROOT, nodeVersion = process.versions.node) {
  return {
    runnerVersion: RUNNER_VERSION,
    nodeVersion,
    lockfile: readFileHash(path.join(root, "package-lock.json")),
    tsxVersion: readPackageVersion(path.join(root, "node_modules", "tsx", "package.json")),
  };
}

export function compileCacheDirectory({ root = ROOT, cacheRoot = DEFAULT_CACHE_ROOT, nodeVersion = process.versions.node } = {}) {
  const identity = cacheIdentity(root, nodeVersion);
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 20);
  return path.join(path.resolve(root, cacheRoot), `node-${nodeVersion}-${digest}`);
}

function assertDirectory(pathToCheck) {
  if (!existsSync(pathToCheck)) return;
  const stat = lstatSync(pathToCheck);
  if (stat.isSymbolicLink () || !stat.isDirectory()) {
    fail(`Cache path is not a directory: ${pathToCheck}`);
  }
}

function removeDirectory(directory) {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) {
    fail("Refusing to clear the filesystem root.");
  }
  if (!existsSync(resolved)) return;
  assertDirectory(resolved);
  rmSync(resolved, { recursive: true, force: true });
}

/**
 * Discover all test files under tests/node/ in the given root, sorted
 * alphabetically and returned as relative paths (e.g. "tests/node/foo.test.ts").
 */
export function discoverTestFiles(root = ROOT) {
  const testDir = path.join(root, "tests", "node");
  if (!existsSync(testDir)) return [];
  return readdirSync(testDir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join("tests", "node", name));
}

/**
 * Convert a glob-like pattern into a RegExp. Supports `*` (matches anything)
 * and `?` (matches a single character). All other characters are matched
 * literally.
 */
function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^$()[\]{}|\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${withWildcards}$`);
}

/**
 * Return true when a test file matches the given filter. A test file matches
 * when any of the following hold for the filter:
 *  - the filter is a substring of the file path or basename,
 *  - the filter is a glob that matches the file path or basename,
 *  - the filter is a relative path that resolves to the file.
 */
export function matchesFilter(file, filter) {
  if (!filter) return true;
  const normalizedFile = file.split(path.sep).join("/");
  const basename = path.basename(file);
  const normalizedFilter = filter.split(path.sep).join("/");
  if (normalizedFile.includes(normalizedFilter)) return true;
  if (basename.includes(filter)) return true;
  if (/[*?]/.test(filter)) {
    const regex = globToRegExp(normalizedFilter);
    if (regex.test(normalizedFile)) return true;
    if (globToRegExp(filter).test(basename)) return true;
  }
  return false;
}

/**
 * Select test files from the full discovered list based on the provided filters.
 * When no filters are provided, all discovered files are returned.
 */
export function selectTestFiles(allFiles, filters = []) {
  if (filters.length === 0) return [...allFiles];
  return allFiles.filter((file) => filters.some((filter) => matchesFilter(file, filter)));
}

/**
 * Return the explicit file list when provided, otherwise fall back to
 * discoverTestFiles. Paths are relative to `root`.
 */
export function normalizeTestFiles(root = ROOT, files = []) {
  if (files.length > 0) return files;
  return discoverTestFiles(root);
}

/**
 * Build the Node.js argument list for the test child process.
 *
 * Always included:
 *   --import tsx  --test
 *   --test-reporter=spec  (stdout)
 *
 * Added when supportsExplicitTestIsolation:
 *   --experimental-test-isolation=process
 *
 * Added when coverage:
 *   --experimental-test-coverage
 *   --test-reporter=lcov  --test-reporter-destination=<coveragePath>
 *
 * Test files are appended last.
 */
export function buildChildArgs({ files, coverage, coveragePath, nodeVersion = process.versions.node }) {
  const args = ["--import", "tsx", "--test"];

  if (supportsExplicitTestIsolation(nodeVersion)) {
    args.push("--experimental-test-isolation=process");
  }

  if (coverage) {
    args.push(
      "--experimental-test-coverage",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${coveragePath}`,
    );
  } else {
    args.push("--test-reporter=spec");
  }

  args.push(...files);
  return args;
}

/**
 * Build the child-process environment from an allowlisted subset of the source
 * environment plus test-specific overrides.
 *
 * Secrets (seeds, API keys, database URLs) are excluded by default.
 * Pass includeDatabase: true to forward DATABASE_URL / TURSO_DATABASE_URL.
 */
export function buildTestEnvironment({ sourceEnvironment = process.env, cacheDirectory, includeDatabase = false }) {
  const env = {};

  for (const key of SAFE_ENV_KEYS) {
    if (key in sourceEnvironment) env[key] = sourceEnvironment[key];
  }

  if (!env.PATH && sourceEnvironment.Path) {
    env.PATH = sourceEnvironment.Path;
  }

  if (includeDatabase) {
    for (const key of DATABASE_ENV_KEYS) {
      if (key in sourceEnvironment) env[key] = sourceEnvironment[key];
    }
  }

  env.NODE_ENV = "test";
  env.MIMIR_NODE_TESTS = "1";

  if (cacheDirectory) {
    env.NODE_COMPILE_CACHE = cacheDirectory;
  }

  return env;
}

/**
 * Ensure the compile-cache directory exists and write a manifest.json recording
 * the identity inputs. The manifest lets the cache be invalidated when inputs
 * (Node version, lockfile, tsx version) change.
 */
export function prepareCompileCache(cacheDirectory, root = ROOT, nodeVersion = process.versions.node) {
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  assertDirectory(cacheDirectory);
  const identity = cacheIdentity(root, nodeVersion);
  const manifestPath = path.join(cacheDirectory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(identity, null, 2), "utf8");
}

function coveragePaths(directory) {
  const resolved = path.resolve(directory);
  const parent = path.dirname(resolved);
  if (existsSync(parent)) assertDirectory(parent);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  assertDirectory(resolved);
  return {
    final: path.join(resolved, COVERAGE_FILENAME),
    failed: path.join(resolved, FAILED_COVERAGE_FILENAME),
  };
}

function finalizeCoverage(paths, temporaryPath, status) {
  if (!existsSync(temporaryPath)) return;
  const destination = status === 0 ? paths.final : paths.failed;
  if (existsSync(destination)) rmSync(destination, { force: true });
  renameSync(temporaryPath, destination);
}

export function runNodeTests({
  argv = [],
  root = ROOT,
  sourceEnvironment = process.env,
  spawn = spawnSync,
  nodeVersion = process.versions.node,
} = {}) {
  const options = typeof argv === "string" ? parseArgs(argv.split(" "), root) : parseArgs(argv, root);
  if (options.help || options.helpJson) {
    console.log(options.helpJson ? JSON.stringify({ flags: FLAGS }, null, 2) : usage());
    return 0;
  }

  const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (!satisfies(nodeVersion, engines.node)) {
    fail(`Detected Node.js ${nodeVersion}. This project requires ${engines.node}. Run nvm use in the repository root and retry.`);
  }

  const allFiles = discoverTestFiles(root);
  const filters = options.filters;
  const filtered = selectTestFiles(allFiles, filters);
  if (filters.length > 0 && filtered.length === 0) {
    fail(`No test files matched filter: ${filters.join(", ")}`);
  }
  const files = normalizeTestFiles(root, filtered);
  if (filters.length > 0) {
    console.log(`Selected ${files.length} test file(s) for filter ${JSON.stringify(filters)}:`);
    for (const file of files) console.log(`  ${file}`);
  }

  const cacheRoot = options.cacheDir ?? sourceEnvironment.MIMIR_NODE_TEST_CACHE_DIR ?? DEFAULT_CACHE_ROOT;
  const cacheEnabled = options.cache && supportsCompileCache(nodeVersion);
  let cacheDirectory;
  if (cacheEnabled || options.clearCache) {
    cacheDirectory = compileCacheDirectory({ root, cacheRoot, nodeVersion });
    if (options.clearCache) removeDirectory(cacheDirectory);
    if (cacheEnabled) {
      try {
        prepareCompileCache(cacheDirectory, root, nodeVersion);
      } catch (error) {
        console.error(`Node compile cache unavailable; continuing without it. ${error instanceof Error ? error.message : "Cache setup failed."}`);
        cacheDirectory = undefined;
      }
    } else {
      cacheDirectory = undefined;
    }
  }

  const coverage = options.coverage ? coveragePaths(options.coverageDir) : undefined;
  const coveragePath = coverage ? path.join(path.dirname(coverage.final), `${COVERAGE_FILENAME}.${process.pid}.tmp`) : undefined;
  if (coverage && coveragePath) {
    for (const destination of [coverage.final, coverage.failed, coveragePath]) {
      rmSync(destination, { force: true });
    }
  }

  const args = buildChildArgs({
    files,
    nodeVersion,
    coverage: Boolean(coverage),
    coveragePath,
  });
  const environment = buildTestEnvironment({
    sourceEnvironment,
    cacheDirectory,
    includeDatabase: options.includeDatabase,
  });
  if (!options.cache) {
    environment.NODE_DISABLE_COMPILE_CACHE = "1";
  }

  let result;
  try {
    result = spawn(process.execPath, args, {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
  } catch {
    if (coveragePath) rmSync(coveragePath, { force: true });
    fail("Node test process could not start. Check the local Node installation.");
  }
  if (result.error) {
    if (coveragePath) rmSync(coveragePath, { force: true });
    fail("Node test process could not start. Check the local Node installation.");
  }
  const status = result.status ?? 1;
  if (coverage) {
    try {
      finalizeCoverage(coverage, coveragePath, status);
    } catch (error) {
      console.error(`Could not finalize coverage: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return status;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const status = runNodeTests({ argv: process.argv.slice(2) });
    process.exitCode = status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Node test runner failed.");
    process.exitCode = 1;
  }
}
