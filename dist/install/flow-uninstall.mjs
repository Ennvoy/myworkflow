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

// C-18：不再硬編 hook 清單（原硬編 8 支，實際註冊 10 支＝漏 flow-stop-gate/flow-precompact → 卸載殘留
// 註冊指向已刪檔，每次工具呼叫 spawn 失敗 node）。改用命名慣例：任何 command 引用 flow-*.mjs（Flow 所有
// settings.json hook 一律此命名）即 Flow 註冊。新增/移除 hook 自動涵蓋、零漂移，不必再手動同步三個卸載入口。
const FLOW_HOOK_RE = /\bflow-[a-z0-9-]+\.mjs\b/i;
const isFlowHook = (h) => typeof h.command === 'string' && FLOW_HOOK_RE.test(h.command);

// --- 1) settings.json: remove Flow hook registrations (mirror of merge-settings.mjs) ---
// H3（體檢）：只摘 Flow 自己的 hook「註冊」而非整條 entry——使用者若把自己的 hook 併進同一 entry，
// 原 .some() 判定會連坐刪掉；改逐 hook 過濾、entry 掏空才移除。
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
        for (const entry of settings.hooks[event]) {
          const before = (entry.hooks || []).length;
          entry.hooks = (entry.hooks || []).filter((h) => !isFlowHook(h));
          removed += before - entry.hooks.length;
        }
        settings.hooks[event] = settings.hooks[event].filter((e) => (e.hooks || []).length > 0);
        if (settings.hooks[event].length === 0) delete settings.hooks[event]; // tidy empty events
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`settings.json: removed ${removed} Flow hook ${removed === 1 ? 'registration' : 'registrations'}`);
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
