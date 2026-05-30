#!/usr/bin/env node
// Idempotent merge of Flow hook registrations into ~/.claude/settings.json.
// Robust JSON handling in Node (avoids PS 5.1 JSON/BOM pitfalls). Cross-platform.
// Usage: node merge-settings.mjs <settingsPath> <fragmentPath> <claudeHome>
// Exit: 0 ok, 1 bad args, 3 existing settings.json unparseable (left untouched).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function readNoBom(p) {
  let s = readFileSync(p, 'utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // strip UTF-8 BOM if present
  return s;
}

const [settingsPath, fragmentPath, claudeHome] = process.argv.slice(2);
if (!settingsPath || !fragmentPath || !claudeHome) {
  console.error('usage: merge-settings.mjs <settingsPath> <fragmentPath> <claudeHome>');
  process.exit(1);
}

// Node accepts forward slashes on Windows; avoids JSON backslash-escaping pain.
const fwd = claudeHome.replace(/\\/g, '/').replace(/\/+$/, '');

const frag = JSON.parse(readNoBom(fragmentPath).replace(/\{\{CLAUDE_HOME\}\}/g, fwd));
delete frag._comment;

let settings = {};
if (existsSync(settingsPath)) {
  const txt = readNoBom(settingsPath).trim();
  if (txt) {
    try {
      settings = JSON.parse(txt);
    } catch (e) {
      console.error('settings.json 解析失敗，未做任何變更：' + e.message);
      process.exit(3);
    }
  }
}
if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};

let added = 0;
let skipped = 0;
for (const [event, entries] of Object.entries(frag.hooks)) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  for (const entry of entries) {
    const cmds = (entry.hooks || []).map((h) => h.command);
    const present = settings.hooks[event].some((e) =>
      (e.hooks || []).some((h) => cmds.includes(h.command))
    );
    if (present) {
      skipped++;
      continue;
    }
    settings.hooks[event].push(entry);
    added++;
  }
}

// BOM-less UTF-8 (Node default) so Claude Code parses it cleanly.
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log(`hooks merged into settings.json: +${added} added, ${skipped} already present`);
