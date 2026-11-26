import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "behavetracker-google-build-"));
const executable = name => join(temporary, name + (process.platform === "win32" ? ".exe" : ""));
const localRust = join(homedir(), ".cargo/bin", process.platform === "win32" ? "rustc.exe" : "rustc");
const rustc = process.env.BEHAVETRACKER_RUSTC ?? (existsSync(localRust) ? localRust : "rustc");
const clientId = "fixture-desktop.apps.googleusercontent.com";
const clientSecret = "fixture-google-client-secret";
// Always replace the real environment with synthetic credentials, including
// when these tests run in a job that has access to repository secrets.
const environment = (id = clientId, secret = clientSecret, profile = "release") => {
  const env = { ...process.env, PROFILE: profile };
  delete env.BEHAVETRACKER_GOOGLE_CLIENT_ID;
  delete env.BEHAVETRACKER_GOOGLE_CLIENT_SECRET;
  if (id !== null) env.BEHAVETRACKER_GOOGLE_CLIENT_ID = id;
  if (secret !== null) env.BEHAVETRACKER_GOOGLE_CLIENT_SECRET = secret;
  return env;
};
const run = (program, args, env = environment(null, null)) => {
  const result = spawnSync(program, args, { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  return result;
};
const compile = (args, env) => {
  const result = run(rustc, ["--edition=2021", ...args], env);
  assert.equal(result.status, 0, result.stderr);
};

before(() => {
  // Run the actual build.rs. Only Tauri's unrelated platform packaging helper
  // is replaced so that the release credential guard can run without a GUI SDK.
  writeFileSync(join(temporary, "tauri_stub.rs"), 'pub fn build() { println!("tauri-packaging-started"); }');
  const stub = join(temporary, "libtauri_build.rlib");
  compile(["--crate-name", "tauri_build", "--crate-type=rlib", join(temporary, "tauri_stub.rs"), "-o", stub]);
  compile([resolve(root, "src-tauri/build.rs"), "--extern", `tauri_build=${stub}`, "-o", executable("build-script")]);
});
after(() => rmSync(temporary, { recursive: true, force: true }));

const invalid = [
  ["missing secret", clientId, null, "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"],
  ["empty secret", clientId, "", "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"],
  ["blank secret", clientId, "   ", "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"],
  ["padded secret", clientId, ` ${clientSecret} `, "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"],
  ["multiline secret", clientId, `${clientSecret}\ninjected`, "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"],
  ["CR secret", clientId, `${clientSecret}\rinjected`, "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"],
  ["oversized secret", clientId, "s".repeat(2049), "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"],
  ["missing ID", null, clientSecret, "BEHAVETRACKER_GOOGLE_CLIENT_ID"],
  ["invalid ID", "invalid.example.test", clientSecret, "BEHAVETRACKER_GOOGLE_CLIENT_ID"],
  ["empty ID prefix", ".apps.googleusercontent.com", clientSecret, "BEHAVETRACKER_GOOGLE_CLIENT_ID"],
  ["spaced ID", "invalid id.apps.googleusercontent.com", clientSecret, "BEHAVETRACKER_GOOGLE_CLIENT_ID"],
  ["oversized ID", "i".repeat(513) + ".apps.googleusercontent.com", clientSecret, "BEHAVETRACKER_GOOGLE_CLIENT_ID"],
];
for (const [name, id, secret, variable] of invalid) {
  test(`CI preflight and release build reject ${name} before packaging`, () => {
    const env = environment(id, secret);
    for (const result of [run(process.execPath, ["scripts/check-google-oauth-env.mjs"], env), run(executable("build-script"), [], env)]) {
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(variable));
      assert.ok(!result.stdout.includes("tauri-packaging-started"));
      assert.ok(!result.stderr.includes(clientSecret), "error must not disclose the credential");
    }
  });
}

test("the release build embeds the environment pair consumed by the actual OAuth module", () => {
  const preflight = run(process.execPath, ["scripts/check-google-oauth-env.mjs"], environment());
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.ok(!preflight.stdout.includes(clientSecret));
  const result = run(executable("build-script"), [], environment());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("tauri-packaging-started"));
  const env = environment(null, null);
  for (const key of ["BEHAVETRACKER_GOOGLE_CLIENT_ID", "BEHAVETRACKER_GOOGLE_CLIENT_SECRET"]) {
    assert.ok(result.stdout.includes(`cargo:rerun-if-env-changed=${key}`));
    const directive = result.stdout.split(/\r?\n/u).find(line => line.startsWith(`cargo:rustc-env=${key}=`));
    assert.ok(directive, `${key} not forwarded to the compiler`);
    env[key] = directive.slice(`cargo:rustc-env=${key}=`.length);
  }
  writeFileSync(join(temporary, "probe.rs"), `
    #[path = ${JSON.stringify(resolve(root, "src-tauri/google_client.rs"))}]
    mod google_client;
    fn main() {
      let credentials = google_client::credentials_from_build().expect("compiled credentials required");
      assert_eq!(credentials, (${JSON.stringify(clientId)}, ${JSON.stringify(clientSecret)}));
      assert_eq!(google_client::secret_for_client(credentials.0, Some(credentials)), Some(credentials.1));
      assert_eq!(google_client::secret_for_client("other.apps.googleusercontent.com", Some(credentials)), None);
    }
  `);
  compile([join(temporary, "probe.rs"), "-o", executable("credential-probe")], env);
  // End users need no environment variables. A local environment override must
  // also be unable to replace the client compiled by GitHub Actions.
  for (const runtime of [environment(null, null), environment("other.apps.googleusercontent.com", "runtime-override")]) {
    const probe = run(executable("credential-probe"), [], runtime);
    assert.equal(probe.status, 0, probe.stderr);
  }
});

test("a debug build without secrets is permitted only for development", () => {
  const result = run(executable("build-script"), [], environment(null, null, "debug"));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("cargo:rustc-env=BEHAVETRACKER_GOOGLE_CLIENT_SECRET="));
  const partial = run(executable("build-script"), [], environment(clientId, null, "debug"));
  assert.notEqual(partial.status, 0, "partial development credentials must also be rejected");
});
