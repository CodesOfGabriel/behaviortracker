import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachLocalDependencies, command, stagedSnapshot } from "./core.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
let snapshot;
try {
  snapshot = stagedSnapshot(root);
  if (!existsSync(join(snapshot, "scripts/quality/check.mjs"))) {
    throw new Error("O gate de qualidade não está preparado para commit. Adicione também scripts/quality, .githooks, testes e suas configurações.");
  }
  attachLocalDependencies(root, snapshot);
  console.log("Verificando o conteúdo exato preparado para commit em um diretório temporário.");
  const env = { ...process.env };
  // Git exports these variables when invoking hooks. Child tests must not
  // accidentally operate on the user's repository or alternate index.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.BEHAVETRACKER_TEST_PYTHON ??= join(root, ".venv-test", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  env.CARGO_TARGET_DIR ??= join(root, "src-tauri/target");
  if (!env.PATH?.includes(join(homedir(), ".cargo/bin"))) env.PATH = join(homedir(), ".cargo/bin") + (process.platform === "win32" ? ";" : ":") + (env.PATH ?? "");
  try {
    command(process.execPath, [join(snapshot, "scripts/quality/check.mjs")], { cwd: snapshot, env });
  } finally {
    // Preserve evidence and replace the last report on success as well, so an
    // old failing report cannot masquerade as the current run after cleanup.
    const { cpSync } = await import("node:fs");
    for (const folder of ["test-results", "playwright-report"]) {
      if (existsSync(join(snapshot, folder))) cpSync(join(snapshot, folder), join(root, folder), { recursive: true });
    }
  }
  console.log("Commit liberado: verificações passaram para o conteúdo preparado.");
} catch (error) {
  console.error(`\nCOMMIT BLOQUEADO: ${error.message}\nCorrija o problema, prepare os arquivos e tente novamente. Nenhum commit foi criado.`);
  process.exitCode = 1;
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}
