import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { validateGoogleOAuthEnvironment } from "./check-google-oauth-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const keys = ["BEHAVETRACKER_GOOGLE_CLIENT_ID", "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"];

export function prepareTauriEnvironment(args, directory = root, environment = process.env) {
  const env = { ...environment };
  // Release builds get credentials exclusively from the CI environment.
  if (args[0] !== "dev") return env;
  if (keys.some(key => env[key] === undefined)) {
    let local = {};
    try {
      local = parseEnv(readFileSync(join(directory, ".env.local"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Não foi possível ler .env.local. Confira o formato e as permissões do arquivo.");
    }
    // Do not import arbitrary environment settings such as NODE_OPTIONS.
    for (const key of keys) if (env[key] === undefined && local[key] !== undefined) env[key] = local[key];
  }
  try {
    validateGoogleOAuthEnvironment(env);
  } catch (error) {
    throw new Error(`${error.message}\nO tauri dev precisa do mesmo par OAuth usado no build do GitHub.\nCopie .env.example para .env.local e preencha BEHAVETRACKER_GOOGLE_CLIENT_SECRET, ou exporte as duas variáveis no terminal.\nSecrets do GitHub Actions não são carregados automaticamente no computador local. Não cole o segredo no chat nem o inclua no Git.`);
  }
  return env;
}

export function runTauri(args) {
  const env = prepareTauriEnvironment(args);
  const require = createRequire(join(root, "package.json"));
  const manifest = require.resolve("@tauri-apps/cli/package.json");
  const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
  const cli = resolve(dirname(manifest), typeof bin === "string" ? bin : bin.tauri);
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: "inherit", shell: false });
  const signals = ["SIGINT", "SIGTERM"];
  const forward = signal => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on(signals[0], interrupt);
  process.on(signals[1], terminate);
  const cleanup = () => {
    process.off(signals[0], interrupt);
    process.off(signals[1], terminate);
  };
  child.once("error", () => {
    cleanup();
    console.error("Não foi possível executar o Tauri. Confira a instalação das dependências.");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runTauri(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
