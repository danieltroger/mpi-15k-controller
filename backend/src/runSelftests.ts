import { readdirSync } from "fs";
import path from "path";
import process from "process";
import { spawnSync } from "child_process";

/**
 * Discovers and runs every src/**\/*.selftest.ts sequentially — `yarn selftest` (here and in CI)
 * so a new selftest file is picked up by naming convention alone, never by editing a workflow.
 * Each file stays an independently runnable script (they process.exit themselves, so they're
 * spawned rather than imported); process.execArgv carries yarn's PnP hooks into the children.
 */
const sourceRoot = path.join(path.dirname(process.argv[1]), ".");
const selftestFiles = findSelftests(sourceRoot).sort();

if (!selftestFiles.length) {
  console.error("No *.selftest.ts files found under", sourceRoot);
  process.exit(1);
}

const failures: string[] = [];
for (const file of selftestFiles) {
  const relative = path.relative(sourceRoot, file);
  console.log(`\n━━━ ${relative} ━━━`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [...process.execArgv, file], { stdio: "inherit" });
  if (result.error) console.error(`  spawn error:`, result.error);
  console.log(
    `━━━ ${relative}: ${result.status === 0 ? "passed" : `FAILED (exit ${result.status})`} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ━━━`
  );
  if (result.status !== 0) failures.push(relative);
}

console.log(`\n${selftestFiles.length - failures.length}/${selftestFiles.length} selftest files passed`);
if (failures.length) {
  console.error("Failed:", failures.join(", "));
  process.exit(1);
}

function findSelftests(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...findSelftests(fullPath));
    else if (entry.name.endsWith(".selftest.ts")) found.push(fullPath);
  }
  return found;
}
