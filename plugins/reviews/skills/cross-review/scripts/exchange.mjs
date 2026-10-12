#!/usr/bin/env node
// Runs the documented commands around the Phase 2 exchange as one step each:
// "prepare" (validate, original/ copy, relabel + scan per direction, both delta
// briefs) and "finish" (append both rebuttal files, validate). Each step is the
// same blind-relabel.mjs / build-brief.mjs call the phase docs list.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  RunDescriptorError, readRunDescriptor, channelFor, privateOutputPath, publishSeatOutput, assertGrantsIsolated,
} from './run-descriptor.mjs';

class RelayError extends Error {}

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REBUTTAL_HEADING = /^## Rebuttals \(from [AB]\) of [AB] claims\s*$/m;

const USAGE = `exchange.mjs -- the Phase 2 exchange steps as one command each.

Usage:
  node exchange.mjs prepare --run-dir <dir> --target-dir <dir> --tokens <seat-a-model>,<seat-b-model>
                    [--source-dir <dir>]... [--checklist NAME]... [--seat-b-harness]
  node exchange.mjs finish  --run-dir <dir> --target-dir <dir>
                    [--source-dir <dir>]... [--checklist NAME]... [--incomplete-seats A|B]

prepare runs, in order: validate (both seats); copy both findings files to
phase1/original/; relabel + scan seat A's file into phase2/peer-view-for-B.md,
then seat B's into phase2/peer-view-for-A.md; build both delta briefs. A scan
hit deletes that peer view and no brief is built; the other direction is still
checked and reported. Seat A's brief is phase2/delta-brief-A.txt and it writes
phase2/A-rebuttals-raw.md. Seat B's brief is phase2/B/delta-brief.txt (its
dispatcher returns the text: pass it --final-message-out
phase2/B-rebuttals-raw.md, which is why the output says rebuttals.B null), or with
--seat-b-harness phase2/delta-brief-B.txt writing phase2/B-rebuttals-raw.md.
When <run-dir>/run.json exists it decides each seat's channel and --seat-b-harness is only an alias
(seat B uses the file channel): a file-channel seat gets phase2/delta-brief-<seat>.txt, and a CLI one
writes phase2/seat-<seat>/<seat>-rebuttals-raw.md, which finish copies to the canonical path; a
final-message seat gets phase2/<seat>/delta-brief.txt. A seat whose peer wrote "## No findings"
has nothing to rebut: it gets no brief, and the
output names it under "skipped". prepare refuses once the exchange has
started: a delta brief or a rebuttal file exists, or a findings file already
has a rebuttal section.

finish appends phase2/A-rebuttals-raw.md onto phase1/B-findings.md and
phase2/B-rebuttals-raw.md onto phase1/A-findings.md with append-rebuttals, then
runs validate. --incomplete-seats names a seat whose rebuttals do not exist (its
Phase 2 is incomplete); that direction is skipped. A seat whose peer view has no
claims is skipped too and listed under "no_peer_claims": it is complete with
nothing to rebut, not incomplete. Both findings files are
restored if any step fails, so a rerun starts clean. finish refuses a findings
file that already has a rebuttal section: restore phase1/*-findings.md from
phase1/original/ first. It prints the CONCEDE and DISPUTE counts, with a
WARNING when every rebuttal conceded.

--source-dir and --checklist are passed to every step that accepts them. Each takes one
value; repeat the flag: --source-dir <a> --source-dir <b>. --tokens is prepare only.
Exit 0 on success, 1 on a refusal or a failed step.
`;

// A shell variable a loop never expanded ("$S", "${S}", "$env:S", "%S%"); see build-brief.mjs.
const UNEXPANDED_VAR = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%/;

function parseArgs(argv) {
  const args = { command: null, runDir: null, targetDir: null, tokens: null, sourceDirs: [], checklists: [], seatBHarness: false, incompleteSeats: [] };
  if (argv[0] === '-h' || argv[0] === '--help') return { help: true };
  args.command = argv[0];
  if (args.command !== 'prepare' && args.command !== 'finish') throw new RelayError(`first argument must be prepare or finish, got ${args.command ?? 'nothing'}`);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new RelayError(`${a} requires a value`);
      return v;
    };
    if (a === '--run-dir') args.runDir = takeValue();
    else if (a === '--target-dir') args.targetDir = takeValue();
    else if (a === '--tokens' && args.command === 'prepare') args.tokens = takeValue();
    else if (a === '--source-dir') args.sourceDirs.push(takeValue());
    else if (a === '--checklist') args.checklists.push(takeValue());
    else if (a === '--seat-b-harness' && args.command === 'prepare') args.seatBHarness = true;
    else if (a === '--incomplete-seats' && args.command === 'finish') {
      const v = takeValue();
      if (!/^[AB]$/.test(v)) throw new RelayError(`--incomplete-seats must be A or B (both incomplete means there was no exchange), got "${v}"`);
      args.incompleteSeats.push(v);
    }
    else if (a === '-h' || a === '--help') return { help: true };
    else {
      const otherOnly = { '--tokens': 'prepare', '--seat-b-harness': 'prepare', '--incomplete-seats': 'finish' }[a];
      const hint = otherOnly
        ? ` (only ${otherOnly} takes it)`
        : !a.startsWith('--') && argv[i - 1] !== undefined && /^--(source-dir|checklist)$/.test(argv[i - 2] ?? '')
          ? ` (${argv[i - 2]} takes one value; repeat the flag for each: ${argv[i - 2]} <a> ${argv[i - 2]} <b>)`
          : '';
      throw new RelayError(`unrecognized argument for ${args.command}: ${a}${hint}`);
    }
  }
  if (new Set(args.incompleteSeats).size === 2) throw new RelayError('--incomplete-seats cannot name both seats: with no rebuttals there was no exchange');
  if (!args.runDir || !args.targetDir) throw new RelayError('--run-dir and --target-dir are both required');
  for (const [flag, value] of [['--run-dir', args.runDir], ['--target-dir', args.targetDir], ...args.sourceDirs.map((d) => ['--source-dir', d])]) {
    const hit = UNEXPANDED_VAR.exec(value);
    if (hit) throw new RelayError(`${flag} "${value}" contains "${hit[0]}", a shell variable that was never expanded; pass the real path`);
  }
  if (args.command === 'prepare' && !args.tokens) throw new RelayError('prepare requires --tokens <seat-a-model>,<seat-b-model>, the same value every scan takes');
  return args;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function sharedFlags(args) {
  return [
    '--target-dir', args.targetDir,
    ...args.sourceDirs.flatMap((d) => ['--source-dir', d]),
    ...args.checklists.flatMap((c) => ['--checklist', c]),
  ];
}

// Child output goes to stderr unchanged, so each step's own refusal text is shown and stdout stays JSON.
function step(label, script, argv) {
  process.stderr.write(`exchange: ${label}\n`);
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...argv], { stdio: ['ignore', 2, 2] });
  if (r.error) throw new RelayError(`${label}: could not start ${script}: ${r.error.message}`);
  return r.status === 0;
}

function paths(runDir) {
  const p1 = path.join(runDir, 'phase1');
  const p2 = path.join(runDir, 'phase2');
  return {
    phase1: p1,
    phase2: p2,
    original: path.join(p1, 'original'),
    findings: { A: path.join(p1, 'A-findings.md'), B: path.join(p1, 'B-findings.md') },
    peerView: { A: path.join(p2, 'peer-view-for-A.md'), B: path.join(p2, 'peer-view-for-B.md') },
    raw: { A: path.join(p2, 'A-rebuttals-raw.md'), B: path.join(p2, 'B-rebuttals-raw.md') },
  };
}

function runDescriptorError(err) {
  return err instanceof RunDescriptorError ? new RelayError(err.message) : err;
}

async function loadDescriptor(runDir) {
  if (!(await exists(path.join(runDir, 'run.json')))) return null;
  try {
    return await readRunDescriptor(runDir);
  } catch (err) {
    throw runDescriptorError(err);
  }
}

// Brief and output location per seat. Without run.json seat A is a file seat and seat B follows --seat-b-harness.
function seatPlans(args, p, desc) {
  const plans = {};
  for (const seat of ['A', 'B']) {
    const actor = desc?.[`seat${seat}`];
    const channel = actor ? channelFor(actor) : seat === 'A' || args.seatBHarness ? 'file' : 'final-message';
    const cli = actor?.transport === 'cli' && channel === 'file';
    plans[seat] = {
      channel,
      publish: cli,
      brief: channel === 'file' ? path.join(p.phase2, `delta-brief-${seat}.txt`) : path.join(p.phase2, seat, 'delta-brief.txt'),
      altBrief: channel === 'file' ? path.join(p.phase2, seat, 'delta-brief.txt') : path.join(p.phase2, `delta-brief-${seat}.txt`),
      privateRaw: cli ? privateOutputPath(desc, 'phase2', seat) : null,
      outputPath: channel !== 'file' ? null : cli ? privateOutputPath(desc, 'phase2', seat) : p.raw[seat],
    };
  }
  if (desc && args.seatBHarness && plans.B.channel !== 'file') {
    throw new RelayError('--seat-b-harness says seat B uses the file channel, but run.json makes it a final-message seat; drop the flag, run.json decides');
  }
  return plans;
}

async function hasRebuttalSection(file) {
  return REBUTTAL_HEADING.test(await fs.readFile(file, 'utf8'));
}

async function prepare(args) {
  const p = paths(args.runDir);
  const desc = await loadDescriptor(args.runDir);
  if (desc) {
    try {
      await assertGrantsIsolated(desc);
    } catch (err) {
      throw runDescriptorError(err);
    }
  }
  const plans = seatPlans(args, p, desc);
  for (const f of [plans.A.brief, plans.B.brief, plans.A.altBrief, plans.B.altBrief, p.raw.A, p.raw.B, plans.A.privateRaw, plans.B.privateRaw]) {
    if (f && await exists(f)) throw new RelayError(`${f} exists, so the exchange was already prepared or has started; prepare builds a fresh exchange only (delete the briefs yourself only if no seat has been sent one)`);
  }
  for (const seat of ['A', 'B']) {
    if (!(await exists(p.findings[seat]))) throw new RelayError(`${p.findings[seat]} does not exist`);
    if (await hasRebuttalSection(p.findings[seat])) {
      throw new RelayError(`${p.findings[seat]} already has a rebuttal section, so the exchange happened; phase1/original/ must keep the pre-exchange copies`);
    }
  }
  // The packet lets validate tell which of several same-named files a bare citation means.
  const packet = path.join(args.runDir, 'task-packet.md');
  const packetFlag = (await exists(packet)) ? ['--packet', packet] : [];
  if (!step('validate both seats', 'blind-relabel.mjs', ['validate', '--phase1-dir', p.phase1, ...sharedFlags(args), ...packetFlag])) {
    throw new RelayError('validate failed; return the named seat\'s file to its own context, then rerun prepare');
  }
  // A redaction before the exchange is still the independent pass, so original/ is replaced.
  await fs.mkdir(p.original, { recursive: true });
  for (const seat of ['A', 'B']) await fs.copyFile(p.findings[seat], path.join(p.original, `${seat}-findings.md`));
  await fs.mkdir(p.phase2, { recursive: true });
  const failed = [];
  for (const [src, dst] of [['A', 'B'], ['B', 'A']]) {
    const out = p.peerView[dst];
    const relabeled = step(`relabel seat ${src} -> ${path.basename(out)}`, 'blind-relabel.mjs', ['relabel', '--in', p.findings[src], '--out', out, '--from', src, '--to', 'P']);
    const scanned = relabeled && step(`scan ${path.basename(out)}`, 'blind-relabel.mjs', [
      'scan', '--in', out, ...sharedFlags(args), '--tokens', args.tokens, '--phase1-dir', p.phase1, '--forbid-seats', src,
    ]);
    if (!scanned) {
      await fs.rm(out, { force: true });
      failed.push(`seat ${src} (${relabeled ? 'scan hit' : 'relabel failed'}; ${path.basename(out)} deleted)`);
    }
  }
  if (failed.length > 0) {
    const clean = ['A', 'B'].filter((s) => !failed.some((f) => f.startsWith(`seat ${s} `)));
    throw new RelayError(`no brief was built. Return to ${failed.join(' and ')} for one redaction round (splice, never a hand edit), then rerun prepare${clean.length ? `; seat ${clean[0]}'s file was clean` : ''}`);
  }
  // A seat whose peer wrote "## No findings" has nothing to rebut, so it gets no brief.
  const skipped = {};
  for (const seat of ['A', 'B']) {
    if (peerClaimCount(await fs.readFile(p.peerView[seat], 'utf8')) === 0) skipped[seat] = `seat ${seat === 'A' ? 'B' : 'A'} has no findings`;
  }
  const out = { briefs: { A: null, B: null }, rebuttals: { A: null, B: null }, skipped };
  if (desc) out.channels = { A: plans.A.channel, B: plans.B.channel };
  for (const seat of ['A', 'B']) {
    if (skipped[seat]) continue;
    const plan = plans[seat];
    await fs.mkdir(plan.channel === 'final-message' ? path.dirname(plan.brief) : plan.privateRaw ? path.dirname(plan.privateRaw) : p.phase2, { recursive: true });
    const argv = ['--mode', 'delta', '--peer-view', p.peerView[seat], '--out', plan.brief, '--channel', plan.channel];
    if (plan.outputPath) argv.push('--output-path', plan.outputPath);
    if (!step(`build seat ${seat} delta brief`, 'build-brief.mjs', argv)) {
      if (seat === 'A') throw new RelayError('build-brief failed for seat A');
      await fs.rm(plans.A.brief, { force: true });
      throw new RelayError('build-brief failed for seat B; seat A\'s brief was removed so a rerun starts clean');
    }
    out.briefs[seat] = plan.brief;
    out.rebuttals[seat] = plan.outputPath;
  }
  return out;
}

function peerClaimCount(peerViewText) {
  return (peerViewText.match(/^## P\d+\b/gm) ?? []).length;
}

async function finish(args) {
  const p = paths(args.runDir);
  // A seat with no peer claims completed its exchange with nothing to rebut; that is not incomplete.
  const noPeerClaims = [];
  for (const seat of ['A', 'B']) {
    if ((await exists(p.peerView[seat])) && peerClaimCount(await fs.readFile(p.peerView[seat], 'utf8')) === 0) noPeerClaims.push(seat);
  }
  const seats = ['A', 'B'].filter((s) => !args.incompleteSeats.includes(s) && !noPeerClaims.includes(s));
  for (const seat of ['A', 'B']) {
    if (!(await exists(p.findings[seat]))) throw new RelayError(`${p.findings[seat]} does not exist`);
    if (await hasRebuttalSection(p.findings[seat])) {
      throw new RelayError(`${p.findings[seat]} already has a rebuttal section; restore both phase1/*-findings.md from phase1/original/ before rerunning finish`);
    }
  }
  const desc = await loadDescriptor(args.runDir);
  const published = {};
  for (const seat of seats) {
    const actor = desc?.[`seat${seat}`];
    const source = actor?.transport === 'cli' && channelFor(actor) === 'file' ? privateOutputPath(desc, 'phase2', seat) : null;
    if (source && (await exists(source))) {
      // A refused append restores both findings files, so an earlier published copy is only an input: keep it and publish the corrected one.
      if ((await exists(p.raw[seat])) && !(await fs.readFile(p.raw[seat])).equals(await fs.readFile(source))) {
        const ext = path.extname(p.raw[seat]);
        const stem = p.raw[seat].slice(0, p.raw[seat].length - ext.length);
        let n = 1;
        while (await exists(`${stem}.attempt-${n}${ext}`)) n += 1;
        await fs.rename(p.raw[seat], `${stem}.attempt-${n}${ext}`);
      }
      if (!(await exists(p.raw[seat]))) {
        try {
          const copy = await publishSeatOutput(desc, 'phase2', seat);
          published[seat] = { source: copy.source, destination: copy.destination, sha256: copy.destinationSha256 };
        } catch (err) {
          throw runDescriptorError(err);
        }
      }
    }
    if (!(await exists(p.raw[seat]))) {
      throw new RelayError(`${p.raw[seat]} does not exist${source ? ` (a CLI seat writes ${source} first)` : ''}; wait for seat ${seat}, or pass --incomplete-seats ${seat} if its exchange cannot be completed (see the exchange step's recovery rule)`);
    }
    if (!(await exists(p.peerView[seat]))) throw new RelayError(`${p.peerView[seat]} does not exist; it is the peer view seat ${seat} rebutted`);
  }
  const before = { A: await fs.readFile(p.findings.A), B: await fs.readFile(p.findings.B) };
  const restore = async () => {
    for (const seat of ['A', 'B']) await fs.writeFile(p.findings[seat], before[seat]);
  };
  for (const seat of seats) {
    const peer = seat === 'A' ? 'B' : 'A';
    const ok = step(`append seat ${seat}'s rebuttals onto ${path.basename(p.findings[peer])}`, 'blind-relabel.mjs', [
      'append-rebuttals', '--in', p.raw[seat], '--onto', p.findings[peer], '--rebutter', seat, '--peer-view', p.peerView[seat], ...sharedFlags(args),
    ]);
    if (!ok) {
      await restore();
      throw new RelayError(`append-rebuttals refused seat ${seat}'s rebuttals; both findings files were restored. Send the correction request to seat ${seat}`);
    }
  }
  if (!step('validate after the exchange', 'blind-relabel.mjs', ['validate', '--phase1-dir', p.phase1, ...sharedFlags(args)])) {
    await restore();
    throw new RelayError('validate failed after appending; both findings files were restored');
  }
  const actions = { concede: 0, dispute: 0 };
  const perSeat = {};
  for (const seat of seats) {
    perSeat[seat] = { concede: 0, dispute: 0 };
    for (const [, act] of (await fs.readFile(p.raw[seat], 'utf8')).matchAll(/^Action:\s*(CONCEDE|DISPUTE)\b/gm)) {
      actions[act.toLowerCase()]++;
      perSeat[seat][act.toLowerCase()]++;
    }
  }
  for (const seat of seats) {
    if (perSeat[seat].dispute === 0 && perSeat[seat].concede >= 3) {
      process.stderr.write(`exchange: WARNING: seat ${seat} conceded all ${perSeat[seat].concede} peer claims; the exchange added little for that side: consider --audit-depth full\n`);
    }
  }
  // Agreement is not a check: with no dispute, a light audit re-checks nothing.
  if (actions.dispute === 0 && actions.concede > 0) {
    process.stderr.write(`exchange: WARNING: all ${actions.concede} rebuttals conceded and none disputed; a light audit would re-check none of these findings, so use --audit-depth full (nothing to do if it is already full)\n`);
  }
  const result = { appended: seats, incomplete: args.incompleteSeats, no_peer_claims: noPeerClaims, ...actions };
  if (Object.keys(published).length > 0) result.published = published;
  // audit-prep reads this to tell a declared incomplete seat from a finish that never succeeded.
  await fs.writeFile(path.join(p.phase2, 'exchange-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const result = args.command === 'prepare' ? await prepare(args) : await finish(args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof RelayError) {
      process.stderr.write(`exchange: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

const isDirectRun = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().then((code) => process.exit(code), (err) => {
    process.stderr.write(`exchange: unexpected failure: ${err.stack || err}\n`);
    process.exit(1);
  });
}

export { parseArgs, prepare, finish, RelayError };
