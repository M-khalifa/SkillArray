#!/usr/bin/env node
// One canonical release-readiness command: green package suites don't imply a green
// repository (validate-repository.mjs can fail on shared-file drift while both packages'
// tests pass independently) -- this runs every check that must pass, in order, and stops
// at the first failure instead of reporting several separately-green commands.

import { spawnSync } from "node:child_process";
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
    // serial: validate-package.test.mjs's spawned child intermittently crashes under
    // parallel file scheduling (3 distinct exit signatures observed); passes 3/3 serial.
    label: "pair-review test suite",
    cwd: path.join(root, "plugins/reviews/skills/pair-review"),
    cmd: node,
    args: ["--test", "--test-concurrency=1"],
  },
  {
    label: "cross-review package validation",
    cwd: path.join(root, "plugins/reviews/skills/cross-review"),
    cmd: node,
    args: ["scripts/validate-package.mjs"],
  },
  {
    label: "cross-review test suite",
    cwd: path.join(root, "plugins/reviews/skills/cross-review"),
    cmd: node,
    args: ["--test", "--test-concurrency=1"],
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

function main() {
  const release = process.argv.includes("--release");
  if (release && !checkCleanTree()) {
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
  process.stdout.write("\nrelease-check: all steps passed.\n");
}

main();
