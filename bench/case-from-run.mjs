#!/usr/bin/env node
// Turns a finished review run into a bench case: case.json (target, scope, the packet) and ground-truth.json (one defect per
// finding both seats or the auditor settled as real). Every defect starts with confirmed_by null until a person checks it.

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evidenceLocations, findingStatus, notesSections, outcomeOf } from '../plugins/pair-review/skills/pair-review/scripts/build-report.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const USAGE = 'Usage: node bench/case-from-run.mjs --run-dir <run> --target <snapshot dir> --out <cases root>/<id> [--outcomes] [--public]\n' +
  '--outcomes  also take findings the run\'s report notes mark "fixed", and leave out ones marked "wrong".\n' +
  '--public    allow --out inside this repository (refused by default: review targets and findings can be private).\n';

class CaseError extends Error {}

export function parseArgs(argv) {
  const args = { runDir: null, target: null, out: null, outcomes: false, public: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new CaseError(`${tok} requires a value`);
      return v;
    };
    if (tok === '--run-dir') args.runDir = value();
    else if (tok === '--target') args.target = value();
    else if (tok === '--out') args.out = value();
    else if (tok === '--outcomes') args.outcomes = true;
    else if (tok === '--public') args.public = true;
    else if (tok === '-h' || tok === '--help') args.help = true;
    else throw new CaseError(`unrecognized argument: ${tok}`);
  }
  if (!args.help && (!args.runDir || !args.target || !args.out)) throw new CaseError('--run-dir, --target and --out are required');
  return args;
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// A finding counts as a known defect when it was settled as real (settled-agree), or, with outcomes, when the author fixed it;
// an author's "wrong" removes it.
export function groundTruth(findingsDoc, notesText = '', useOutcomes = false) {
  const outcomes = new Map();
  if (useOutcomes) for (const [id, status] of findingStatus(notesSections(notesText)['finding status'] ?? '')) outcomes.set(id, outcomeOf(status)?.word ?? null);
  const defects = [];
  for (const f of findingsDoc?.findings ?? []) {
    const outcome = outcomes.get(f.id) ?? null;
    if (outcome === 'wrong') continue;
    if (f.final_state !== 'settled-agree' && outcome !== 'fixed') continue;
    const severity = String(f.severity_audited ?? f.severity ?? '').toUpperCase();
    const hints = [...new Set(evidenceLocations(f.evidence).map((loc) => {
      const m = /^(.*?)([^\\/]+):(\d+)$/.exec(loc);
      return m ? `${m[2]}:${m[3]}` : loc;
    }))];
    defects.push({
      id: `D${defects.length + 1}`,
      description: String(f.summary || f.title || '').replace(/\s+/g, ' ').trim(),
      ...(SEVERITIES.includes(severity) ? { severity } : {}),
      matches: hints,
      source_finding: f.id,
      confirmed_by: null,
    });
  }
  return { defects };
}

const scopeOf = (packet) => /^##\s+Scope\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(packet)?.[1].trim() || null;

export async function buildCase(args) {
  const run = path.resolve(args.runDir);
  const out = path.resolve(args.out);
  if (inside(out, REPO_ROOT) && !args.public) throw new CaseError(`--out ${out} is inside the SkillArray repository; a case holds review targets and findings that may be private. Write it elsewhere, or add --public`);
  // Nothing is written into a folder that already holds any of the three files.
  for (const name of ['case.json', 'task-packet.md', 'ground-truth.json']) {
    if (existsSync(path.join(out, name))) throw new CaseError(`${path.join(out, name)} already exists; it is never overwritten (nothing was written)`);
  }
  const read = async (file, what) => {
    try {
      return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    } catch (err) {
      throw new CaseError(`cannot read ${what} ${file}: ${err.message}`);
    }
  };
  const findingsDoc = JSON.parse(await read(path.join(run, 'phase3', 'findings.json'), 'the run\'s findings'));
  const packetFile = path.join(run, 'task-packet.md');
  const packet = await read(packetFile, 'the run\'s task packet');
  const notesFile = path.join(run, 'phase3', 'report-notes.md');
  const notes = existsSync(notesFile) ? await read(notesFile, 'the report notes') : '';
  const truth = groundTruth(findingsDoc, notes, args.outcomes);
  await mkdir(out, { recursive: true });
  await copyFile(packetFile, path.join(out, 'task-packet.md'), fsConstants.COPYFILE_EXCL);
  const caseJson = {
    id: path.basename(out),
    description: `Built from review run ${path.basename(run)}; every defect needs a person to confirm it (confirmed_by).`,
    target: path.resolve(args.target),
    scope: scopeOf(packet),
    packet: 'task-packet.md',
    source_run: run,
  };
  // case.json last: a folder with it is a complete case.
  await writeFile(path.join(out, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(out, 'case.json'), `${JSON.stringify(caseJson, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { out, defects: truth.defects.length };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const { out, defects } = await buildCase(args);
  process.stdout.write(`case-from-run: wrote ${out} with ${defects} defect(s); set confirmed_by on each after checking it\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`case-from-run: ${err.message}\n`);
    process.exitCode = err instanceof CaseError ? 1 : 2;
  });
}
