#!/usr/bin/env node
// Inline Flow's thin rules into ~/.claude/CLAUDE.md between managed markers, so the
// always-on root loads it regardless of whether @import is supported. Idempotent.
// Usage: node merge-claudemd.mjs <claudeMdPath> <rulesPath>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function readNoBom(p) {
  let s = readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip UTF-8 BOM if present
  return s;
}

const [mdPath, rulesPath] = process.argv.slice(2);
if (!mdPath || !rulesPath) {
  console.error('usage: merge-claudemd.mjs <claudeMdPath> <rulesPath>');
  process.exit(1);
}

const BEGIN = '<!-- FLOW:BEGIN (auto-managed by install.ps1/sh — edit dist/rules/flow.md, not here) -->';
const END = '<!-- FLOW:END -->';

const rules = readNoBom(rulesPath).trim();
const block = `${BEGIN}\n${rules}\n${END}`;

let md = existsSync(mdPath) ? readNoBom(mdPath) : '';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const re = new RegExp(escapeRe(BEGIN) + '[\\s\\S]*?' + escapeRe(END));

if (re.test(md)) {
  md = md.replace(re, block);
  console.log('CLAUDE.md: Flow block re-synced');
} else {
  md = (md.trim() ? md.trim() + '\n\n' : '') + block + '\n';
  console.log('CLAUDE.md: Flow block appended');
}

writeFileSync(mdPath, md, 'utf8');
