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
let updated = 0;
for (const [event, entries] of Object.entries(frag.hooks)) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  for (const entry of entries) {
    const cmds = (entry.hooks || []).map((h) => h.command);
    const hit = settings.hooks[event].find((e) =>
      (e.hooks || []).some((h) => cmds.includes(h.command))
    );
    if (hit) {
      // 同 command 已接線：matcher 改版時就地更新（如 Bash → Bash|PowerShell），否則跳過。
      // 只動「整個 entry 都是本 fragment 的 command」的條目——使用者若把自己的 hook 併進同 entry，不連帶改其觸發範圍。
      const pureFlowEntry = (hit.hooks || []).every((h) => cmds.includes(h.command));
      if ((entry.matcher ?? '') !== (hit.matcher ?? '')) {
        if (pureFlowEntry) { hit.matcher = entry.matcher; updated++; }
        else { console.error(`！matcher 需更新為「${entry.matcher}」但該 entry 含非 Flow hook，請手動調整：${cmds[0]}`); skipped++; }
      } else skipped++;
      continue;
    }
    settings.hooks[event].push(entry);
    added++;
  }
}

// H3（體檢）：範本演進要能「刪」——settings 裡指向本安裝（{claudeHome}/hooks/flow-*.mjs）、但已不在
// fragment「同一事件」名單裡的註冊＝舊版殘留（hook 合併/掛點移除後遺），一併剪掉。event 綁定比對：
// 同一支 hook 在 A 事件仍在名單、在 B 事件被移除時，只剪 B 那筆。非本安裝路徑或非 flow-*.mjs 的
// hook（使用者自有）一概不動；entry 掏空才移除（使用者併進同 entry 的 hook 不連坐）。
const fragByEvent = {};
for (const [event, entries] of Object.entries(frag.hooks))
  fragByEvent[event] = new Set(entries.flatMap((e) => (e.hooks || []).map((h) => h.command)));
const ownFlowCmd = (c) => typeof c === 'string' && c.includes(`${fwd}/hooks/flow-`) && /\bflow-[a-z0-9-]+\.mjs\b/i.test(c);
let pruned = 0;
for (const event of Object.keys(settings.hooks)) {
  if (!Array.isArray(settings.hooks[event])) continue;
  for (const entry of settings.hooks[event]) {
    const before = (entry.hooks || []).length;
    entry.hooks = (entry.hooks || []).filter((h) => !(ownFlowCmd(h.command) && !(fragByEvent[event] || new Set()).has(h.command)));
    pruned += before - entry.hooks.length;
  }
  settings.hooks[event] = settings.hooks[event].filter((e) => (e.hooks || []).length > 0);
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}

// BOM-less UTF-8 (Node default) so Claude Code parses it cleanly.
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log(`hooks merged into settings.json: +${added} added, ${updated} matcher updated, ${skipped} already present, ${pruned} stale pruned`);
