import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, copyDriftWarning, pluginCopyDrift, pluginUpdateCheck } from '../preflight.mjs';
import { buildReport, renderChat, renderHtml, renderMarkdown, renderText, updateNote, loadRun } from '../build-report.mjs';

async function layout(t, { installed = '1.2.1', published = '1.2.2', source = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'update check '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plugins = path.join(root, 'plugins');
  const skillDir = path.join(plugins, 'cache', 'skillarray', 'pair-review', installed, 'skills', 'pair-review');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(path.join(plugins, 'cache', 'skillarray', 'pair-review', installed, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(plugins, 'cache', 'skillarray', 'pair-review', installed, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pair-review', version: installed }));
  const market = path.join(plugins, 'marketplaces', 'skillarray');
  const src = source ?? 'plugins/pair-review';
  await fs.mkdir(path.join(market, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'skillarray', plugins: [{ name: 'pair-review', source: `./${src}` }] }));
  if (published !== null) {
    await fs.mkdir(path.join(market, src, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(market, src, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pair-review', version: published }));
  }
  return skillDir;
}

test('compareVersions: dotted numbers, missing parts as 0, anything else equal', () => {
  assert.equal(compareVersions('1.2.2', '1.2.1'), 1);
  assert.equal(compareVersions('1.2.1', '1.10.0'), -1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('abc123', '1.2.1'), 0);
  assert.equal(compareVersions(null, '1.2.1'), 0);
});

test('pluginUpdateCheck: reads the running plugin version and the marketplace clone, with no network call', async (t) => {
  assert.deepEqual(await pluginUpdateCheck(await layout(t)), { plugin: 'pair-review', marketplace: 'skillarray', installed: '1.2.1', published: '1.2.2', newer: true });
  assert.equal((await pluginUpdateCheck(await layout(t, { published: '1.2.1' }))).newer, false);
  assert.equal((await pluginUpdateCheck(await layout(t, { published: '1.2.0' }))).newer, false, 'an older clone is not an update');
  assert.equal((await pluginUpdateCheck(await layout(t, { source: 'alt/dir' }))).published, '1.2.2', 'the marketplace entry source is followed');
  assert.equal(await pluginUpdateCheck(await layout(t, { published: null })), null, 'no clone copy, no claim');
  assert.equal(await pluginUpdateCheck(path.join(os.tmpdir(), 'skills', 'pair-review')), null, 'not a plugin-cache install');
});

const MANIFEST = { status: 'completed', reviewers: [], exchange: {}, seat_usage: {} };
const UPDATE = { plugin: 'pair-review', marketplace: 'skillarray', installed: '1.2.1', published: '1.2.2', newer: true };

test('report: the HTML footer carries the update line after the credit link; none when not newer or absent', () => {
  const html = renderHtml(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update: UPDATE }));
  assert.match(html, /<footer class="meta">Reviewed with [^<]*<a href="[^"]*">[^<]*<\/a><p>A newer SkillArray \(1\.2\.2\) is published; this run used 1\.2\.1\. Update: [^<]*<\/p><\/footer>/);
  for (const update of [null, { ...UPDATE, newer: false }]) {
    const quiet = renderHtml(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update }));
    assert.doesNotMatch(quiet, /newer SkillArray/);
    assert.match(quiet, /<\/a><\/footer>/);
  }
});

test('report: one update line after the credit line in chat, markdown and text; none when not newer or absent', async (t) => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update: UPDATE });
  const line = updateNote(UPDATE);
  assert.equal(line, 'A newer SkillArray (1.2.2) is published; this run used 1.2.1. Update: /plugin manage, pair-review, Update now, then /reload-plugins (or in a shell: claude plugin update pair-review@skillarray).');
  const chat = renderChat(report);
  assert.ok(chat.trimEnd().endsWith(line), chat);
  assert.ok(renderText(report).includes(line));
  assert.ok(renderMarkdown(report).includes('A newer SkillArray (1.2.2) is published'));
  for (const update of [null, { ...UPDATE, newer: false }]) {
    const quiet = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update });
    assert.equal('update' in quiet, false);
    assert.doesNotMatch(renderChat(quiet), /newer SkillArray/);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'update report '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(dir, 'update-check.json'), JSON.stringify(UPDATE));
  assert.deepEqual((await loadRun(dir)).update, UPDATE);
  await fs.writeFile(path.join(dir, 'update-check.json'), '{not json');
  assert.equal('update' in (await loadRun(dir)), false, 'an unreadable record is ignored');
});

test('r4 F1: with a newer marketplace version and changed files, only the update notice speaks; no same-version drift warning', async (t) => {
  const skillDir = await layout(t);
  const market = path.join(skillDir, '..', '..', '..', '..', '..', '..', 'marketplaces', 'skillarray', 'plugins', 'pair-review', 'skills', 'pair-review');
  for (const [dir, body] of [[skillDir, 'old'], [market, 'new']]) {
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# s');
    await fs.writeFile(path.join(dir, 'scripts', 'review-run.mjs'), body);
  }
  const update = await pluginUpdateCheck(skillDir);
  const stale = await pluginCopyDrift(skillDir);
  assert.deepEqual([update.newer, stale], [true, ['scripts/review-run.mjs']]);
  assert.equal(copyDriftWarning(stale, update, 'pair-review'), null);
  assert.equal(copyDriftWarning(stale, { ...update, published: '1.2.0', newer: false }, 'pair-review'), null, 'an older marketplace version is not the same version either');
});

test('r4 F1 neighbours: the same version with changed files, or no update check, still warns; no changed files, no warning', () => {
  const same = { plugin: 'pair-review', marketplace: 'skillarray', installed: '1.2.1', published: '1.2.1', newer: false };
  const text = "this skill runs from Claude Code's plugin cache, and 1 file(s) differ from the marketplace copy (scripts/review-run.mjs): an older build under the same version may be running. Update it (/plugin manage, pair-review, Update now, or in a shell: claude plugin update pair-review@<marketplace>; or uninstall and install it), restart, and run preflight again";
  assert.equal(copyDriftWarning(['scripts/review-run.mjs'], same, 'pair-review'), text);
  assert.equal(copyDriftWarning(['scripts/review-run.mjs'], null, 'pair-review'), text);
  assert.equal(copyDriftWarning([], same, 'pair-review'), null);
});

test('r5 F6: the update steps name the plugin update (Installed tab, Update now, or claude plugin update), never a /plugin update slash command or the marketplace refresh', () => {
  for (const text of [updateNote(UPDATE), copyDriftWarning(['scripts/review-run.mjs'], null, 'pair-review')]) {
    assert.match(text, /\/plugin manage, pair-review, Update now/);
    assert.match(text, /in a shell: claude plugin update pair-review@/);
    assert.doesNotMatch(text, /\/plugin update|Update marketplace|Marketplaces/);
  }
});

test('r5 F6 neighbours: the update line still follows the credit line in every renderer and names the running and published versions', () => {
  const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update: { ...UPDATE, plugin: 'cross-review' } });
  const line = updateNote(report.update);
  assert.match(line, /^A newer SkillArray \(1\.2\.2\) is published; this run used 1\.2\.1\. Update: \/plugin manage, cross-review, Update now, then \/reload-plugins \(or in a shell: claude plugin update cross-review@skillarray\)\.$/);
  assert.ok(renderChat(report).trimEnd().endsWith(line));
  assert.ok(renderText(report).includes(line));
});

test('r5 F2: a parseable update record with a non-string version, plugin or marketplace, or newer not true, is ignored and no renderer crashes', async (t) => {
  const bad = [{ ...UPDATE, published: { toString: null, valueOf: null } }, { ...UPDATE, published: { v: 1 } }, { ...UPDATE, installed: 121 }, { ...UPDATE, plugin: { toString: null, valueOf: null } },
    { ...UPDATE, marketplace: null }, { ...UPDATE, published: '' }, { ...UPDATE, newer: 'true' }, { ...UPDATE, newer: 1 }];
  for (const update of bad) {
    const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update });
    assert.equal('update' in report, false, JSON.stringify(update));
    for (const render of [renderText, renderMarkdown, renderHtml, renderChat]) assert.doesNotMatch(render(report), /newer SkillArray/);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'update bad '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'phase3'), { recursive: true });
  await fs.writeFile(path.join(dir, 'phase3', 'findings.json'), JSON.stringify({ findings: [] }));
  await fs.writeFile(path.join(dir, 'update-check.json'), JSON.stringify({ ...UPDATE, published: { toString: null, valueOf: null } }));
  const report = await loadRun(dir);
  assert.doesNotThrow(() => renderText(report));
  assert.doesNotMatch(renderText(report), /newer SkillArray/);
});

test('r5 F2 neighbours: a well-formed record is kept as it is, and a record that is not newer stays out', () => {
  assert.deepEqual(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update: UPDATE }).update, UPDATE);
  assert.equal('update' in buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update: { ...UPDATE, published: '1.2.1', newer: false } }), false);
});

test('r6 F3: a plugin.json version that is missing or not text is not a version; the installed side falls back to the cache folder name', async (t) => {
  const write = (dir, json) => fs.writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(json));
  const cacheRoot = (skillDir) => path.dirname(path.dirname(skillDir));
  const cloneRoot = (skillDir) => path.join(skillDir, '..', '..', '..', '..', '..', '..', 'marketplaces', 'skillarray', 'plugins', 'pair-review');
  let skillDir = await layout(t);
  await write(cacheRoot(skillDir), { name: 'pair-review' });
  assert.deepEqual(await pluginUpdateCheck(skillDir), { plugin: 'pair-review', marketplace: 'skillarray', installed: '1.2.1', published: '1.2.2', newer: true });
  skillDir = await layout(t);
  await write(cacheRoot(skillDir), { name: 'pair-review', version: 3 });
  assert.equal((await pluginUpdateCheck(skillDir)).installed, '1.2.1', 'a numeric installed version falls back to the folder name');
  for (const version of [2, '', null, { v: 2 }]) {
    skillDir = await layout(t);
    await write(cloneRoot(skillDir), { name: 'pair-review', version });
    assert.equal(await pluginUpdateCheck(skillDir), null, JSON.stringify(version));
  }
  assert.equal(compareVersions(2, '1.2.1'), 0, 'a number is not a version');
  assert.equal(compareVersions('2', '1.2.1'), 1);
});

test('r6 F4: the report re-compares the versions and shows the line only when the published one is a newer dotted version', () => {
  for (const update of [{ ...UPDATE, published: '1.2.0' }, { ...UPDATE, published: '1.2.1' }, { ...UPDATE, published: 'garbage' }, { ...UPDATE, installed: 'v1.2.1' }, { ...UPDATE, published: '1.2.2-beta' }]) {
    const report = buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update });
    assert.equal('update' in report, false, JSON.stringify(update));
    for (const render of [renderText, renderMarkdown, renderHtml, renderChat]) assert.doesNotMatch(render(report), /newer SkillArray/);
  }
  assert.deepEqual(buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update: { ...UPDATE, published: '1.10.0' } }).update.published, '1.10.0');
  assert.equal('update' in buildReport({ findingsDoc: { findings: [] }, manifest: MANIFEST, seatTexts: {}, update: { ...UPDATE, newer: false } }), false, 'newer must still be true');
});
