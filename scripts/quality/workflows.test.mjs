import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parseEnv } from "node:util";
import { parse } from "yaml";

const directory = new URL("../../.github/workflows/", import.meta.url);
const read = name => parse(readFileSync(new URL(name, directory), "utf8"));

test("every workflow is valid YAML with triggers and jobs", () => {
  for (const name of readdirSync(directory).filter(name => name.endsWith(".yml"))) {
    const workflow = read(name);
    assert.ok(workflow.on && typeof workflow.on === "object", `${name}: triggers absent`);
    assert.ok(workflow.jobs && typeof workflow.jobs === "object", `${name}: jobs absent`);
  }
});

for (const [file, job] of [["build-installers.yml", "build"], ["deploy-web.yml", "deploy"]]) {
  test(`${job} cannot execute without the reusable quality workflow`, () => {
    const { jobs } = read(file);
    const needs = [jobs[job].needs].flat();
    assert.ok(needs.includes("quality"), `${file}: ${job} can bypass quality`);
    assert.equal(jobs.quality.uses, "./.github/workflows/quality.yml");
    assert.equal(jobs.quality["continue-on-error"], undefined);
    assert.equal(jobs[job].if, undefined, "distribution cannot override needs with always()");
  });
}

test("quality checks run the full gate on every supported desktop OS", () => {
  const { on, jobs } = read("quality.yml");
  assert.ok("pull_request" in on && "push" in on && "workflow_call" in on);
  assert.deepEqual(new Set(jobs.quality.strategy.matrix.os), new Set(["ubuntu-22.04", "macos-15-intel", "windows-latest"]));
  const verify = jobs.quality.steps.find(step => step.run === "npm run verify");
  assert.ok(verify, "full gate missing from CI");
  assert.equal(verify["continue-on-error"], undefined);
  assert.equal(jobs.quality["continue-on-error"], undefined);
  assert.equal(verify.env.BEHAVETRACKER_GOOGLE_CLIENT_ID, "fixture-desktop.apps.googleusercontent.com");
  assert.equal(verify.env.BEHAVETRACKER_GOOGLE_CLIENT_SECRET, "fixture-google-client-secret");
});

test("every installer inherits the repository Google secret and validates it before building", () => {
  const { jobs } = read("build-installers.yml");
  const job = jobs.build;
  assert.equal(job.env.BEHAVETRACKER_GOOGLE_CLIENT_SECRET, "${{ secrets.BEHAVETRACKER_GOOGLE_CLIENT_SECRET }}");
  assert.match(job.env.BEHAVETRACKER_GOOGLE_CLIENT_ID, /\S+\.apps\.googleusercontent\.com$/);
  assert.equal(job["continue-on-error"], undefined);
  const preflight = job.steps.findIndex(step => step.run === "node scripts/check-google-oauth-env.mjs");
  const build = job.steps.findIndex(step => step.run?.includes("tauri -- build"));
  assert.ok(preflight >= 0 && preflight < build, "credentials must be checked before any installer is built");
  assert.equal(job.steps[preflight].if, undefined);
  assert.equal(job.steps[preflight]["continue-on-error"], undefined);
  for (const step of job.steps) {
    assert.equal(step.env?.BEHAVETRACKER_GOOGLE_CLIENT_SECRET, undefined, "step cannot override the repository secret");
    assert.equal(step.env?.BEHAVETRACKER_GOOGLE_CLIENT_ID, undefined);
    assert.doesNotMatch(step.run ?? "", /(?:BEHAVETRACKER_GOOGLE_CLIENT_SECRET|BEHAVETRACKER_GOOGLE_CLIENT_ID)\s*=/);
  }
});

test("the required gate executes the Google build contract, and publication only accepts installer builds", () => {
  const gate = readFileSync(new URL("check.mjs", import.meta.url), "utf8");
  assert.ok(gate.includes('"scripts/quality/google-oauth-build.test.mjs"'));
  const release = read("publish-desktop-release.yml");
  const source = release.jobs.release.steps.find(step => step.id === "source");
  assert.ok(source.run.includes('.path == ".github/workflows/build-installers.yml"'));
  assert.ok(source.run.includes('.conclusion == "success"'));
});

test("deployment gets the server address and public host key from repository secrets", () => {
  const job = read("deploy-web.yml").jobs.deploy;
  assert.equal(job.env.DEPLOY_HOST, "${{ secrets.VPS_DEPLOY_HOST }}");
  const configure = job.steps.find(step => step.name === "Configure SSH");
  assert.equal(configure.env.VPS_DEPLOY_SSH_KEY, "${{ secrets.VPS_DEPLOY_SSH_KEY }}");
  assert.equal(configure.env.VPS_DEPLOY_KNOWN_HOSTS, "${{ secrets.VPS_DEPLOY_KNOWN_HOSTS }}");
  assert.equal(configure.if, undefined);
  assert.equal(configure["continue-on-error"], undefined);
  for (const variable of ["DEPLOY_HOST", "VPS_DEPLOY_KNOWN_HOSTS", "VPS_DEPLOY_SSH_KEY"]) {
    assert.ok(configure.run.includes(`test -n "$${variable}"`), `${variable} must be required`);
  }
  assert.ok(configure.run.includes('ssh-keygen -F "$DEPLOY_HOST" -f "$HOME/.ssh/known_hosts"'));
});

test("deploy commands retain strict server identity checks without discovering keys at connection time", () => {
  for (const step of read("deploy-web.yml").jobs.deploy.steps) {
    assert.doesNotMatch(step.run ?? "", /ssh-keyscan|StrictHostKeyChecking=(?:no|accept-new)/);
    for (const command of (step.run ?? "").split("\n").filter(line => /^\s*(?:ssh |rsync )/.test(line))) {
      assert.ok(command.includes("StrictHostKeyChecking=yes"), "SSH and rsync must reject unknown or changed server keys");
    }
  }
});

test("the versioned server metadata file stays removed and excluded from Git", () => {
  assert.equal(existsSync(new URL("behaviortracker-known-hosts", directory)), false);
  const ignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.ok(ignore.split(/\r?\n/).includes(".github/behaviortracker-known-hosts"));
});

test("the OAuth example has no secret and uses the same public client ID as installer builds", () => {
  const example = parseEnv(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"));
  assert.equal(example.BEHAVETRACKER_GOOGLE_CLIENT_SECRET, "");
  assert.equal(example.BEHAVETRACKER_GOOGLE_CLIENT_ID, read("build-installers.yml").jobs.build.env.BEHAVETRACKER_GOOGLE_CLIENT_ID);
});
