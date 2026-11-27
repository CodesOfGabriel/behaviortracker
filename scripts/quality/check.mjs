import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { command, prependPath, runChecks } from "./core.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const frontendOnly = process.argv.slice(2).join(" ") === "--frontend";
if (process.argv.length > 2 && !frontendOnly) throw new Error("Opção desconhecida. Use sem argumentos ou --frontend.");
const require = createRequire(join(root, "package.json"));
const cli = (name, executable = name) => {
  const manifest = require.resolve(`${name}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  return resolve(dirname(manifest), typeof bin === "string" ? bin : bin[executable]);
};
const nodeStep = (title, script, ...args) => ({ title, program: process.execPath, args: [script, ...args] });
const tools = mkdtempSync(join(tmpdir(), "behavetracker-test-tools-"));
let env = { ...process.env };
try {
  const steps = [
    nodeStep("Testes da própria barreira de commit e dos workflows", "--test", "scripts/quality/core.test.mjs", "scripts/quality/workflows.test.mjs", "scripts/quality/tauri-dev.test.mjs"),
    nodeStep("Testes unitários e de componentes", cli("vitest"), "run"),
    nodeStep("TypeScript da aplicação", cli("typescript", "tsc"), "-b"),
    nodeStep("TypeScript dos testes de interface", cli("typescript", "tsc"), "-p", "tsconfig.tests.json"),
    nodeStep("Build de produção", cli("vite"), "build"),
    nodeStep("Regressão de usabilidade nos navegadores da plataforma", require.resolve("@playwright/test/cli"), "test"),
  ];
  if (!frontendOnly) {
    const python = env.BEHAVETRACKER_TEST_PYTHON ?? join(root, ".venv-test", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!existsSync(python)) throw new Error("Ambiente Python de testes ausente. Execute npm run test:setup.");
    command(python, ["-c", "import cv2,numpy,scipy,pandas,onnx,onnxruntime,sklearn"], { cwd: root, env });
    command(process.execPath, ["scripts/prepare-video-tools.mjs"], { cwd: root, env });
    const target = { "darwin:x64": "x86_64-apple-darwin", "darwin:arm64": "aarch64-apple-darwin", "linux:x64": "x86_64-unknown-linux-gnu", "win32:x64": "x86_64-pc-windows-msvc" }[`${process.platform}:${process.arch}`];
    for (const name of ["ffmpeg", "ffprobe"]) {
      const suffix = process.platform === "win32" ? ".exe" : "";
      const binary = join(root, "src-tauri/binaries", `behavetracker-${name}-${target}${suffix}`);
      if (!existsSync(binary)) throw new Error(`${name} necessário para executar os testes de vídeo.`);
      if (process.platform === "win32") copyFileSync(binary, join(tools, name + suffix));
      else symlinkSync(binary, join(tools, name + suffix));
    }
    env = prependPath(env, [tools, join(homedir(), ".cargo/bin")]);
    steps.push(
      nodeStep("Credenciais Google obrigatórias no instalador", "--test", "scripts/quality/google-oauth-build.test.mjs"),
      nodeStep("Integridade do registro de modelos", "scripts/check-release-models.mjs"),
      { title: "Regressões Python dos três protocolos", program: python, args: ["scripts/quality/python-tests.py"] },
      { title: "Scripts de preparação e validação", program: python, args: ["-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py"] },
      { title: "Backend Rust e migrações SQLite", program: env.BEHAVETRACKER_CARGO ?? "cargo", args: ["test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib"] },
    );
  }
  runChecks(steps, { cwd: root, env });
  console.log("\nQualidade aprovada. Todos os checks exigidos foram executados.");
} catch (error) {
  console.error(`\nQualidade reprovada: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(tools, { recursive: true, force: true });
}
