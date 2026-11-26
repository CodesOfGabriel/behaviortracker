import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTauriEnvironment } from "../tauri.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const idKey = "BEHAVETRACKER_GOOGLE_CLIENT_ID";
const secretKey = "BEHAVETRACKER_GOOGLE_CLIENT_SECRET";
const clientId = "fixture.apps.googleusercontent.com";
const secret = "fixture-local-secret";
const directories = [];
after(() => directories.forEach(directory => rmSync(directory, { recursive: true, force: true })));
const cleanEnvironment = () => {
  const env = { ...process.env };
  delete env[idKey];
  delete env[secretKey];
  delete env.UNRELATED_LOCAL_SETTING;
  return env;
};
function fixture(contents) {
  const directory = mkdtempSync(join(tmpdir(), "behavetracker-tauri-dev-"));
  directories.push(directory);
  if (contents !== undefined) writeFileSync(join(directory, ".env.local"), contents, { mode: 0o600 });
  return directory;
}
const localContents = `${idKey}=${clientId}\n${secretKey}="${secret}"\n`;
const digest = value => createHash("sha256").update(value).digest("hex");

test("development loads the OAuth pair before Tauri starts, without importing unrelated settings", () => {
  const directory = fixture(localContents + "UNRELATED_LOCAL_SETTING=ignored\nNODE_OPTIONS=ignored\n");
  const original = cleanEnvironment();
  const env = prepareTauriEnvironment(["dev"], directory, original);
  assert.equal(env[idKey], clientId);
  assert.equal(env[secretKey], secret);
  assert.equal(env.UNRELATED_LOCAL_SETTING, undefined);
  assert.equal(env.NODE_OPTIONS, original.NODE_OPTIONS);
  assert.equal(original[secretKey], undefined, "loading must not mutate the caller's environment");
});

test("an exported pair takes precedence over .env.local", () => {
  const directory = fixture("invalid local configuration");
  const exported = { ...cleanEnvironment(), [idKey]: clientId, [secretKey]: "exported-secret" };
  assert.equal(prepareTauriEnvironment(["dev"], directory, exported)[secretKey], "exported-secret");
});

test("a local file fills only missing variables", () => {
  const directory = fixture(localContents);
  const env = prepareTauriEnvironment(["dev"], directory, { ...cleanEnvironment(), [idKey]: "exported.apps.googleusercontent.com" });
  assert.equal(env[idKey], "exported.apps.googleusercontent.com");
  assert.equal(env[secretKey], secret);
});

test("an explicitly empty exported secret cannot silently fall back to a local value", () => {
  assert.throws(() => prepareTauriEnvironment(["dev"], fixture(localContents), { ...cleanEnvironment(), [secretKey]: "" }), /BEHAVETRACKER_GOOGLE_CLIENT_SECRET/);
});

test("missing development credentials give setup instructions before launching the app", () => {
  assert.throws(() => prepareTauriEnvironment(["dev"], fixture(), cleanEnvironment()), error => {
    assert.match(error.message, /\.env\.example/);
    assert.match(error.message, /\.env\.local/);
    assert.match(error.message, /não são carregados automaticamente/);
    assert.doesNotMatch(error.message, /Atualize o aplicativo/);
    return true;
  });
});

test("invalid credentials never appear in an error message", () => {
  const directory = fixture(`${idKey}=${clientId}\n${secretKey}=" ${secret} "`);
  assert.throws(() => prepareTauriEnvironment(["dev"], directory, cleanEnvironment()), error => {
    assert.match(error.message, /BEHAVETRACKER_GOOGLE_CLIENT_SECRET/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test("an unreadable environment file gives an actionable error without launching Tauri", () => {
  const directory = fixture();
  mkdirSync(join(directory, ".env.local"));
  assert.throws(() => prepareTauriEnvironment(["dev"], directory, cleanEnvironment()), /formato e as permissões/);
});

test("build and inspection commands never load local development credentials", () => {
  const directory = fixture(localContents);
  for (const args of [["build"], ["info"], ["--help"]]) {
    const env = prepareTauriEnvironment(args, directory, cleanEnvironment());
    assert.equal(env[idKey], undefined);
    assert.equal(env[secretKey], undefined);
  }
});

function cliFixture(contents) {
  const directory = fixture(contents);
  mkdirSync(join(directory, "scripts"));
  for (const file of ["tauri.mjs", "check-google-oauth-env.mjs"]) copyFileSync(join(root, "scripts", file), join(directory, "scripts", file));
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { tauri: scripts.tauri } }));
  const cli = join(directory, "node_modules/@tauri-apps/cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@tauri-apps/cli", type: "module", bin: { tauri: "./tauri.mjs" } }));
  writeFileSync(join(cli, "tauri.mjs"), `
    import {writeFileSync} from "node:fs";
    import {createHash} from "node:crypto";
    writeFileSync("cli-received.json", JSON.stringify({
      args:process.argv.slice(2), clientId:process.env.${idKey},
      secretDigest:createHash("sha256").update(process.env.${secretKey} ?? "").digest("hex"),
      unrelated:process.env.UNRELATED_LOCAL_SETTING,
    }));
    process.exitCode=Number(process.env.TAURI_TEST_EXIT_CODE ?? 0);
  `);
  return directory;
}
const npmCli = process.env.npm_execpath ?? [
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
].find(existsSync);
function npmTauri(directory, args, env = cleanEnvironment()) {
  assert.ok(npmCli, "npm CLI required to verify the actual npm script");
  const result = spawnSync(process.execPath, [npmCli, "run", "tauri", "--", ...args], {
    cwd: directory, env, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}
const received = directory => JSON.parse(readFileSync(join(directory, "cli-received.json"), "utf8"));

test("npm run tauri dev passes local credentials and CLI arguments to the native CLI", () => {
  const directory = cliFixture(localContents + "UNRELATED_LOCAL_SETTING=ignored\n");
  const result = npmTauri(directory, ["dev", "--no-watch"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(received(directory), { args: ["dev", "--no-watch"], clientId, secretDigest: digest(secret) });
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
});

test("npm run tauri dev stops before the native CLI when credentials are missing", () => {
  const directory = cliFixture();
  const result = npmTauri(directory, ["dev"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env\.local/);
  assert.ok(!existsSync(join(directory, "cli-received.json")));
});

test("npm run tauri build keeps the CI secret and ignores a conflicting local file", () => {
  const directory = cliFixture(localContents);
  const env = { ...cleanEnvironment(), [idKey]: "ci.apps.googleusercontent.com", [secretKey]: "fixture-ci-secret" };
  const result = npmTauri(directory, ["build", "--ci"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(received(directory), { args: ["build", "--ci"], clientId: env[idKey], secretDigest: digest(env[secretKey]) });
});

test("the npm wrapper preserves a failing native CLI exit code", () => {
  const result = npmTauri(cliFixture(localContents), ["dev"], { ...cleanEnvironment(), TAURI_TEST_EXIT_CODE: "42" });
  assert.equal(result.status, 42);
});

test("Git ignores local secrets while allowing the empty example to be versioned", () => {
  const directory = fixture();
  copyFileSync(join(root, ".gitignore"), join(directory, ".gitignore"));
  const git = args => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);
  assert.equal(git(["check-ignore", "--quiet", ".env.local"]).status, 0);
  assert.equal(git(["check-ignore", "--quiet", ".env.deploy.local"]).status, 0);
  assert.equal(git(["check-ignore", "--quiet", ".github/behaviortracker-known-hosts"]).status, 0);
  assert.equal(git(["check-ignore", "--quiet", ".env.example"]).status, 1);
});
