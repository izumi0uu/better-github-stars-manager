#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DECISIONS = new Set(['proceed', 'wait', 'rebase', 'split', 'handoff', 'accepted-risk']);

export const MERGE_SENSITIVE_SURFACES = [
  { surface: 'package', test: (file) => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(file) },
  { surface: 'build', test: (file) => ['vite.config.ts', 'manifest.config.ts'].includes(file) || file.startsWith('scripts/') },
  { surface: 'ci', test: (file) => file.startsWith('.github/workflows/') },
  { surface: 'tests', test: (file) => file.startsWith('tests/') },
  { surface: 'background', test: (file) => file.startsWith('src/background/') },
  { surface: 'messaging', test: (file) => file === 'src/utils/messaging.ts' },
  { surface: 'ui', test: (file) => file.startsWith('src/ui/') },
  { surface: 'types', test: (file) => file === 'src/types/index.ts' },
  { surface: 'storage', test: (file) => file.startsWith('src/storage/') || file.startsWith('src/upgrades/') },
  { surface: 'auth', test: (file) => file.startsWith('src/auth/') },
  { surface: 'api', test: (file) => file.startsWith('src/api/') || file.startsWith('src/sync/') },
  { surface: 'content', test: (file) => file.startsWith('src/content/') },
];

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: options.cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.allowFailure ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

export function classifyPath(file) {
  return MERGE_SENSITIVE_SURFACES.filter((entry) => entry.test(file)).map((entry) => entry.surface);
}

export function parseWorktreePorcelain(output) {
  const worktrees = [];
  let current = null;

  for (const line of output.split('\n')) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ');

    if (key === 'worktree') current = { path: value, head: '', branch: '', prunable: false };
    else if (current && key === 'HEAD') current.head = value;
    else if (current && key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (current && key === 'prunable') current.prunable = true;
  }

  if (current) worktrees.push(current);
  return worktrees;
}

export function parseNameStatus(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      const file = status.startsWith('R') || status.startsWith('C') ? parts[2] : parts[1];
      return { status, file };
    });
}

export function branchState(leftOnly, rightOnly) {
  if (leftOnly === 0 && rightOnly === 0) return 'up-to-date';
  if (leftOnly === 0) return 'ahead';
  if (rightOnly === 0) return 'behind';
  return 'diverged';
}

export function buildLedger(input) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const ttlHours = input.ttlHours ?? 24;
  const expiresAt = new Date(Date.parse(generatedAt) + ttlHours * 60 * 60 * 1000).toISOString();
  const plannedPaths = [...new Set(input.plannedPaths ?? [])].sort();
  const agentChanges = input.agentChanges ?? [];
  const decisionMap = input.decisionMap ?? {};
  const changedByPath = new Map(agentChanges.map((change) => [change.file, change]));

  const collisions = plannedPaths
    .filter((file) => changedByPath.has(file))
    .map((file) => {
      const decision = decisionMap[file] ?? {};
      return {
        path: file,
        agentStatus: changedByPath.get(file).status,
        surfaces: classifyPath(file),
        owner: decision.owner ?? null,
        decision: decision.decision ?? null,
      };
    });

  return {
    schemaVersion: 1,
    generatedAt,
    freshnessTtlHours: ttlHours,
    expiresAt,
    baseRef: input.baseRef,
    baseHead: input.baseHead,
    agentRef: input.agentRef,
    agentHead: input.agentHead,
    mergeBase: input.mergeBase,
    branchStatus: {
      leftOnly: input.leftOnly,
      rightOnly: input.rightOnly,
      state: branchState(input.leftOnly, input.rightOnly),
    },
    worktrees: input.worktrees ?? [],
    plannedPaths: plannedPaths.map((file) => ({ path: file, surfaces: classifyPath(file) })),
    agentChangedPaths: agentChanges.map((change) => ({ ...change, surfaces: classifyPath(change.file) })),
    collisions,
    passed: collisions.every((collision) => collision.owner && DECISIONS.has(collision.decision)),
  };
}

function parseArgs(argv) {
  const args = {
    baseRef: 'develop',
    agentRef: 'feat/agent-tag-assistant',
    plannedPaths: [],
    ttlHours: 24,
    decisionFile: '',
    output: '',
    format: 'json',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') args.baseRef = argv[++i];
    else if (arg === '--agent') args.agentRef = argv[++i];
    else if (arg === '--planned') args.plannedPaths.push(...argv[++i].split(',').map((item) => item.trim()).filter(Boolean));
    else if (arg === '--planned-file') {
      args.plannedPaths.push(...readFileSync(argv[++i], 'utf8').split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
    } else if (arg === '--decision-file') args.decisionFile = argv[++i];
    else if (arg === '--ttl-hours') args.ttlHours = Number(argv[++i]);
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--markdown') args.format = 'markdown';
    else if (arg === '--json') args.format = 'json';
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function renderMarkdown(ledger) {
  const lines = [
    '# Gate -1 Overlap Ledger',
    '',
    `- generatedAt: ${ledger.generatedAt}`,
    `- expiresAt: ${ledger.expiresAt}`,
    `- baseRef: ${ledger.baseRef}`,
    `- agentRef: ${ledger.agentRef}`,
    `- branchStatus: ${ledger.branchStatus.state} (${ledger.branchStatus.leftOnly}/${ledger.branchStatus.rightOnly})`,
    `- passed: ${ledger.passed}`,
    '',
    '## Collisions',
    '',
  ];

  if (!ledger.collisions.length) {
    lines.push('No planned paths overlap the agent ref diff.');
  } else {
    lines.push('| path | surfaces | owner | decision |');
    lines.push('| --- | --- | --- | --- |');
    for (const collision of ledger.collisions) {
      lines.push(`| ${collision.path} | ${collision.surfaces.join(', ')} | ${collision.owner ?? ''} | ${collision.decision ?? ''} |`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function loadDecisionMap(filePath) {
  if (!filePath) return {};
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isCliEntry() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [leftOnly, rightOnly] = git(['rev-list', '--left-right', '--count', `${args.baseRef}...${args.agentRef}`])
    .split(/\s+/)
    .map(Number);
  const ledger = buildLedger({
    baseRef: args.baseRef,
    baseHead: git(['rev-parse', args.baseRef]),
    agentRef: args.agentRef,
    agentHead: git(['rev-parse', args.agentRef]),
    ttlHours: args.ttlHours,
    plannedPaths: args.plannedPaths,
    decisionMap: loadDecisionMap(args.decisionFile),
    mergeBase: git(['merge-base', args.baseRef, args.agentRef]),
    leftOnly,
    rightOnly,
    worktrees: parseWorktreePorcelain(git(['worktree', 'list', '--porcelain'])),
    agentChanges: parseNameStatus(git(['diff', '--name-status', `${args.baseRef}...${args.agentRef}`])),
  });
  const output = args.format === 'markdown' ? renderMarkdown(ledger) : `${JSON.stringify(ledger, null, 2)}\n`;

  if (args.output) writeFileSync(path.resolve(process.cwd(), args.output), output);
  else process.stdout.write(output);

  if (!ledger.passed) process.exitCode = 2;
}

if (isCliEntry()) {
  main();
}
