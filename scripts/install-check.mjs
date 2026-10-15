#!/usr/bin/env node
// Copies the review skills into scratch Claude Code and Codex project layouts and checks each copy.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ALL_SKILLS = ["cross-review", "pair-review"];
const LAYOUTS = [
  { name: "claude-code", dir: ".claude/skills" },
  { name: "codex", dir: ".agents/skills" },
];
const SKIPPED = new Set([".git", "node_modules"]);
const USAGE = `usage: node scripts/install-check.mjs [--skills cross-review,pair-review] [--keep] [--root <repo root>]
`;

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { skills: ALL_SKILLS, keep: false, root: scriptRoot };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (a === "--keep") {
      args.keep = true;
      continue;
    }
    if (a !== "--skills" && a !== "--root") throw new Error(`unrecognized argument: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
    if (a === "--root") {
      args.root = path.resolve(v);
    } else {
      args.skills = v.split(",").map((s) => s.trim()).filter(Boolean);
      const unknown = args.skills.filter((s) => !ALL_SKILLS.includes(s));
      if (unknown.length > 0 || args.skills.length === 0 || new Set(args.skills).size !== args.skills.length) {
        throw new Error(`--skills must name distinct skills from ${ALL_SKILLS.join(", ")}, got "${v}"`);
      }
    }
  }
  return args;
}

function fileHashes(dir, rel = "") {
  const out = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...fileHashes(dir, next));
    else out.push(`${next} ${createHash("sha256").update(readFileSync(path.join(dir, next))).digest("hex")}`);
  }
  return out.sort();
}

function compareTrees(source, installed) {
  const a = fileHashes(source);
  const b = fileHashes(installed);
  const missing = a.filter((line) => !b.includes(line));
  const extra = b.filter((line) => !a.includes(line));
  if (missing.length === 0 && extra.length === 0) return null;
  const names = [...missing, ...extra].map((line) => line.split(" ")[0]);
  return `${missing.length} file(s) missing or changed, ${extra.length} extra: ${[...new Set(names)].slice(0, 5).join(", ")}`;
}

function casesFor(skills) {
  const cases = skills.map((s) => ({ label: s, skills: [s] }));
  if (skills.length > 1) cases.push({ label: skills.join("+"), skills });
  return cases;
}

function runCase(args, scratch, layout, testCase) {
  const project = path.join(scratch, `${layout.name}-${testCase.label}`);
  const target = path.join(project, ...layout.dir.split("/"));
  mkdirSync(target, { recursive: true });
  const problems = [];
  for (const skill of testCase.skills) {
    const source = path.join(args.root, "plugins", skill, "skills", skill);
    const installed = path.join(target, skill);
    cpSync(source, installed, { recursive: true, filter: (from) => !SKIPPED.has(path.basename(from)) });
    const validate = spawnSync(process.execPath, ["scripts/validate-package.mjs"], { cwd: installed, encoding: "utf8" });
    if (validate.error || validate.status !== 0) {
      const detail = validate.error ? validate.error.message : (validate.stderr || validate.stdout).trim().split(/\r?\n/).at(-1);
      problems.push(`${skill}: validate-package failed: ${detail}`);
      continue;
    }
    const drift = compareTrees(source, installed);
    if (drift) problems.push(`${skill}: installed copy differs from the source: ${drift}`);
  }
  const where = `${layout.name} ${layout.dir} [${testCase.label}]`;
  return problems.length === 0 ? { ok: true, line: `PASS ${where}` } : { ok: false, line: `FAIL ${where}: ${problems.join("; ")}` };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "install-check-"));
  let failed = 0;
  try {
    for (const layout of LAYOUTS) {
      for (const testCase of casesFor(args.skills)) {
        const result = runCase(args, scratch, layout, testCase);
        process.stdout.write(`${result.line}\n`);
        if (!result.ok) failed++;
      }
    }
  } finally {
    if (args.keep) process.stdout.write(`install-check: kept ${scratch}\n`);
    else rmSync(scratch, { recursive: true, force: true });
  }
  process.stdout.write(`install-check: ${failed === 0 ? "all cases passed" : `${failed} case(s) failed`}\n`);
  return failed === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`install-check: ${err.message}\n`);
  process.exitCode = 1;
}
