import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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

function usage() {
  return [
    "Usage: npm run test:node -- [options] [test files]",
    "",
    "Options:",
    "  --coverage                 write coverage/node/node-tests.lcov",
    "  --coverage-dir <path>      choose the coverage output directory",
    "  --no-cache                 disable the Node compile cache",
    "  --cache-dir <path>         choose the compile-cache root",
    "  --clear-cache              clear the selected compile cache before running",
    "  --with-db                  pass database URLs to the child (use a test DB only)",
    "  -h, --help                 show this help",
  ].join("\n");
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
  const options = {
    cache: true,
    clearCache: false,
    coverage: false,
    coverageDir: path.resolve(root, "coverage", "node"),
    cacheDir: undefined,
    includeDatabase: false,
    help: false,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      options.files.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--coverage") {
      options.coverage = true;
      continue;
    }
    if (argument === "--no-cache" || argument === "--no-compile-cache") {
      options.cache = false;
      continue;
    }
    if (argument === "--cache") {
      options.cache = true;
      continue;
    }
    if (argument === "--clear-cache") {
      options.clearCache = true;
      continue;
    }
    if (argument === "--with-db") {
      options.includeDatabase = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument.startsWith("--coverage-dir=")) {
      options.coverageDir = path.resolve(root, argument.slice("--coverage-dir=".length));
      options.coverage = true;
      continue;
    }
    if (argument === "--coverage-dir") {
      options.coverageDir = path.resolve(root, requireValue(argv, index, argument));
      options.coverage = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("--cache-dir=")) {
      options.cacheDir = path.resolve(root, argument.slice("--cache-dir=".length));
      continue;
    }
    if (argument === "--cache-dir") {
      options.cacheDir = path.resolve(root, requireValue(argv, index, argument));
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      fail("Unknown node test option. Use --help for supported options.");
    }
    options.files.push(argument);
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
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
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

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, filePath);
}

function prepareCompileCache(directory, root, nodeVersion = process.versions.node) {
  const resolved = path.resolve(directory);
  const identity = cacheIdentity(root, nodeVersion);
  const manifestPath = path.join(resolved, "manifest.json");
  let shouldClear = false;

  if (existsSync(resolved)) {
    assertDirectory(resolved);
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      shouldClear = JSON.stringify(manifest) !== JSON.stringify(identity);
    } catch {
      shouldClear = true;
    }
    if (shouldClear) removeDirectory(resolved);
  }

  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  writeJsonAtomically(manifestPath, identity);
  return resolved;
}

export function discoverTestFiles(root = ROOT) {
  const directory = path.join(root, "tests", "node");
  if (!existsSync(directory)) fail("Node test directory is missing.");
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.join("tests", "node", entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) fail("No node tests found.");
  return files;
}

function normalizeTestFiles(root, requestedFiles) {
  const files = requestedFiles.length > 0 ? requestedFiles : discoverTestFiles(root);
  const testRoot = path.resolve(root, "tests", "node");
  return files.map((file) => {
    const absolute = path.resolve(root, file);
    const relative = path.relative(testRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("Node tests must be inside tests/node.");
    }
    if (!absolute.endsWith(".test.ts") || !existsSync(absolute)) {
      fail("Node test file is missing or has an unsupported name.");
    }
    return path.join("tests", "node", relative);
  });
}

export function buildChildArgs({ files, coverage = false, coveragePath, nodeVersion = process.versions.node } = {}) {
  const args = ["--import", "tsx", "--test"];
  if (supportsExplicitTestIsolation(nodeVersion)) args.push("--experimental-test-isolation=process");
  if (coverage) {
    args.push(
      "--experimental-test-coverage",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${coveragePath}`,
    );
  }
  args.push(...files);
  return args;
}

export function buildTestEnvironment({
  sourceEnvironment = process.env,
  cacheDirectory,
  includeDatabase = false,
} = {}) {
  const environment = {};
  for (const key of SAFE_ENV_KEYS) {
    if (sourceEnvironment[key] !== undefined) environment[key] = sourceEnvironment[key];
  }
  if (includeDatabase) {
    for (const key of DATABASE_ENV_KEYS) {
      if (sourceEnvironment[key] !== undefined) environment[key] = sourceEnvironment[key];
    }
  }
  environment.NODE_ENV = "test";
  environment.MIMIR_NODE_TESTS = "1";
  if (cacheDirectory) {
    environment.NODE_COMPILE_CACHE = cacheDirectory;
  }
  return environment;
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
} = {}) {
  const options = typeof argv === "string" ? parseArgs(argv.split(" "), root) : parseArgs(argv, root);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const files = normalizeTestFiles(root, options.files);
  const cacheRoot = options.cacheDir ?? sourceEnvironment.MIMIR_NODE_TEST_CACHE_DIR ?? DEFAULT_CACHE_ROOT;
  const cacheEnabled = options.cache && supportsCompileCache();
  let cacheDirectory;
  if (cacheEnabled || options.clearCache) {
    cacheDirectory = compileCacheDirectory({ root, cacheRoot });
    if (options.clearCache) removeDirectory(cacheDirectory);
    if (cacheEnabled) {
      try {
        prepareCompileCache(cacheDirectory, root);
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
      if (status === 0 && !existsSync(coverage.final)) {
        fail("Node tests passed but the coverage report was not produced.");
      }
    } catch (error) {
      rmSync(coveragePath, { force: true });
      fail(`Coverage report could not be finalized. ${error instanceof Error ? error.message : "Report setup failed."}`);
    }
  }
  return status;
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    return runNodeTests({ argv, ...dependencies });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Node tests could not start.";
    console.error(message);
    return 1;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
