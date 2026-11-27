import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyInstalledDependencies } from "./core.mjs";

export function installHooks(root) {
  // npm ci in CI and exported staged snapshots do not have a local Git checkout.
  if (process.env.CI || !existsSync(resolve(root, ".git"))) return;
  const current = spawnSync("git", ["-C", root, "config", "--get", "core.hooksPath"], { encoding: "utf8" });
  if (current.status !== 0 && current.status !== 1) throw new Error("Não foi possível consultar os hooks do Git.");
  if (current.stdout.trim() && current.stdout.trim() !== ".githooks") {
    throw new Error(`core.hooksPath já usa ${current.stdout.trim()}. Integre .githooks/pre-commit ao hook existente antes de continuar; ele não foi sobrescrito.`);
  }
  if (!current.stdout.trim()) {
    const location = spawnSync("git", ["-C", root, "rev-parse", "--git-path", "hooks/pre-commit"], { encoding: "utf8" });
    if (location.status !== 0) throw new Error("Não foi possível consultar o hook pre-commit existente.");
    if (existsSync(resolve(root, location.stdout.trim()))) {
      throw new Error("Já existe um pre-commit em .git/hooks. Integre a barreira ao hook existente; ele não foi desativado.");
    }
  }
  const result = spawnSync("git", ["-C", root, "config", "--local", "core.hooksPath", ".githooks"], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Não foi possível ativar o bloqueio de commit.");
  const lock = readFileSync(resolve(root, "package-lock.json"));
  verifyInstalledDependencies(root);
  writeFileSync(resolve(root, "node_modules/.behavetracker-lock.sha256"), createHash("sha256").update(lock).digest("hex") + "\n");
  console.log("Hook pre-commit ativo: checagem rápida dos arquivos preparados. A suíte completa roda antes das builds.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { installHooks(resolve(fileURLToPath(new URL("../..", import.meta.url)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
