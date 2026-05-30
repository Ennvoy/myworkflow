#!/usr/bin/env node
// Flow deterministic gate (PreToolUse on TaskUpdate).
// Blocks marking a task "completed" unless .flow/state.json shows real verify + tdd.
// The model cannot fake "verify=ok" without actually running the verifier — this is the
// deterministic node that enforces "done = actually runs green".
// Fail-open on parse/missing-state (so it never bricks non-Flow projects);
// fail-closed on the real gate condition (verify empty/none while a Flow project).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(stripBom(raw).trim() || '{}');
  } catch {
    process.exit(0); // unparseable hook input -> no-op
  }

  const tool = input.tool_name ?? input.toolName ?? '';
  const ti = input.tool_input ?? input.toolInput ?? {};
  if (tool !== 'TaskUpdate') process.exit(0);
  if (String(ti.status ?? '') !== 'completed') process.exit(0);

  const cwd = input.cwd ?? process.cwd();
  let state;
  try {
    state = JSON.parse(stripBom(readFileSync(join(cwd, '.flow', 'state.json'), 'utf8')));
  } catch {
    process.exit(0); // no/!parseable .flow/state.json -> not a Flow project, don't interfere
  }

  const verify = String(state.verify ?? '').trim();
  const tdd = String(state.tdd ?? '').trim();
  const isNone = (v) => v === '' || /^none$/i.test(v);
  const verifyOk = !isNone(verify); // "ok:<ref>" etc.
  // tdd acceptable when it carries a real value: green / refactored / red:<ref> / n/a / skipped:<reason>
  const tddOk = !isNone(tdd);

  if (!verifyOk || !tddOk) {
    const reason = [
      'Flow gate: cannot mark this task completed yet.',
      !verifyOk
        ? '  - .flow/state.json "verify" is empty/none -> run /flow-verify and record real green-light evidence (verify="ok:<ref>") first.'
        : '',
      !tddOk
        ? '  - .flow/state.json "tdd" is empty/none -> do TDD red->green, or set "n/a" / "skipped:<reason>" for an allowed exception.'
        : '',
      'Do NOT hand-edit state.json to pass this gate (systematic violation). Make verification actually pass.',
    ]
      .filter(Boolean)
      .join('\n');
    process.stderr.write(reason + '\n');
    process.exit(2); // exit 2 => Claude Code blocks the tool call, feeds stderr to the model
  }

  process.exit(0);
});
