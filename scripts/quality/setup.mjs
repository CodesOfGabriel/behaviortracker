import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { command } from "./core.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(join(root, "package.json"));
const python = join(root, ".venv-test", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
try {
  if (!existsSync(python)) command(process.env.BEHAVETRACKER_SYSTEM_PYTHON ?? (process.platform === "win32" ? "python" : "python3"), ["-m", "venv", join(root, ".venv-test")], { cwd: root });
  command(python, ["-m", "pip", "install", "--only-binary=:all:", "-r", "scripts/quality/requirements.txt"], { cwd: root });
  command(process.execPath, [require.resolve("@playwright/test/cli"), "install", "chromium", "webkit"], { cwd: root });
  console.log("Ambiente de testes preparado. Execute npm run verify.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
