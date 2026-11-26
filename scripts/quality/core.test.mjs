import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { attachLocalDependencies, command, git, runChecks, stagedSnapshot, verifyInstalledDependencies } from "./core.mjs";
import { installHooks } from "./install-hooks.mjs";

function repository(run) {
  const root = mkdtempSync(join(tmpdir(), "behavetracker-gate-test-"));
  try { git(root, ["init", "--quiet"]); run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("a failed check prevents every later check from running", () => repository(root => {
  const marker = join(root, "incorrectly-approved");
  assert.throws(() => runChecks([
    { title: "deliberate failure", program: process.execPath, args: ["-e", "process.exit(23)"] },
    { title: "must never execute", program: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'bad')", marker] },
  ]));
  assert.equal(existsSync(marker), false);
}));

test("missing test executables fail closed instead of silently skipping", () => {
  assert.throws(() => command("behavetracker-nonexistent-test-tool", []), /Não foi possível executar/);
});

test("the exported source is the staged code, even with a different unstaged fix", () => repository(root => {
  writeFileSync(join(root, "component.tsx"), "staged broken dialog");
  git(root, ["add", "component.tsx"]);
  const indexBefore = readFileSync(join(root, ".git/index"));
  writeFileSync(join(root, "component.tsx"), "unstaged corrected dialog");
  writeFileSync(join(root, "untracked-test.ts"), "untracked passing test");
  const snapshot = stagedSnapshot(root);
  try {
    assert.equal(readFileSync(join(snapshot, "component.tsx"), "utf8"), "staged broken dialog");
    assert.equal(existsSync(join(snapshot, "untracked-test.ts")), false);
    assert.equal(readFileSync(join(root, "component.tsx"), "utf8"), "unstaged corrected dialog");
    assert.deepEqual(readFileSync(join(root, ".git/index")), indexBefore);
    assert.notEqual(spawnSync("git", ["-C", root, "rev-parse", "HEAD"]).status, 0, "no commit was created");
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}));

test("a staged lock different from installed dependencies cannot be approved", () => repository(root => {
  const staged = join(root, "snapshot");
  mkdirSync(staged);
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(staged, "package-lock.json"), "staged lock");
  writeFileSync(join(root, "node_modules/.behavetracker-lock.sha256"), "different lock hash");
  assert.throws(() => attachLocalDependencies(root, staged), /npm ci/);
  assert.equal(existsSync(join(staged, "node_modules")), false);
}));

test("undeclared installed packages cannot hide a missing locked dependency", () => repository(root => {
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
  writeFileSync(join(root, "node_modules/.package-lock.json"), JSON.stringify({ packages: { "node_modules/undeclared": { version: "1" } } }));
  assert.throws(() => verifyInstalledDependencies(root), /fora do lock/);
}));

test("existing custom hooks are preserved, never overwritten by setup", () => repository(root => {
  const previousCI = process.env.CI;
  delete process.env.CI;
  try {
    git(root, ["config", "core.hooksPath", "custom-hooks"]);
    assert.throws(() => installHooks(root), /não foi sobrescrito/);
    assert.equal(git(root, ["config", "core.hooksPath"]), "custom-hooks");
  } finally { if (previousCI !== undefined) process.env.CI = previousCI; }
}));

test("a default .git/hooks/pre-commit is not silently disabled", () => repository(root => {
  const previousCI = process.env.CI;
  delete process.env.CI;
  try {
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
    assert.throws(() => installHooks(root), /não foi desativado/);
    assert.equal(git(root, ["config", "--local", "--list"]).includes("core.hookspath"), false);
  } finally { if (previousCI !== undefined) process.env.CI = previousCI; }
}));

test("Git invokes the hook, rejects staged broken code despite an unstaged fix, then accepts the staged fix", () => repository(root => {
  mkdirSync(join(root, "scripts/quality"), { recursive: true });
  mkdirSync(join(root, ".githooks"));
  mkdirSync(join(root, "node_modules"));
  for (const name of ["core.mjs", "pre-commit.mjs"]) {
    copyFileSync(new URL(name, import.meta.url), join(root, "scripts/quality", name));
  }
  copyFileSync(new URL("../../.githooks/pre-commit", import.meta.url), join(root, ".githooks/pre-commit"));
  chmodSync(join(root, ".githooks/pre-commit"), 0o755);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  const lock = '{"packages":{}}\n';
  writeFileSync(join(root, "package-lock.json"), lock);
  writeFileSync(join(root, "node_modules/.package-lock.json"), lock);
  writeFileSync(join(root, "node_modules/.behavetracker-lock.sha256"), createHash("sha256").update(lock).digest("hex"));
  // Small deterministic command stands in for a failing application test. This
  // test verifies the real hook/staging boundary, without creating any commit.
  writeFileSync(join(root, "scripts/quality/check.mjs"), "import{readFileSync,mkdirSync,writeFileSync}from'node:fs';const code=readFileSync('component.txt','utf8');mkdirSync('playwright-report');writeFileSync('playwright-report/index.html',code);process.exit(code==='fixed'?0:4)");
  writeFileSync(join(root, "component.txt"), "broken");
  git(root, ["add", "."]);
  git(root, ["config", "core.hooksPath", ".githooks"]);
  writeFileSync(join(root, "component.txt"), "fixed");
  const rejected = spawnSync("git", ["-C", root, "hook", "run", "pre-commit"], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /COMMIT BLOQUEADO/);
  assert.equal(readFileSync(join(root, "playwright-report/index.html"), "utf8"), "broken");
  assert.equal(git(root, ["show", ":component.txt"]), "broken");
  git(root, ["add", "component.txt"]);
  const accepted = spawnSync("git", ["-C", root, "hook", "run", "pre-commit"], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout + accepted.stderr, /Commit liberado/);
  assert.equal(readFileSync(join(root, "playwright-report/index.html"), "utf8"), "fixed");
  assert.notEqual(spawnSync("git", ["-C", root, "rev-parse", "HEAD"]).status, 0);
}));
