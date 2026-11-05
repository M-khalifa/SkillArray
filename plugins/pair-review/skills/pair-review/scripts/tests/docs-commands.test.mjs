// The docs name only commands that exist: no step module is run by hand, and every review-run command and option in a
// code span or block is one review-run's usage text lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../review-run.mjs';

const SKILL = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const MODULES = ['blind-relabel', 'exchange', 'build-brief', 'build-manifest', 'build-report', 'build-recheck-packet'];

function docs() {
  const out = ['SKILL.md', 'README.md'].map((f) => path.join(SKILL, f));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.name.endsWith('.md')) out.push(path.join(dir, e.name));
    }
  };
  walk(path.join(SKILL, 'references'));
  return out;
}

// Inline code spans and fenced lines, with the file and line they come from.
function codeOf(text) {
  const spans = [];
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) spans.push({ line: i + 1, code: line });
    else for (const m of line.matchAll(/`([^`]+)`/g)) spans.push({ line: i + 1, code: m[1] });
  });
  return spans;
}

async function usage() {
  let text = '';
  await run(['--help'], { stdout: { write: (c) => { text += c; } }, stderr: { write: () => {} } });
  const commands = new Map();
  for (const m of text.matchAll(/^ {2}node review-run\.mjs (\S+)(.*)$/gm)) {
    const flags = commands.get(m[1]) ?? new Set();
    for (const f of m[2].matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(f[0]);
    commands.set(m[1], flags);
  }
  return commands;
}

test('docs never tell anyone to run a step module: those are modules with no command line', () => {
  const run = new RegExp(`\\b(${MODULES.join('|')})\\.mjs["'\`]?\\s+(--|[a-z][a-z-]*\\s+--)`);
  const hits = [];
  for (const file of docs()) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (run.test(line)) hits.push(`${path.relative(SKILL, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('every review-run command and option the docs write in code is in review-run\'s usage', async () => {
  const commands = await usage();
  assert.ok(commands.size >= 10, [...commands.keys()].join(' '));
  const problems = [];
  for (const file of docs()) {
    for (const { line, code } of codeOf(fs.readFileSync(file, 'utf8'))) {
      // A command: review-run at the start of the code, or after node, a path or a quote; prose in a template block is not one.
      for (const m of code.matchAll(/(?:^|node\s+\S*|[\/\\"])review-run(?:\.mjs)?["']?\s+([a-z][a-z0-9-]*)([^|;&]*)/g)) {
        const where = `${path.relative(SKILL, file)}:${line}`;
        const flags = commands.get(m[1]);
        if (!flags) { problems.push(`${where}: "review-run ${m[1]}" is not a review-run command`); continue; }
        for (const f of m[2].matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) {
          if (!flags.has(f[0])) problems.push(`${where}: review-run ${m[1]} has no option ${f[0]}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('SKILL.md: the rules that apply throughout end within the first 5,000 tokens (4 characters each), which survive compaction', () => {
  const text = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('\n## Rules that apply throughout\n');
  const end = text.indexOf('\n## ', start + 1);
  assert.ok(start > 0 && end > start, 'the section is there');
  assert.ok(end <= text.indexOf('\n## Quickstart\n'), 'it comes before the Quickstart');
  assert.ok(end / 4 < 5000, `it ends at about ${Math.round(end / 4)} tokens`);
});
