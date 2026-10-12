#!/usr/bin/env node
// Compares the working tree's review skills with a base revision: brief bytes and rule-item coverage.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SKILLS = ["cross-review", "pair-review"];
const SKILLS_REL = "plugins/reviews/skills";
const MIN_ITEM = 20;
const SHOWN_ITEM = 120;
const MAX_LINES = 50;
const DROPS_HEADER = "# Dropped base rule items, one per line: <item text exactly as compare-baseline prints it><TAB><reason>";
const USAGE = `usage: node scripts/compare-baseline.mjs --base <git rev> [--drops <file>] [--root <repo root>] [--init-drops]
`;

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { base: null, drops: null, root: scriptRoot, initDrops: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (a === "--init-drops") {
      args.initDrops = true;
      continue;
    }
    if (a !== "--base" && a !== "--drops" && a !== "--root") {
      throw new Error(`unrecognized argument: ${a}`);
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${a} requires a value`);
    }
    if (a === "--base") args.base = v;
    else if (a === "--drops") args.drops = path.resolve(v);
    else args.root = path.resolve(v);
  }
  if (!args.base) {
    throw new Error("--base <git rev> is required");
  }
  if (args.drops === null) {
    args.drops = path.join(args.root, "docs", "design", "drops-1.1.0.txt");
  }
  return args;
}

function git(root, gitArgs) {
  return spawnSync("git", ["-C", root, ...gitArgs], { encoding: "utf8", maxBuffer: 1 << 28 });
}

function resolveRev(root, rev) {
  if (rev.startsWith("-")) {
    throw new Error(`revision "${rev}" does not resolve to a commit in ${root}`);
  }
  const result = git(root, ["rev-parse", "--verify", "--quiet", rev + "^{commit}"]);
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`revision "${rev}" does not resolve to a commit in ${root}`);
  }
  return result.stdout.trim();
}

function extractBase(root, commit, workDir) {
  const tarFile = path.join(workDir, "base.tar");
  const archive = git(root, ["archive", "--format=tar", "-o", tarFile, commit, SKILLS_REL]);
  if (archive.status !== 0) {
    throw new Error(`git archive ${commit} failed: ${(archive.stderr || "").trim()}`);
  }
  const dest = path.join(workDir, "base");
  mkdirSync(dest);
  // Relative names keep a Windows drive letter out of tar's arguments.
  const untar = spawnSync("tar", ["-xf", "base.tar", "-C", "base"], { cwd: workDir, encoding: "utf8" });
  if (untar.error || untar.status !== 0) {
    throw new Error(`could not extract the base archive: ${untar.error ? untar.error.message : (untar.stderr || "").trim()}`);
  }
  return dest;
}

function writeFixture(dir) {
  const fx = path.join(dir, "fixture");
  const files = {
    "task-packet.md": "# Target\nreview article.md\n",
    "peer-view-for-A.md": "# Seat P findings\n\n## P1 — thing\nSeverity: LOW\n",
    "claim.md": "## X1 — c\nSeverity: HIGH\n",
    "rebuttal.md": "### X1\nAction: DISPUTE\n",
    "audit/X-findings.md": "x\n",
    "audit/Y-findings.md": "y\n",
    "target/article.md": "article\n",
    "run/.keep": "",
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(fx, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return fx;
}

function briefSpecs(fx) {
  const p = (name) => path.join(fx, name);
  return [
    { name: "phase1-seat-A", args: ["--mode", "phase1", "--packet", p("task-packet.md"), "--seat", "A", "--output-path", p("A-findings.md")] },
    { name: "phase1-seat-B", args: ["--mode", "phase1", "--packet", p("task-packet.md"), "--seat", "B"] },
    { name: "phase1-seat-A-repo-only", args: ["--mode", "phase1", "--packet", p("task-packet.md"), "--seat", "A", "--repo-only"] },
    { name: "delta", args: ["--mode", "delta", "--peer-view", p("peer-view-for-A.md"), "--output-path", p("A-rebuttal.md")] },
    { name: "auditor-light", args: ["--mode", "auditor", "--packet", p("task-packet.md"), "--audit-dir", p("audit"), "--target-dir", p("target"), "--run-dir", p("run")] },
    { name: "auditor-full", args: ["--mode", "auditor", "--packet", p("task-packet.md"), "--audit-dir", p("audit"), "--target-dir", p("target"), "--run-dir", p("run"), "--audit-depth", "full"] },
    { name: "verifier", args: ["--mode", "verifier", "--claim", p("claim.md"), "--rebuttal", p("rebuttal.md"), "--target-dir", p("target")] },
  ];
}

function normalisePaths(text, dir) {
  const spellings = new Set([dir, dir.replace(/\\/g, "/"), dir.replace(/\\/g, "\\\\")]);
  let out = text;
  for (const s of spellings) {
    out = out.split(s).join("<TMP>");
  }
  return out;
}

function buildBrief(skillRoot, spec, outFile) {
  const script = path.join(skillRoot, "scripts", "build-brief.mjs");
  if (!existsSync(script)) {
    return { error: `missing ${script}` };
  }
  const result = spawnSync(process.execPath, [script, ...spec.args, "--out", outFile], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { error: `build-brief exited ${result.status}: ${(result.stderr || result.error?.message || "").trim()}` };
  }
  return { text: readFileSync(outFile, "utf8") };
}

function compareBriefs(baseSkills, workSkills, workDir) {
  const failures = [];
  const fx = writeFixture(workDir);
  let compared = 0;
  for (const skill of SKILLS) {
    for (const spec of briefSpecs(fx)) {
      const outs = {};
      for (const [side, skillsDir] of [["base", baseSkills], ["work", workSkills]]) {
        const outDir = path.join(workDir, "out", side, skill);
        mkdirSync(outDir, { recursive: true });
        outs[side] = buildBrief(path.join(skillsDir, skill), spec, path.join(outDir, `${spec.name}.txt`));
      }
      compared++;
      for (const side of ["base", "work"]) {
        if (outs[side].error) {
          failures.push(`brief ${spec.name} [${skill}] could not be built from the ${side} tree: ${outs[side].error}`);
        }
      }
      if (outs.base.error || outs.work.error) continue;
      const a = normalisePaths(outs.base.text, workDir);
      const b = normalisePaths(outs.work.text, workDir);
      if (a === b) continue;
      const aLines = a.split("\n");
      const bLines = b.split("\n");
      let n = 0;
      while (n < aLines.length && n < bLines.length && aLines[n] === bLines[n]) n++;
      failures.push(`brief ${spec.name} [${skill}] differs at line ${n + 1}:\n  base: ${aLines[n] ?? "(end of brief)"}\n  work: ${bLines[n] ?? "(end of brief)"}`);
    }
  }
  return { compared, failures };
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normalise(s) {
  return s.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
}

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z`*(])/);
}

function extractItems(rawText) {
  const text = stripBom(rawText);
  const items = [];
  const push = (s) => {
    const n = normalise(s);
    if (n.length >= MIN_ITEM) items.push(n);
  };
  let fence = null;
  let para = [];
  const flush = () => {
    if (para.length > 0) {
      for (const s of splitSentences(para.join(" "))) push(s);
      para = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1]) {
        fence = null;
      } else {
        push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      continue;
    }
    if (line.trim() === "" || /^\s{0,3}#{1,6}(\s|$)/.test(line)) {
      flush();
      continue;
    }
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (listItem || /^\s*[|>]/.test(line)) {
      flush();
      para.push(listItem ? line.slice(listItem[0].length) : line.trim());
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return items;
}

function docFiles(skillDir) {
  const files = [];
  const entry = path.join(skillDir, "SKILL.md");
  if (existsSync(entry)) files.push(entry);
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) files.push(full);
    }
  };
  walk(path.join(skillDir, "references"));
  return files.sort();
}

function readDrops(file) {
  const drops = new Map();
  const problems = [];
  if (!existsSync(file)) return { drops, problems };
  readFileSync(file, "utf8").split(/\r?\n/).forEach((raw, i) => {
    if (raw.trim() === "" || raw.startsWith("#")) return;
    const tab = raw.indexOf("\t");
    const text = (tab < 0 ? raw : raw.slice(0, tab)).trim();
    const reason = tab < 0 ? "" : raw.slice(tab + 1).trim();
    if (reason === "") {
      problems.push(`drops line ${i + 1}: drop has no reason: ${text.slice(0, SHOWN_ITEM)}`);
      return;
    }
    drops.set(text, { reason, line: i + 1, used: false, matched: false });
  });
  return { drops, problems };
}

function checkCoverage(baseSkills, workSkills, dropsFile) {
  const { drops, problems } = readDrops(dropsFile);
  const missing = [];
  let checked = 0;
  for (const skill of SKILLS) {
    const baseDir = path.join(baseSkills, skill);
    const workText = docFiles(path.join(workSkills, skill))
      .map((f) => normalise(stripBom(readFileSync(f, "utf8"))))
      .join("\n");
    for (const file of docFiles(baseDir)) {
      for (const item of extractItems(readFileSync(file, "utf8"))) {
        checked++;
        const shown = item.slice(0, SHOWN_ITEM).trim();
        const drop = drops.get(shown);
        if (drop) drop.matched = true;
        if (workText.includes(item)) continue;
        if (drop) {
          drop.used = true;
          continue;
        }
        missing.push(`[${skill}] ${path.relative(baseDir, file).split(path.sep).join("/")}: ${shown}`);
      }
    }
  }
  const failures = [...problems];
  for (const [text, drop] of drops) {
    if (!drop.matched) failures.push(`drops line ${drop.line}: stale drop, no base item starts with: ${text}`);
  }
  return { checked, missing, failures, used: [...drops.values()].filter((d) => d.used).length };
}

function run(args) {
  const commit = resolveRev(args.root, args.base);
  if (args.initDrops && !existsSync(args.drops)) {
    mkdirSync(path.dirname(args.drops), { recursive: true });
    writeFileSync(args.drops, `${DROPS_HEADER}\n`);
  }
  const workDir = mkdtempSync(path.join(os.tmpdir(), "compare-baseline-"));
  try {
    const baseSkills = path.join(extractBase(args.root, commit, workDir), ...SKILLS_REL.split("/"));
    const workSkills = path.join(args.root, ...SKILLS_REL.split("/"));
    const briefs = compareBriefs(baseSkills, workSkills, workDir);
    const coverage = checkCoverage(baseSkills, workSkills, args.drops);
    const lines = [...briefs.failures];
    lines.push(...coverage.missing.slice(0, MAX_LINES));
    if (coverage.missing.length > 0) {
      lines.push(`${coverage.missing.length} base rule item(s) missing from the working tree${coverage.missing.length > MAX_LINES ? ` (first ${MAX_LINES} shown)` : ""}`);
    }
    lines.push(...coverage.failures);
    if (lines.length > 0) {
      process.stderr.write(`compare-baseline: FAILED against ${args.base}\n${lines.join("\n")}\n`);
      return 1;
    }
    process.stdout.write(`compare-baseline: passed against ${args.base}: ${briefs.compared} briefs identical, ${coverage.checked} rule items checked, ${coverage.used} drops used\n`);
    return 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = run(parseArgs(process.argv.slice(2)));
} catch (err) {
  process.stderr.write(`compare-baseline: ${err.message}\n`);
  process.exitCode = 1;
}
