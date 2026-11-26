import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { stdio: "inherit", ...options });
  if (result.error) throw new Error(`Não foi possível executar ${program}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${program} terminou com código ${result.status ?? result.signal}${result.stderr ? `: ${String(result.stderr).trim()}` : ""}`);
  return result;
}

export function runChecks(steps, options = {}) {
  for (const { title, program, args } of steps) {
    console.log(`\n[qualidade] ${title}`);
    command(program, args, options);
  }
}

export function git(repository, args) {
  const result = command("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.stdout.trim();
}

/** Export the actual index, including partial staging, without touching HEAD,
 * the user's index/worktree, or creating a commit. GIT_INDEX_FILE is respected. */
export function stagedSnapshot(repository, temporaryRoot = tmpdir()) {
  const directory = mkdtempSync(join(temporaryRoot, "behavetracker-staged-"));
  try {
    git(repository, ["checkout-index", "--all", `--prefix=${directory}${sep}`]);
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");

export function attachLocalDependencies(repository, directory) {
  // Running staged code with dependencies from a different lock can give false
  // approval. setup/prepare records the lock used by npm install/ci.
  const lock = join(directory, "package-lock.json");
  const receipt = join(repository, "node_modules/.behavetracker-lock.sha256");
  if (!existsSync(lock) || !existsSync(receipt) || readFileSync(receipt, "utf8").trim() !== digest(lock)) {
    throw new Error("Dependências não correspondem ao package-lock preparado para commit. Execute npm ci antes de tentar novamente.");
  }
  verifyInstalledDependencies(repository, lock);
  symlinkSync(resolve(repository, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const binaries = join(repository, "src-tauri/binaries");
  if (existsSync(binaries)) cpSync(binaries, join(directory, "src-tauri/binaries"), { recursive: true });
}

export function verifyInstalledDependencies(repository, lock = join(repository, "package-lock.json")) {
  const installed = join(repository, "node_modules/.package-lock.json");
  if (!existsSync(installed)) throw new Error("Registro das dependências instaladas ausente. Execute npm ci.");
  const expected = JSON.parse(readFileSync(lock, "utf8")).packages;
  const actual = JSON.parse(readFileSync(installed, "utf8")).packages;
  for (const name of Object.keys(actual)) {
    if (name && !expected[name]) throw new Error(`Dependência fora do lock preparado: ${name}. Execute npm ci.`);
  }
  for (const [name, item] of Object.entries(expected)) {
    if (!name) continue;
    if (!actual[name] && (item.optional || item.devOptional)) continue;
    if (!actual[name] || ["version", "integrity", "resolved"].some(key => item[key] !== actual[name][key])) {
      throw new Error(`Dependência instalada difere do lock: ${name}. Execute npm ci.`);
    }
  }
}
