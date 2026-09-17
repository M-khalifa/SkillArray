#!/usr/bin/env node
// One canonical release-readiness command: green package suites don't imply a green
// repository (validate-repository.mjs can fail on shared-file drift while both packages'
// tests pass independently) -- this runs every check that must pass, in order, and stops
// at the first failure instead of reporting several separately-green commands.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

const steps = [
  { label: "repository parity validation", cwd: root, cmd: node, args: ["scripts/validate-repository.mjs"] },
  {
    label: "pair-review package validation",
    cwd: path.join(root, "plugins/reviews/skills/pair-review"),
    cmd: node,
    args: ["scripts/validate-package.mjs"],
  },
  {
    // Same default-parallel mode CI already uses (.github/workflows/test.yml
    // runs `node --test` with no concurrency flag). If a real flake surfaces,
    // isolate that specific failing file with its own --test-concurrency=1
    // step rather than reintroducing blanket serialization here -- see
    // CHANGELOG's Known limitations for the rationale.
    label: "pair-review test suite",
    cwd: path.join(root, "plugins/reviews/skills/pair-review"),
    cmd: node,
    args: ["--test"],
  },
  {
    label: "cross-review package validation",
    cwd: path.join(root, "plugins/reviews/skills/cross-review"),
    cmd: node,
    args: ["scripts/validate-package.mjs"],
  },
  {
    // See the pair-review test suite step above for why this runs parallel now.
    label: "cross-review test suite",
    cwd: path.join(root, "plugins/reviews/skills/cross-review"),
    cmd: node,
    args: ["--test"],
  },
  {
    // Explicit file path only -- never a bench/ glob and never live-smoke.mjs,
    // which is opt-in-only (SKILLARRAY_LIVE_SMOKE=1) and must never run as
    // part of the normal release gate or CI.
    label: "benchmark scorer test suite",
    cwd: root,
    cmd: node,
    args: ["--test", "bench/tests/score.test.mjs"],
  },
  {
    // Provider-independent orchestration tests only, exercised against
    // bench/adapters/fake.mjs -- zero live provider calls, zero cost. The
    // live adapter has its own opt-in gate (SKILLARRAY_LIVE_SMOKE=1),
    // enforced inside run-comparison.mjs itself, never exercised here.
    label: "benchmark runner test suite",
    cwd: root,
    cmd: node,
    args: [
      "--test",
      "bench/tests/run-comparison.test.mjs",
      "bench/tests/union.test.mjs",
      "bench/tests/live-adapter.test.mjs",
    ],
  },
  {
    label: "shared-brain scan_memory.py compiles",
    cwd: root,
    cmd: "python",
    args: ["-m", "py_compile", "plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py"],
  },
  {
    label: "shared-brain default profile validates",
    cwd: root,
    cmd: "python",
    args: [
      "plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py",
      "--check-profile",
      "plugins/shared-brain/skills/shared-brain/profiles/default.yml",
    ],
  },
  {
    label: "shared-brain vsi-engineering profile validates",
    cwd: root,
    cmd: "python",
    args: [
      "plugins/shared-brain/skills/shared-brain/scripts/scan_memory.py",
      "--check-profile",
      "plugins/shared-brain/skills/shared-brain/profiles/vsi-engineering.yml",
    ],
  },
];

function runStep(step) {
  process.stdout.write(`\n==> ${step.label}\n`);
  const result = spawnSync(step.cmd, step.args, { cwd: step.cwd, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`release-check: failed to start "${step.label}": ${result.error.message}\n`);
    return false;
  }
  return result.status === 0;
}

// Green package suites only prove the working tree; a tag must be reproducible from a
// committed HEAD. --release checks that first so a dirty tree can't be certified.
function checkCleanTree() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (result.error) {
    process.stderr.write(`release-check: failed to run "git status": ${result.error.message}\n`);
    return false;
  }
  if (result.status !== 0) {
    process.stderr.write("release-check: \"git status\" itself failed -- not a git repository?\n");
    return false;
  }
  if (result.stdout.trim().length > 0) {
    process.stderr.write(
      "release-check: --release refuses a dirty working tree (uncommitted or untracked changes):\n\n" +
        result.stdout +
        '\ncommit or stash everything, then re-run "node scripts/release-check.mjs --release".\n'
    );
    return false;
  }
  return true;
}

// Merge-conflict markers left in a committed file are a distinct class of
// mistake from a syntax error -- a file can be perfectly valid JS/Markdown
// while still containing an unresolved <<<<<<< block if the conflict was in
// a comment or a fenced code example. "=======" alone is NOT flagged: it is
// legitimate Markdown (a setext heading underline) and appears throughout
// this repository's own docs.
function checkNoConflictMarkers() {
  const result = spawnSync("git", ["grep", "-n", "-E", "^(<<<<<<<|>>>>>>>) "], {
    cwd: root,
    encoding: "utf8",
  });
  // git grep exits 1 when it finds nothing -- that is the success case here.
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(`release-check: failed to run "git grep" for conflict markers: ${result.stderr}\n`);
    return false;
  }
  if (result.status === 0) {
    process.stderr.write(
      "release-check: unresolved merge-conflict markers found:\n\n" + result.stdout + "\n"
    );
    return false;
  }
  return true;
}

// Catches trailing whitespace and mixed tab/space indentation in what would
// actually be committed. On a clean tree (nothing staged, nothing modified)
// there is no diff to check, so this is a harmless no-op there -- its real
// job is catching whitespace issues in Stage-2-in-progress changes before
// they're committed, not re-litigating an already-committed HEAD.
function checkDiffWhitespace() {
  // git diff --check exits 0 (clean) or 2 (whitespace errors found); any other
  // status (e.g. 128, not a git repo) is this check failing to run at all.
  for (const diffArgs of [["diff", "--check"], ["diff", "--cached", "--check"]]) {
    const result = spawnSync("git", diffArgs, { cwd: root, encoding: "utf8" });
    if (result.status !== 0 && result.status !== 2) {
      process.stderr.write(`release-check: failed to run "git ${diffArgs.join(" ")}": ${result.stderr}\n`);
      return false;
    }
    if (result.status === 2) {
      process.stderr.write(`release-check: whitespace errors from "git ${diffArgs.join(" ")}":\n\n${result.stdout}\n`);
      return false;
    }
  }
  return true;
}

// Copies each review skill's package directory to an isolated temp directory
// and re-runs its own validator + test suite there. This catches a class of
// bug the in-place suites can't: a package that only works because it
// happens to sit inside the monorepo (a relative path that escapes the
// package root, an implicit dependency on a sibling file outside the
// package's own directory) -- exactly what a real /plugin install would
// expose, since that copies the package alone, not the whole repository.
function checkPackagedArtifact(skillDir, label) {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "skillarray-package-smoke-"));
  try {
    const dest = path.join(tmpRoot, path.basename(skillDir));
    cpSync(skillDir, dest, { recursive: true });
    process.stdout.write(`\n==> ${label} packaged-artifact smoke test (isolated copy at ${dest})\n`);
    const validate = spawnSync(node, ["scripts/validate-package.mjs"], { cwd: dest, stdio: "inherit" });
    if (validate.error || validate.status !== 0) {
      process.stderr.write(`release-check: packaged-artifact validation failed for ${label}\n`);
      return false;
    }
    const test = spawnSync(node, ["--test"], { cwd: dest, stdio: "inherit" });
    if (test.error || test.status !== 0) {
      process.stderr.write(`release-check: packaged-artifact test suite failed for ${label}\n`);
      return false;
    }
    return true;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function main() {
  const release = process.argv.includes("--release");
  if (release && !checkCleanTree()) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n==> merge-conflict marker scan\n`);
  if (!checkNoConflictMarkers()) {
    process.stderr.write(`\nrelease-check: FAILED at "merge-conflict marker scan" -- fix this before releasing.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n==> whitespace check (git diff --check)\n`);
  if (!checkDiffWhitespace()) {
    process.stderr.write(`\nrelease-check: FAILED at "whitespace check" -- fix this before releasing.\n`);
    process.exitCode = 1;
    return;
  }
  for (const step of steps) {
    if (!runStep(step)) {
      process.stderr.write(`\nrelease-check: FAILED at "${step.label}" -- fix this before releasing.\n`);
      process.exitCode = 1;
      return;
    }
  }
  if (release) {
    // Packaged-artifact smoke tests double each package's test-suite runtime
    // (once in-place above, once from an isolated copy here), so they run
    // only for an actual release certification, not every plain
    // release-check invocation during development.
    for (const [skillDir, label] of [
      [path.join(root, "plugins/reviews/skills/pair-review"), "pair-review"],
      [path.join(root, "plugins/reviews/skills/cross-review"), "cross-review"],
    ]) {
      if (!checkPackagedArtifact(skillDir, label)) {
        process.stderr.write(`\nrelease-check: FAILED at "${label} packaged-artifact smoke test" -- fix this before releasing.\n`);
        process.exitCode = 1;
        return;
      }
    }
  }
  process.stdout.write("\nrelease-check: all steps passed.\n");
}

main();
