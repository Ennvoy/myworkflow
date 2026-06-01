#!/usr/bin/env node
// Reverse Flow's settings.json hook merge, and strip any legacy inlined FLOW block
// from CLAUDE.md (older installs predating rules/-only loading). Idempotent: no-op
// when there is nothing to remove. Cross-platform, BOM-safe.
// Usage: node flow-uninstall.mjs <settingsPath> <claudeMdPath>
// Exit: 0 ok, 1 bad args, 3 existing settings.json unparseable (left untouched).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function readNoBom(p) {
  let s = readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip UTF-8 BOM if present
  return s;
}

const [settingsPath, claudeMdPath] = process.argv.slice(2);
if (!settingsPath || !claudeMdPath) {
  console.error('usage: flow-uninstall.mjs <settingsPath> <claudeMdPath>');
  process.exit(1);
}

// Flow's hook scripts identify Flow's registrations regardless of path/quoting.
const FLOW_HOOK_SCRIPTS = ['flow-verify-gate.mjs', 'flow-session-start.mjs', 'flow-size-check.mjs', 'flow-commit-gate.mjs'];
const isFlowEntry = (entry) =>
  (entry.hooks || []).some(
    (h) => typeof h.command === 'string' && FLOW_HOOK_SCRIPTS.some((s) => h.command.includes(s))
  );

// --- 1) settings.json: remove Flow hook entries (mirror of merge-settings.mjs) ---
if (existsSync(settingsPath)) {
  const txt = readNoBom(settingsPath).trim();
  if (txt) {
    let settings;
    try {
      settings = JSON.parse(txt);
    } catch (e) {
      console.error('settings.json 解析失敗，未做任何變更：' + e.message);
      process.exit(3);
    }
    let removed = 0;
    if (settings.hooks && typeof settings.hooks === 'object') {
      for (const event of Object.keys(settings.hooks)) {
        if (!Array.isArray(settings.hooks[event])) continue;
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((e) => !isFlowEntry(e));
        removed += before - settings.hooks[event].length;
        if (settings.hooks[event].length === 0) delete settings.hooks[event]; // tidy empty events
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`settings.json: removed ${removed} Flow hook ${removed === 1 ? 'entry' : 'entries'}`);
  }
}

// --- 2) CLAUDE.md: strip legacy inlined FLOW block (only present on older installs) ---
if (existsSync(claudeMdPath)) {
  let md = readNoBom(claudeMdPath);
  const re = /\r?\n?<!-- FLOW:BEGIN[\s\S]*?<!-- FLOW:END -->\r?\n?/;
  if (re.test(md)) {
    md = md.replace(re, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
    writeFileSync(claudeMdPath, md, 'utf8');
    console.log('CLAUDE.md: stripped legacy inlined FLOW block');
  }
}
