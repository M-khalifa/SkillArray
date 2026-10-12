import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  RunDescriptorError, readRunDescriptor, writeRunDescriptor, seatOutputDir, canonicalPath, channelFor, publishSeatOutput,
  assertGrantsIsolated, seatTable,
} from '../run-descriptor.mjs';

const MODULE_URL = new URL('../run-descriptor.mjs', import.meta.url).href;

function actor(root, role, overrides = {}) {
  return {
    role, provider: 'anthropic', runtime: 'claude', model: 'model-one', effort: 'high', transport: 'cli',
    sessionId: null, outputDir: path.join(root, 'phase1', `seat-${role}`), resultPath: path.join(root, 'phase1', `seat-${role}`, 'result.json'),
    worktreePath: null, ...overrides,
  };
}

function descriptor(root, target, patch = {}) {
  return {
    skill: 'cross-review', skillDir: path.join(root, 'skill'), targetDir: target, host: 'claude-code',
    flags: { auditDepth: 'light', falsification: false, mode: 'adversarial' }, fingerprint: null,
    seatA: actor(root, 'A'),
    seatB: actor(root, 'B', { provider: 'openai', runtime: 'codex', model: 'model-two', transport: 'cli' }),
    auditor: actor(root, 'auditor', { outputDir: path.join(root, 'phase3'), transport: 'native' }),
    verifiers: [],
    ...patch,
  };
}

async function setup(t, patch = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'run-descriptor-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'run dir');
  const target = path.join(base, 'target');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(target);
  const data = descriptor(root, target, patch);
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify(data, null, 2));
  return { base, root, target, data };
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('a valid descriptor is read with its run directory and a deterministic seat table', async (t) => {
  const s = await setup(t);
  const desc = await readRunDescriptor(s.root);
  assert.equal(desc.runDir, path.resolve(s.root));
  assert.equal(desc.seatA.model, 'model-one');
  assert.deepEqual(desc.verifiers, []);
  assert.deepEqual(seatTable(desc).map((row) => [row.role, row.channel, row.transport]), [
    ['A', 'file', 'cli'], ['B', 'final-message', 'cli'], ['auditor', 'file', 'native'],
  ]);
  assert.equal(seatOutputDir(desc, 'phase1', 'A'), path.join(path.resolve(s.root), 'phase1', 'seat-A'));
  assert.equal(seatOutputDir(desc, 'phase2', 'B'), path.join(path.resolve(s.root), 'phase2', 'seat-B'));
  assert.equal(canonicalPath(desc, 'phase1', 'A'), path.join(path.resolve(s.root), 'phase1', 'A-findings.md'));
  assert.equal(canonicalPath(desc, 'phase2', 'B'), path.join(path.resolve(s.root), 'phase2', 'B-rebuttals-raw.md'));
  assert.throws(() => seatOutputDir(desc, 'phase3', 'A'), RunDescriptorError);
  assert.throws(() => seatOutputDir(desc, 'phase1', 'C'), RunDescriptorError);
});

test('extraRepos must be an array of absolute dir + snapshotHash, and is optional', async (t) => {
  const ok = await setup(t, { extraRepos: [{ dir: path.resolve('elsewhere'), snapshotHash: 'abc' }] });
  assert.equal((await readRunDescriptor(ok.root)).extraRepos.length, 1);
  for (const bad of [{ dir: 'relative', snapshotHash: 'abc' }, { dir: path.resolve('x') }, 'x']) {
    const { root } = await setup(t, { extraRepos: [bad] });
    await assert.rejects(readRunDescriptor(root), /extraRepos/);
  }
});

test('a descriptor with a byte-order mark and verifier entries is accepted', async (t) => {
  const s = await setup(t);
  const verifier = actor(s.root, 'verifier-1', { outputDir: path.join(s.root, 'phase3', 'verifier-1') });
  await fs.writeFile(path.join(s.root, 'run.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ ...s.data, verifiers: [verifier] }))]));
  const desc = await readRunDescriptor(s.root);
  assert.equal(desc.verifiers.length, 1);
  assert.equal(seatTable(desc).at(-1).role, 'verifier-1');
});

test('malformed JSON, a missing file and a non-object descriptor are refused with the file named', async (t) => {
  const s = await setup(t);
  const file = path.join(s.root, 'run.json');
  await fs.writeFile(file, '{ "skill": ');
  await assert.rejects(readRunDescriptor(s.root), (e) => e instanceof RunDescriptorError && /is not valid JSON/.test(e.message) && e.message.includes(file));
  await fs.writeFile(file, '[]');
  await assert.rejects(readRunDescriptor(s.root), /must hold one JSON object/);
  await fs.rm(file);
  await assert.rejects(readRunDescriptor(s.root), /cannot read run descriptor .*ENOENT/);
});

test('a missing actor is refused for each actor slot, and the verifiers array is required', async (t) => {
  for (const slot of ['seatA', 'seatB', 'auditor']) {
    const s = await setup(t);
    const data = { ...s.data };
    delete data[slot];
    await fs.writeFile(path.join(s.root, 'run.json'), JSON.stringify(data));
    await assert.rejects(readRunDescriptor(s.root), (e) => e instanceof RunDescriptorError && e.message.includes(`actor "${slot}" is missing`));
  }
  const s = await setup(t);
  const data = { ...s.data };
  delete data.verifiers;
  await fs.writeFile(path.join(s.root, 'run.json'), JSON.stringify(data));
  await assert.rejects(readRunDescriptor(s.root), /"verifiers" must be an array/);
});

test('every required field is enforced, null stays legal only where the contract says so', async (t) => {
  const s = await setup(t);
  const rewrite = (mutate) => {
    const data = structuredClone(s.data);
    mutate(data);
    return fs.writeFile(path.join(s.root, 'run.json'), JSON.stringify(data));
  };
  for (const key of ['provider', 'runtime', 'transport', 'outputDir']) {
    await rewrite((d) => { delete d.seatA[key]; });
    await assert.rejects(readRunDescriptor(s.root), new RegExp(`actor "seatA" needs a non-empty string "${key}"`));
  }
  for (const key of ['effort', 'sessionId', 'resultPath', 'worktreePath']) {
    await rewrite((d) => { delete d.seatB[key]; });
    await assert.rejects(readRunDescriptor(s.root), new RegExp(`actor "seatB" is missing "${key}"`));
  }
  for (const key of ['skill', 'skillDir', 'targetDir', 'host']) {
    await rewrite((d) => { delete d[key]; });
    await assert.rejects(readRunDescriptor(s.root), new RegExp(`"${key}" must be a non-empty string`));
  }
  await rewrite((d) => { delete d.flags.mode; });
  await assert.rejects(readRunDescriptor(s.root), /flags\.mode is missing/);
  await rewrite((d) => { delete d.fingerprint; });
  await assert.rejects(readRunDescriptor(s.root), /"fingerprint" is missing/);
  await rewrite((d) => { d.seatA.role = 'B'; });
  await assert.rejects(readRunDescriptor(s.root), /has role "B", expected A/);
  await rewrite((d) => { d.seatA.outputDir = 'relative/dir'; });
  await assert.rejects(readRunDescriptor(s.root), /"outputDir" must be an absolute path/);
  await rewrite((d) => { d.seatA.runtime = 'mystery'; });
  await assert.rejects(readRunDescriptor(s.root), /unknown runtime "mystery"/);
  await rewrite((d) => { d.seatA.sessionId = 5; });
  await assert.rejects(readRunDescriptor(s.root), /"sessionId" must be a string or null/);
  await rewrite((d) => { d.verifiers = [d.auditor]; });
  await assert.rejects(readRunDescriptor(s.root), /expected \/\^verifier-/);
});

test('an unknown transport is refused and both known transports are accepted', async (t) => {
  const s = await setup(t);
  await fs.writeFile(path.join(s.root, 'run.json'), JSON.stringify({ ...s.data, seatA: { ...s.data.seatA, transport: 'carrier-pigeon' } }));
  await assert.rejects(readRunDescriptor(s.root), (e) => e instanceof RunDescriptorError && /unknown transport "carrier-pigeon"/.test(e.message));
  for (const transport of ['native', 'cli']) {
    await fs.writeFile(path.join(s.root, 'run.json'), JSON.stringify({ ...s.data, seatA: { ...s.data.seatA, transport } }));
    assert.equal((await readRunDescriptor(s.root)).seatA.transport, transport);
  }
});

test('channelFor: a Claude actor writes files, a Codex or OpenCode actor, the auditor included, returns its final message', () => {
  const base = { provider: 'anthropic', model: 'm', effort: null, transport: 'cli', sessionId: null, outputDir: '/x', resultPath: null, worktreePath: null };
  assert.equal(channelFor({ ...base, role: 'A', runtime: 'claude' }), 'file');
  assert.equal(channelFor({ ...base, role: 'A', runtime: 'claude', transport: 'native' }), 'file');
  assert.equal(channelFor({ ...base, role: 'auditor', runtime: 'claude' }), 'file');
  assert.equal(channelFor({ ...base, role: 'auditor', runtime: 'codex', provider: 'openai' }), 'final-message');
  assert.equal(channelFor({ ...base, role: 'B', runtime: 'codex', provider: 'openai' }), 'final-message');
  assert.equal(channelFor({ ...base, role: 'B', runtime: 'opencode' }), 'final-message');
  assert.equal(channelFor({ ...base, role: 'B', runtime: 'opencode', provider: 'anthropic' }), 'final-message');
  assert.equal(channelFor({ ...base, role: 'A', runtime: 'codex', provider: 'openai', transport: 'native' }), 'file', 'a native agent writes its own file whatever its vendor');
  assert.equal(channelFor({ ...base, role: 'auditor', runtime: 'codex', provider: 'openai', transport: 'native' }), 'file');
  assert.equal(channelFor({ ...base, role: 'B', runtime: 'codex', provider: 'openai', transport: 'cli' }), 'final-message', 'a CLI Codex actor still returns its final message');
  assert.throws(() => channelFor({ ...base, role: 'B', runtime: 'mystery' }), RunDescriptorError);
});

test('publishSeatOutput copies the exact bytes, reports both hashes and refuses to overwrite', async (t) => {
  const s = await setup(t);
  const desc = await readRunDescriptor(s.root);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Seat A findings\r\n\r\ncafé ✓ \r\n'), Buffer.from([0x00, 0xff, 0x0a])]);
  await fs.mkdir(seatOutputDir(desc, 'phase1', 'A'), { recursive: true });
  await fs.writeFile(path.join(seatOutputDir(desc, 'phase1', 'A'), 'A-findings.md'), bytes);
  const result = await publishSeatOutput(desc, 'phase1', 'A');
  assert.equal(result.destination, canonicalPath(desc, 'phase1', 'A'));
  assert.deepEqual(await fs.readFile(result.destination), bytes);
  assert.equal(result.sourceSha256, sha(bytes));
  assert.equal(result.destinationSha256, sha(bytes));
  await fs.writeFile(path.join(seatOutputDir(desc, 'phase1', 'A'), 'A-findings.md'), 'changed after publish');
  await assert.rejects(publishSeatOutput(desc, 'phase1', 'A'), /already exists; refusing to overwrite/);
  assert.deepEqual(await fs.readFile(result.destination), bytes, 'the published file is untouched by the refused call');
});

test('publishSeatOutput names a missing seat file and refuses seats that are not file-channel CLI seats', async (t) => {
  const s = await setup(t);
  const ok = await readRunDescriptor(s.root);
  await assert.rejects(publishSeatOutput(ok, 'phase2', 'A'), /A-rebuttals-raw\.md does not exist; seat A wrote no phase2 output/);
  await assert.rejects(publishSeatOutput(ok, 'phase2', 'B'), /seat B is not a file-channel CLI seat/);
  const native = { ...ok, seatA: { ...ok.seatA, transport: 'native' } };
  await assert.rejects(publishSeatOutput(native, 'phase1', 'A'), /is not a file-channel CLI seat/);
});

test('publishSeatOutput never reads a peer folder: only the named seat folder is touched', async (t) => {
  const s = await setup(t);
  const desc = await readRunDescriptor(s.root);
  await fs.mkdir(seatOutputDir(desc, 'phase1', 'A'), { recursive: true });
  await fs.writeFile(path.join(seatOutputDir(desc, 'phase1', 'A'), 'A-findings.md'), 'mine');
  await fs.mkdir(seatOutputDir(desc, 'phase1', 'B'), { recursive: true });
  await fs.writeFile(path.join(seatOutputDir(desc, 'phase1', 'B'), 'A-findings.md'), 'peer folder decoy');
  await publishSeatOutput(desc, 'phase1', 'A');
  assert.equal(await fs.readFile(canonicalPath(desc, 'phase1', 'A'), 'utf8'), 'mine');
});

test('assertGrantsIsolated accepts the private folders plus a declared source folder', async (t) => {
  const s = await setup(t);
  const source = path.join(s.base, 'source docs');
  await fs.mkdir(source);
  await fs.mkdir(path.join(s.root, 'phase1', 'seat-A'), { recursive: true });
  await fs.writeFile(path.join(s.root, 'phase1', 'B-findings.md'), 'peer file elsewhere in the run');
  const desc = await readRunDescriptor(s.root);
  await assertGrantsIsolated({ ...desc, sourceDirs: [source] });
});

test('assertGrantsIsolated rejects a grant that would expose a peer file, rebuttal, original folder or mapping file', async (t) => {
  const s = await setup(t);
  const desc = await readRunDescriptor(s.root);
  const run = desc.runDir;
  const grant = (folder, role = 'A') => ({ ...desc, [role === 'A' ? 'seatA' : 'seatB']: { ...desc[role === 'A' ? 'seatA' : 'seatB'], outputDir: folder } });
  await assert.rejects(assertGrantsIsolated(grant(path.join(run, 'phase1'))), /would expose .*B-findings\.md/);
  await assert.rejects(assertGrantsIsolated(grant(path.join(run, 'phase2'))), /would expose .*B-rebuttals-raw\.md/);
  await assert.rejects(assertGrantsIsolated(grant(run)), RunDescriptorError);
  await assert.rejects(assertGrantsIsolated(grant(path.join(run, 'phase1', 'original'))), /would expose .*original/);
  await assert.rejects(assertGrantsIsolated(grant(path.join(run, 'phase1', 'seat-B'))), /would expose .*seat-B/);
  await assert.rejects(assertGrantsIsolated(grant(path.join(run, 'phase3-private'))), /would expose .*phase3-private/);
  await assert.rejects(assertGrantsIsolated(grant(path.join(run, 'phase1'), 'B')), /would expose .*A-findings\.md/);
  await assert.rejects(assertGrantsIsolated({ ...desc, sourceDirs: [run] }), RunDescriptorError);
  await assert.rejects(assertGrantsIsolated({ ...desc, auditor: { ...desc.auditor, grantDirs: [path.join(run, 'phase1')] } }), /actor "auditor" is granted/);
});

test('assertGrantsIsolated finds forbidden files that already sit inside an own folder', async (t) => {
  for (const [name, dir] of [['B-findings.md', null], ['B-rebuttals-raw.md', null], ['seat-to-audit-label.json', null], [null, 'original']]) {
    const s = await setup(t);
    const own = path.join(s.root, 'phase1', 'seat-A');
    await fs.mkdir(own, { recursive: true });
    if (dir) await fs.mkdir(path.join(own, dir));
    else await fs.writeFile(path.join(own, name), 'x');
    const desc = await readRunDescriptor(s.root);
    await assert.rejects(assertGrantsIsolated(desc), (e) => e instanceof RunDescriptorError && /holds /.test(e.message), name ?? dir);
  }
});

test('a second process reading the same descriptor gets the identical seat table', async (t) => {
  const s = await setup(t);
  const here = seatTable(await readRunDescriptor(s.root));
  const code = "import(process.argv[1]).then(async (m) => { const d = await m.readRunDescriptor(process.argv[2]); process.stdout.write(JSON.stringify(m.seatTable(d))); });";
  const child = spawnSync(process.execPath, ['-e', code, MODULE_URL, s.root], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), JSON.parse(JSON.stringify(here)));
});

test('writeRunDescriptor writes run.json as UTF-8 without a BOM, returns the path and round-trips through the reader', async (t) => {
  const s = await setup(t);
  const run = path.join(s.base, 'new run');
  const file = await writeRunDescriptor(run, descriptor(run, s.target));
  assert.equal(file, path.join(path.resolve(run), 'run.json'));
  const bytes = await fs.readFile(file);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const desc = await readRunDescriptor(run);
  assert.equal(desc.seatB.model, 'model-two');
  assert.equal(desc.runDir, path.resolve(run));
});

test('writeRunDescriptor refuses to overwrite an existing run.json and leaves it untouched', async (t) => {
  const s = await setup(t);
  const before = await fs.readFile(path.join(s.root, 'run.json'));
  await assert.rejects(writeRunDescriptor(s.root, descriptor(s.root, s.target)), (e) => e instanceof RunDescriptorError && /refusing to overwrite/.test(e.message));
  assert.deepEqual(await fs.readFile(path.join(s.root, 'run.json')), before);
});

test('writeRunDescriptor applies the reader rules and writes nothing for an invalid descriptor', async (t) => {
  const s = await setup(t);
  const run = path.join(s.base, 'bad run');
  const bad = descriptor(run, s.target);
  delete bad.seatB;
  await assert.rejects(writeRunDescriptor(run, bad), (e) => e instanceof RunDescriptorError && /seatB/.test(e.message));
  await assert.rejects(writeRunDescriptor(run, descriptor(run, s.target, { host: '' })), /"host" must be a non-empty string/);
  await assert.rejects(fs.access(path.join(run, 'run.json')));
});

test('flags are validated: mode and audit depth are enums, falsification is a real boolean', async (t) => {
  const flags = (patch) => ({ auditDepth: 'light', falsification: false, mode: 'adversarial', ...patch });
  for (const [patch, message] of [
    [{ mode: 'friendly' }, /Invalid review mode/],
    [{ auditDepth: 'deep' }, /flags\.auditDepth must be light or full/],
    [{ falsification: 'false' }, /flags\.falsification must be the boolean/],
    [{ falsification: 0 }, /flags\.falsification must be the boolean/],
    [{ repoOnly: 'yes' }, /flags\.repoOnly must be a boolean/],
    [{ timeoutS: -1 }, /flags\.timeoutS must be a whole number/],
    [{ timeoutS: '30' }, /flags\.timeoutS must be a whole number/],
    [{ checklists: 'TARGET' }, /flags\.checklists must be a list/],
    [{ checklists: ['target'] }, /flags\.checklists must be a list/],
    [{ mode: 'collaborate' }, /Invalid review mode/],
  ]) {
    const s = await setup(t, { flags: flags(patch) });
    await assert.rejects(readRunDescriptor(s.root), (e) => e instanceof RunDescriptorError && message.test(e.message), JSON.stringify(patch));
  }
  const ok = await setup(t, { flags: flags({ falsification: true, repoOnly: true, timeoutS: 0, checklists: ['TARGET'] }) });
  assert.equal((await readRunDescriptor(ok.root)).flags.falsification, true);
});

test('the skill layout rules apply to run.json: vendor, runtime, distinct models and mode', async (t) => {
  const reject = async (patch, message, label) => {
    const s = await setup(t, patch);
    await assert.rejects(readRunDescriptor(s.root), (e) => e instanceof RunDescriptorError && message.test(e.message), label);
  };
  const codex = (root, role, model) => actor(root, role, { provider: 'openai', runtime: 'codex', model, transport: 'cli' });
  const root = '/r';
  await reject({ seatA: codex(root, 'A', 'gpt-5.6-sol') }, /Cross review requires seat A to run on the Claude harness/, 'cross-review with two OpenAI seats');
  await reject({ skill: 'pair-review' }, /one vendor/, 'pair-review mixing Claude and Codex');
  await reject({ skill: 'pair-review', seatB: actor(root, 'B', { model: 'model-one' }) }, /distinct/, 'pair-review with identical models');
  await reject({ skill: 'pair-review', seatA: actor(root, 'A', { runtime: 'codex' }), seatB: actor(root, 'B', { model: 'model-two' }) }, /not a supported pair/, 'anthropic provider with the codex runtime');
  await reject({ flags: { auditDepth: 'light', falsification: false, mode: 'none' } }, /Invalid review mode/, 'cross-review in a mode other than adversarial');
  const pair = await setup(t, { skill: 'pair-review', seatA: codex(root, 'A', 'gpt-5.6-sol'), seatB: codex(root, 'B', 'gpt-5.6-terra'), flags: { auditDepth: 'light', falsification: false, mode: 'collaborate' } });
  assert.equal((await readRunDescriptor(pair.root)).seatB.model, 'gpt-5.6-terra');
});

test('support rows: a native Codex pair on the Codex host is read only with support[] marking it a trial; the claude-code host refuses it', async (t) => {
  const root = '/r';
  const native = (role, model) => actor(root, role, { provider: 'openai', runtime: 'codex', model, transport: 'native' });
  const patch = { skill: 'pair-review', host: 'codex', seatA: native('A', 'gpt-5.6-sol'), seatB: native('B', 'gpt-5.6-terra'), auditor: native('auditor', 'gpt-5.6-sol'), flags: { auditDepth: 'light', falsification: false, mode: 'collaborate' } };
  const bare = await setup(t, patch);
  await assert.rejects(readRunDescriptor(bare.root), (e) => e instanceof RunDescriptorError && /is a trial route on host codex.*--allow-trial/.test(e.message));
  const rows = ['A', 'B', 'auditor'].map((role) => ({ role, runtime: 'codex', transport: 'native', status: 'trial' }));
  const trial = await setup(t, { ...patch, support: rows });
  const desc = await readRunDescriptor(trial.root);
  assert.deepEqual(seatTable(desc).map((row) => row.channel), ['file', 'file', 'file']);
  const wrong = await setup(t, { ...patch, host: 'claude-code', support: rows });
  await assert.rejects(readRunDescriptor(wrong.root), /native codex agent, but host claude-code can only start native claude agents/);
  const malformed = await setup(t, { ...patch, support: [{ role: 'A', status: 'maybe' }] });
  await assert.rejects(readRunDescriptor(malformed.root), /"support" must be a list/);
});
