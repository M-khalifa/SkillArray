import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('validator accepts LF and CRLF copy installs and rejects the wrong skill identity [slow]', async (t) => {
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const skill = path.basename(path.resolve(source));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-package-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const copy = path.join(temp, skill);
  // Tests are not part of the identity check, and every .mjs file costs the validator one node spawn.
  const testsDir = path.join(source, 'scripts', 'tests');
  await fs.cp(source, copy, { recursive: true, filter: (from) => path.resolve(from) !== path.resolve(testsDir) });
  const entry = path.join(copy, 'SKILL.md');
  const text = (await fs.readFile(entry, 'utf8')).replace(/\r\n/g, '\n');
  const validate = () => spawnSync(process.execPath, [path.join(copy, 'scripts', 'validate-package.mjs')], {
    encoding: 'utf8', timeout: 180000,
  });
  for (const newline of ['\n', '\r\n']) {
    await fs.writeFile(entry, text.replace(/\n/g, newline));
    const result = validate();
    assert.equal(result.status, 0, result.stderr);
  }
  await fs.writeFile(entry, text.replace('name: ' + skill, 'name: another-skill'));
  const result = validate();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /frontmatter identity does not match/);
});

test('validator enforces the 1024-character description and 500-line SKILL.md limits', async (t) => {
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const skill = path.basename(path.resolve(source));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-limits-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const copy = path.join(temp, skill);
  await fs.mkdir(path.join(copy, 'scripts'), { recursive: true });
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(copy, 'LICENSE'));
  await fs.copyFile(path.join(source, 'scripts', 'validate-package.mjs'), path.join(copy, 'scripts', 'validate-package.mjs'));
  const run = async (descriptionLength, totalLines) => {
    const head = ['---', 'name: ' + skill, 'description: >-', '  ' + 'a'.repeat(descriptionLength), '---'];
    const lines = head.concat(Array(totalLines - head.length).fill('body'));
    await fs.writeFile(path.join(copy, 'SKILL.md'), lines.join('\n') + '\n');
    return spawnSync(process.execPath, [path.join(copy, 'scripts', 'validate-package.mjs')], { encoding: 'utf8', timeout: 60000 });
  };
  assert.equal((await run(1024, 100)).status, 0);
  const longDescription = await run(1025, 100);
  assert.notEqual(longDescription.status, 0);
  assert.match(longDescription.stderr, /description is 1025 characters/);
  assert.equal((await run(100, 500)).status, 0);
  const longFile = await run(100, 501);
  assert.notEqual(longFile.status, 0);
  assert.match(longFile.stderr, /501 lines/);
});

test('validator measures every description form: folded with blank lines, plain, quoted, literal block', async (t) => {
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const skill = path.basename(path.resolve(source));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-forms-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const copy = path.join(temp, skill);
  await fs.mkdir(path.join(copy, 'scripts'), { recursive: true });
  await fs.copyFile(path.join(source, 'LICENSE'), path.join(copy, 'LICENSE'));
  await fs.copyFile(path.join(source, 'scripts', 'validate-package.mjs'), path.join(copy, 'scripts', 'validate-package.mjs'));
  const run = async (descriptionLines) => {
    const lines = ['---', 'name: ' + skill, ...descriptionLines, 'license: MIT', '---', 'body'];
    await fs.writeFile(path.join(copy, 'SKILL.md'), lines.join('\n') + '\n');
    return spawnSync(process.execPath, [path.join(copy, 'scripts', 'validate-package.mjs')], { encoding: 'utf8', timeout: 60000 });
  };
  const a = (n) => 'a'.repeat(n);
  const tooLong = /description is 1025 characters/;
  for (const marker of ['>', '>-']) {
    const over = await run(['description: ' + marker, '  ' + a(600), '', '  ' + a(424)]);
    assert.notEqual(over.status, 0, marker + ' with an internal blank line, 1025 characters');
    assert.match(over.stderr, tooLong);
    assert.equal((await run(['description: ' + marker, '  ' + a(600), '', '  ' + a(423)])).status, 0, marker + ' with an internal blank line, 1024 characters');
  }
  for (const marker of ['|', '|-']) {
    assert.equal((await run(['description: ' + marker, '  ' + a(1024)])).status, 0, marker + ' block, 1024 characters');
    assert.match((await run(['description: ' + marker, '  ' + a(1025)])).stderr, tooLong);
  }
  assert.equal((await run(['description: ' + a(1024)])).status, 0, 'plain one-line, 1024 characters');
  const plainOver = await run(['description: ' + a(1025)]);
  assert.notEqual(plainOver.status, 0);
  assert.match(plainOver.stderr, tooLong);
  assert.equal((await run(['description: "' + a(1024) + '"'])).status, 0, 'double-quoted, quotes not counted');
  assert.equal((await run(["description: '" + a(1024) + "'"])).status, 0, 'single-quoted, quotes not counted');
  assert.match((await run(['description: "' + a(1025) + '"'])).stderr, tooLong);
  const missing = await run(['title: none']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing description/);
});
