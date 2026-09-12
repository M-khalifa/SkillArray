import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('validator accepts LF and CRLF copy installs and rejects the wrong skill identity', async (t) => {
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const skill = path.basename(path.resolve(source));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-package-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const copy = path.join(temp, skill);
  await fs.cp(source, copy, { recursive: true });
  const entry = path.join(copy, 'SKILL.md');
  const text = (await fs.readFile(entry, 'utf8')).replace(/\r\n/g, '\n');
  const validate = () => spawnSync(process.execPath, [path.join(copy, 'scripts', 'validate-package.mjs')], {
    encoding: 'utf8', timeout: 30000,
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
