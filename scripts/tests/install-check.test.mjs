import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../install-check.mjs', import.meta.url));
const SKILLS = ['cross-review', 'pair-review'];
const PASSING = 'process.exit(0);\n';

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRoot(t, validators = {}) {
  const root = tempDir(t, 'install-check-root-');
  for (const skill of SKILLS) {
    const dir = path.join(root, 'plugins', 'reviews', 'skills', skill);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, 'references'), { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
    writeFileSync(path.join(dir, 'references', 'a.md'), 'reference\n');
    writeFileSync(path.join(dir, 'scripts', 'validate-package.mjs'), validators[skill] ?? PASSING);
  }
  return root;
}

function run(root, extra = [], env = {}) {
  return spawnSync(process.execPath, [tool, '--root', root, ...extra], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('every skill alone and both together pass in the Claude Code and the Codex layout', (t) => {
  const r = run(makeRoot(t));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('PASS')), [
    'PASS claude-code .claude/skills [cross-review]',
    'PASS claude-code .claude/skills [pair-review]',
    'PASS claude-code .claude/skills [cross-review+pair-review]',
    'PASS codex .agents/skills [cross-review]',
    'PASS codex .agents/skills [pair-review]',
    'PASS codex .agents/skills [cross-review+pair-review]',
  ]);
  assert.equal(lines.at(-1), 'install-check: all cases passed');
});

test('--skills narrows the cases to the named skill in both layouts', (t) => {
  const r = run(makeRoot(t), ['--skills', 'pair-review']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').filter((l) => l.startsWith('PASS')), [
    'PASS claude-code .claude/skills [pair-review]',
    'PASS codex .agents/skills [pair-review]',
  ]);
});

test('a failing validate-package is a FAIL line with its last output line and a nonzero exit', (t) => {
  const root = makeRoot(t, { 'pair-review': "console.error('link broken'); process.exit(1);\n" });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL claude-code \.claude\/skills \[pair-review\]: pair-review: validate-package failed: link broken/);
  assert.match(r.stdout, /FAIL codex \.agents\/skills \[cross-review\+pair-review\]/);
  assert.match(r.stdout, /PASS claude-code \.claude\/skills \[cross-review\]/);
  assert.match(r.stdout, /install-check: 4 case\(s\) failed/);
});

test('an installed copy that differs from the source by one byte fails the hash comparison', (t) => {
  const mutate = "import { appendFileSync } from 'node:fs';\nappendFileSync('references/a.md', 'x');\n";
  const r = run(makeRoot(t, { 'cross-review': mutate }), ['--skills', 'cross-review']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL claude-code \.claude\/skills \[cross-review\]: cross-review: installed copy differs from the source: 1 file\(s\) missing or changed, 1 extra: references\/a\.md/);
});

test('an unknown skill name is refused before anything is copied', (t) => {
  const r = run(makeRoot(t), ['--skills', 'cross-review,nope']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--skills must name distinct skills/);
  assert.equal(r.stdout, '');
});

test('the scratch folder is removed by default and kept, and named, with --keep', (t) => {
  const scratch = tempDir(t, 'install-check-tmp-');
  const env = { TEMP: scratch, TMP: scratch, TMPDIR: scratch };
  const root = makeRoot(t);
  assert.equal(run(root, [], env).status, 0);
  assert.deepEqual(readdirSync(scratch), []);
  const kept = run(root, ['--keep'], env);
  assert.equal(kept.status, 0);
  const folder = /install-check: kept (.+)/.exec(kept.stdout)[1].trim();
  assert.equal(path.dirname(folder), path.resolve(scratch));
  assert.ok(existsSync(path.join(folder, 'codex-cross-review', '.agents', 'skills', 'cross-review', 'SKILL.md')));
  assert.ok(existsSync(path.join(folder, 'claude-code-pair-review', '.claude', 'skills', 'pair-review', 'SKILL.md')));
});

test('the check never writes into the user home folders', (t) => {
  const home = tempDir(t, 'install-check-home-');
  const env = { HOME: home, USERPROFILE: home };
  assert.equal(run(makeRoot(t), [], env).status, 0);
  assert.deepEqual(readdirSync(home), []);
});
