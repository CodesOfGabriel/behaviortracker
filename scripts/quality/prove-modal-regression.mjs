// Negative control: restore the original defect in an isolated source copy and
// require the real browser regression to fail specifically for an invisible UI.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { command } from "./core.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(join(root, "package.json"));
const temporary = mkdtempSync(join(tmpdir(), "behavetracker-modal-negative-"));
try {
  for (const name of ["src", "public", "tests", "index.html", "package.json", "package-lock.json", "vite.config.ts", "playwright.config.ts"]) {
    cpSync(join(root, name), join(temporary, name), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const source = join(temporary, "src/features/local/LocalAnalysisPanel.tsx");
  const original = readFileSync(source, "utf8");
  const mutated = original.replace("{createPortal(<dialog", "{(<dialog").replace("</dialog>, document.body)}", "</dialog>)}");
  if (mutated === original || mutated.includes("{createPortal(<dialog")) throw new Error("A mutação não foi aplicada; atualize o controle negativo.");
  writeFileSync(source, mutated);
  const vite = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");
  command(process.execPath, [vite, "build"], { cwd: temporary });
  const result = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--project=chromium",
    "--grep", "confirmation is visible and clickable with execution history collapsed", "--reporter=json"],
  { cwd: temporary, encoding: "utf8", timeout: 120_000, maxBuffer: 5_000_000 });
  if (result.error) throw result.error;
  const report = JSON.parse(result.stdout);
  const failure = report.suites?.flatMap(suite => suite.specs ?? []).flatMap(spec => spec.tests ?? []).flatMap(test => test.results ?? []).flatMap(run => run.errors ?? []);
  if (result.status === 0 || report.stats?.unexpected !== 1 || !failure.some(error => /toBeVisible/.test(error.message) && /hidden/.test(error.message))) {
    throw new Error("Controle negativo falhou por um motivo diferente da janela invisível:\n" + JSON.stringify({ stats: report.stats, errors: report.errors, failure }) + result.stderr);
  }
  mkdirSync(join(root, "test-results"), { recursive: true });
  writeFileSync(join(root, "test-results/modal-negative-control.json"), JSON.stringify({
    restoredBug: "native modal nested inside collapsed execution history",
    expectedFailure: true, unexpectedFailures: report.stats.unexpected,
    errors: failure.map(error => error.message),
  }, null, 2));
  console.log("Controle negativo aprovado: reintroduzir o defeito original faz a regressão reprovar por diálogo invisível.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { rmSync(temporary, { recursive: true, force: true }); }
