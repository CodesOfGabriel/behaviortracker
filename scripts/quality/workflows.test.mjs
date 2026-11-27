import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
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

test("quality is only called by builds, never triggered by commits or pull requests", () => {
  assert.deepEqual(Object.keys(read("quality.yml").on), ["workflow_call"]);
  for (const file of ["build-installers.yml", "deploy-web.yml", "publish-desktop-release.yml"]) {
    assert.deepEqual(Object.keys(read(file).on), ["workflow_dispatch"], `${file}: distribution must be explicitly requested`);
  }
});

test("quality checks run the full gate on every supported desktop OS unless an installer build is verified", () => {
  const { on, jobs } = read("quality.yml");
  assert.equal(on.workflow_call.inputs.source_run_id.default, "");
  assert.equal(jobs.quality.if, "inputs.source_run_id == ''");
  assert.equal(jobs.reuse.if, "inputs.source_run_id != ''");
  assert.equal(jobs.reuse["continue-on-error"], undefined);
  assert.deepEqual(new Set(jobs.quality.strategy.matrix.os), new Set(["ubuntu-22.04", "macos-15-intel", "windows-latest"]));
  const verify = jobs.quality.steps.find(step => step.run === "npm run verify");
  assert.ok(verify, "full gate missing from CI");
  assert.equal(verify["continue-on-error"], undefined);
  assert.equal(jobs.quality["continue-on-error"], undefined);
  assert.equal(verify.env.BEHAVETRACKER_GOOGLE_CLIENT_ID, "fixture-desktop.apps.googleusercontent.com");
  assert.equal(verify.env.BEHAVETRACKER_GOOGLE_CLIENT_SECRET, "fixture-google-client-secret");
});

test("website can reuse installer quality and does not repeat the unit suite", () => {
  const web = read("deploy-web.yml");
  assert.equal(web.on.workflow_dispatch.inputs.source_run_id.default, "");
  assert.equal(web.jobs.quality.with.source_run_id, "${{ inputs.source_run_id }}");
  assert.equal(read("build-installers.yml").jobs.quality.with?.source_run_id, undefined, "installer builds always run quality");
  for (const step of web.jobs.deploy.steps) {
    assert.doesNotMatch(step.run ?? "", /npm (?:test|run (?:test|verify))/);
  }
  assert.ok(web.jobs.deploy.steps.some(step => step.run === "npm run build"));
  for (const file of ["quality.yml", "build-installers.yml", "deploy-web.yml"]) {
    assert.equal(read(file).permissions.actions, "read", `${file}: run verification requires Actions read access`);
  }
});

test("reusing quality rejects failed builds, different commits and incomplete OS coverage", {
  skip: spawnSync("jq", ["--version"]).status !== 0 ? "jq is required only on the Linux distribution runners" : false,
}, () => {
  const script = read("quality.yml").jobs.reuse.steps[0].run;
  assert.ok(script.includes('[[ "$SOURCE_RUN_ID" =~ ^[0-9]+$ ]]'));
  assert.ok(script.includes('gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID"'));
  assert.ok(script.includes('--paginate --slurp'));
  const runQuery = script.match(/jq -e --arg sha "\$GITHUB_SHA" '([\s\S]*?)' source-run\.json/)[1];
  const jobsQuery = script.match(/jq -e '([\s\S]*?)' source-jobs\.json/)[1];
  const sha = "a".repeat(40);
  const run = { status: "completed", conclusion: "success", event: "workflow_dispatch", head_branch: "main", head_sha: sha, path: ".github/workflows/build-installers.yml" };
  const acceptsRun = value => spawnSync("jq", ["-e", "--arg", "sha", sha, runQuery], { input: JSON.stringify(value), encoding: "utf8" }).status === 0;
  assert.equal(acceptsRun(run), true);
  for (const [field, value] of Object.entries({ status: "in_progress", conclusion: "failure", event: "pull_request", head_branch: "feature", head_sha: "b".repeat(40), path: ".github/workflows/deploy-web.yml" })) {
    assert.equal(acceptsRun({ ...run, [field]: value }), false, `must reject ${field}=${value}`);
  }
  const jobs = ["ubuntu-22.04", "macos-15-intel", "windows-latest"].map(os => ({ name: `quality / Quality (${os})`, status: "completed", conclusion: "success" }));
  const acceptsJobs = pages => spawnSync("jq", ["-e", jobsQuery], { input: JSON.stringify(pages), encoding: "utf8" }).status === 0;
  assert.equal(acceptsJobs([{ jobs: jobs.slice(0, 1) }, { jobs: jobs.slice(1) }]), true, "all API pages count");
  assert.equal(acceptsJobs([{ jobs: [] }]), false);
  for (let i = 0; i < jobs.length; i++) {
    assert.equal(acceptsJobs([{ jobs: jobs.filter((_, j) => i !== j) }]), false, "missing OS must block reuse");
    for (const conclusion of ["failure", "skipped", "cancelled"]) {
      assert.equal(acceptsJobs([{ jobs: jobs.map((job, j) => i === j ? { ...job, conclusion } : job) }]), false, `${conclusion} must block reuse`);
    }
  }
});

test("the actual reuse step explains incompatible inputs and only approves a verified build", {
  skip: ["jq", "bash"].some(tool => spawnSync(tool, ["--version"]).status !== 0) ? "requires the Linux reuse job's jq and bash tools" : false,
}, () => {
  const sha = "a".repeat(40);
  const sourceSha = "b".repeat(40);
  const build = { name: "Build desktop installers", status: "completed", conclusion: "success", event: "workflow_dispatch", head_branch: "main", head_sha: sha, path: ".github/workflows/build-installers.yml" };
  const jobs = ["ubuntu-22.04", "macos-15-intel", "windows-latest"].map(os => ({ name: `quality / Quality (${os})`, status: "completed", conclusion: "success" }));
  const script = read("quality.yml").jobs.reuse.steps[0].run;
  const execute = (run, entries = jobs, id = "123") => {
    const root = mkdtempSync(join(tmpdir(), "behavetracker-reuse-test-"));
    try {
      // Stub only the GitHub API; execute the workflow's Bash and jq unchanged.
      const result = spawnSync("bash", ["-c", `
        gh() {
          printf '%s\\n' "$*" >> api-calls.txt
          case "$*" in
            *'/jobs?'*) printf '%s\\n' "$FIXTURE_JOBS" ;;
            *) printf '%s\\n' "$FIXTURE_RUN" ;;
          esac
        }
        ${script}
      `], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, SOURCE_RUN_ID: id, GITHUB_REPOSITORY: "fixture/project", GITHUB_SHA: sha, GITHUB_STEP_SUMMARY: join(root, "summary.txt"), FIXTURE_RUN: JSON.stringify(run), FIXTURE_JOBS: JSON.stringify([{ jobs: entries }]) },
      });
      return { ...result, calls: existsSync(join(root, "api-calls.txt")) ? readFileSync(join(root, "api-calls.txt"), "utf8") : "", approved: existsSync(join(root, "summary.txt")) };
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const incompatible = execute({ ...build, name: "Required quality checks", path: ".github/workflows/quality.yml", event: "push", head_sha: sourceSha });
  assert.equal(incompatible.status, 1, incompatible.stderr);
  for (const detail of ["::error::", "Required quality checks", "Build desktop installers", sourceSha, sha, "source_run_id vazio", "Reexecutar este job mantém o ID incompatível"]) {
    assert.ok(incompatible.stdout.includes(detail), `missing diagnostic: ${detail}`);
  }
  assert.doesNotMatch(incompatible.calls, /\/jobs\?/);
  assert.equal(incompatible.approved, false);

  const invalid = execute(build, jobs, "not-a-run-id");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /::error::source_run_id/);
  assert.equal(invalid.calls, "");

  const incomplete = execute(build, jobs.slice(0, 2));
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.match(incomplete.stdout, /::error::.*três sistemas/);
  assert.equal(incomplete.approved, false);

  const approved = execute(build);
  assert.equal(approved.status, 0, approved.stderr);
  assert.equal(approved.approved, true);
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
