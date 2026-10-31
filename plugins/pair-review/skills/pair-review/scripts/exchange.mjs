// Runs the documented commands around the Phase 2 exchange as one step each:
// "prepare" (validate, original/ copy, relabel + scan per direction, both delta
// briefs) and "finish" (append both rebuttal files, validate). Each step is the
// same blind-relabel.mjs / build-brief.mjs call the phase docs list.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { scrubDir } from './path-utils.mjs';
import { parseFenceLines, parseRebuttalEntries, runStep as relabelStep } from './blind-relabel.mjs';
import { runDirNamedIn, runStep as briefStep } from './build-brief.mjs';
import { makeIo, refuseDirectRun, runStep as runStepWith } from './step-io.mjs';
import {
  RunDescriptorError, readRunDescriptor, channelFor, privateOutputPath, publishSeatOutput, assertGrantsIsolated,
} from './run-descriptor.mjs';

class RelayError extends Error {}
const io = makeIo();
const REBUTTAL_HEADING = /^## Rebuttals \(from [AB]\) of [AB] claims\s*$/m;

// A shell variable a loop never expanded ("$S", "${S}", "$env:S", "%S%"); see build-brief.mjs.
const UNEXPANDED_VAR = /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%/;

function parseArgs(argv) {
  const args = { command: null, runDir: null, targetDir: null, tokens: null, sourceDirs: [], checklists: [], incompleteSeats: [] };
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
    else if (a === '--incomplete-seats' && args.command === 'finish') {
      // A seat whose Phase 2 cannot be resumed: its direction is skipped and the review is recorded as incomplete.
      for (const v of takeValue().split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!/^[AB]$/.test(v)) throw new RelayError(`--incomplete-seats must be A or B (both incomplete means there was no exchange), got "${v}"`);
        args.incompleteSeats.push(v);
      }
    } else {
      const otherOnly = { '--tokens': 'prepare', '--incomplete-seats': 'finish' }[a];
      const hint = otherOnly
        ? ` (only ${otherOnly} takes it)`
        : !a.startsWith('--') && argv[i - 1] !== undefined && /^--(source-dir|checklist)$/.test(argv[i - 2] ?? '')
          ? ` (${argv[i - 2]} takes one value; repeat the flag for each: ${argv[i - 2]} <a> ${argv[i - 2]} <b>)`
          : '';
      throw new RelayError(`unrecognized argument for ${args.command}: ${a}${hint}`);
    }
  }
  if (!args.runDir || !args.targetDir) throw new RelayError('--run-dir and --target-dir are both required');
  for (const [flag, value] of [['--run-dir', args.runDir], ['--target-dir', args.targetDir], ...args.sourceDirs.map((d) => ['--source-dir', d])]) {
    const hit = UNEXPANDED_VAR.exec(value);
    if (hit) throw new RelayError(`${flag} "${value}" contains "${hit[0]}", a shell variable that was never expanded; pass the real path`);
  }
  if (new Set(args.incompleteSeats).size === 2) throw new RelayError('--incomplete-seats cannot name both seats: with no rebuttals there was no exchange');
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

// A step's own output goes to stderr unchanged, so its refusal text is shown and stdout stays JSON.
const STEPS = { 'blind-relabel.mjs': relabelStep, 'build-brief.mjs': briefStep };
async function step(label, script, argv) {
  io.err(`exchange: ${label}\n`);
  const r = await STEPS[script](argv);
  io.err(r.all);
  return r.code === 0;
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

// Brief and output location per seat. Without run.json seat A is a file seat and seat B a final-message seat.
function seatPlans(args, p, desc) {
  const plans = {};
  for (const seat of ['A', 'B']) {
    const actor = desc?.[`seat${seat}`];
    const channel = actor ? channelFor(actor) : seat === 'A' ? 'file' : 'final-message';
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
  return plans;
}

// A findings or peer-view file with its fenced lines blanked: a heading quoted inside an evidence block is not structure.
const unfenced = (text) => parseFenceLines(text).lines.map((l) => (l.inFence ? '' : l.text)).join('\n');

async function hasRebuttalSection(file) {
  return REBUTTAL_HEADING.test(unfenced(await fs.readFile(file, 'utf8')));
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
  if (!await step('validate both seats', 'blind-relabel.mjs', ['validate', '--phase1-dir', p.phase1, ...sharedFlags(args), ...packetFlag])) {
    throw new RelayError('validate failed; return the named seat\'s file to its own context, then rerun prepare');
  }
  // A redaction before the exchange is still the independent pass, so original/ is replaced.
  await fs.mkdir(p.original, { recursive: true });
  for (const seat of ['A', 'B']) await fs.copyFile(p.findings[seat], path.join(p.original, `${seat}-findings.md`));
  await fs.mkdir(p.phase2, { recursive: true });
  const failed = [];
  for (const [src, dst] of [['A', 'B'], ['B', 'A']]) {
    const out = p.peerView[dst];
    const relabeled = await step(`relabel seat ${src} -> ${path.basename(out)}`, 'blind-relabel.mjs', ['relabel', '--in', p.findings[src], '--out', out, '--from', src, '--to', 'P']);
    let runPathLeft = null;
    if (relabeled) {
      const scrubbed = scrubDir(await fs.readFile(out, 'utf8'), args.runDir);
      if (scrubbed.count > 0) {
        await fs.writeFile(out, scrubbed.text, 'utf8');
        io.err(`exchange: ${scrubbed.count} run-folder path(s) in seat ${src}'s file written as <run-dir> in ${path.basename(out)}\n`);
      }
      // The run-folder guard reads every other spelling (~, variables, a drive-less or short name, a link): one left stops.
      runPathLeft = runDirNamedIn(scrubbed.text, args.runDir, args.targetDir);
      if (runPathLeft) io.err(`exchange: seat ${src}'s file still names the run folder (${runPathLeft.leaked}${runPathLeft.resolved ? ', which resolves into it' : ''}); return it to the seat to cite the path another way\n`);
    }
    const scanned = relabeled && !runPathLeft && await step(`scan ${path.basename(out)}`, 'blind-relabel.mjs', [
      'scan', '--in', out, ...sharedFlags(args), '--tokens', args.tokens, '--phase1-dir', p.phase1, '--forbid-seats', src,
    ]);
    if (!scanned) {
      await fs.rm(out, { force: true });
      failed.push(`seat ${src} (${!relabeled ? 'relabel failed' : runPathLeft ? 'run-folder path' : 'scan hit'}; ${path.basename(out)} deleted)`);
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
    if (!await step(`build seat ${seat} delta brief`, 'build-brief.mjs', argv)) {
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
  return (unfenced(peerViewText).match(/^## P\d+\b/gm) ?? []).length;
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
      throw new RelayError(`${p.raw[seat]} does not exist${source ? ` (a CLI seat writes ${source} first)` : ''}; wait for seat ${seat}, or, if it cannot be resumed, finish without it (review-run phase2 --wait --incomplete-seat ${seat}), which makes the review incomplete`);
    }
    if (!(await exists(p.peerView[seat]))) throw new RelayError(`${p.peerView[seat]} does not exist; it is the peer view seat ${seat} rebutted`);
  }
  const before = { A: await fs.readFile(p.findings.A), B: await fs.readFile(p.findings.B) };
  const restore = async () => {
    for (const seat of ['A', 'B']) await fs.writeFile(p.findings[seat], before[seat]);
  };
  for (const seat of seats) {
    const peer = seat === 'A' ? 'B' : 'A';
    const ok = await step(`append seat ${seat}'s rebuttals onto ${path.basename(p.findings[peer])}`, 'blind-relabel.mjs', [
      'append-rebuttals', '--in', p.raw[seat], '--onto', p.findings[peer], '--rebutter', seat, '--peer-view', p.peerView[seat], ...sharedFlags(args),
    ]);
    if (!ok) {
      await restore();
      throw new RelayError(`append-rebuttals refused seat ${seat}'s rebuttals; both findings files were restored. Send the correction request to seat ${seat}`);
    }
  }
  if (!await step('validate after the exchange', 'blind-relabel.mjs', ['validate', '--phase1-dir', p.phase1, ...sharedFlags(args)])) {
    await restore();
    throw new RelayError('validate failed after appending; both findings files were restored');
  }
  const actions = { concede: 0, dispute: 0 };
  for (const seat of seats) {
    // The same parser append-rebuttals used, so an entry counts here exactly when it was accepted there
    // (a "## P<n>" heading, or a headingless "Claim: P<n>" entry, as well as "### P<n>").
    const entries = parseRebuttalEntries(parseFenceLines(await fs.readFile(p.raw[seat], 'utf8')).lines, 'P');
    for (const entry of entries) {
      if (entry.action === 'CONCEDE' || entry.action === 'DISPUTE') actions[entry.action.toLowerCase()]++;
    }
  }
  const result = { appended: seats, incomplete: [...new Set(args.incompleteSeats)], no_peer_claims: noPeerClaims, ...actions };
  if (Object.keys(published).length > 0) result.published = published;
  // audit-prep reads this to tell a declared incomplete seat from a finish that never succeeded.
  // Through a temp file and a rename: review-run treats this file as the finished exchange.
  const resultFile = path.join(p.phase2, 'exchange-result.json');
  await fs.writeFile(`${resultFile}.tmp-${process.pid}`, `${JSON.stringify(result, null, 2)}\n`);
  await fs.rename(`${resultFile}.tmp-${process.pid}`, resultFile);
  return result;
}

async function main(argv) {
  try {
    const args = parseArgs(argv);
    const result = args.command === 'prepare' ? await prepare(args) : await finish(args);
    io.out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof RelayError) {
      io.err(`exchange: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// One exchange step in-process: { code, stdout, stderr }.
const runStep = (argv) => runStepWith('exchange', io, main, argv);

export { parseArgs, prepare, finish, RelayError, runStep };

refuseDirectRun(import.meta.url, 'exchange.mjs');
