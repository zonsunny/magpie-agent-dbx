#!/usr/bin/env node
import fs from 'node:fs';
import { defaultDbxDataDir, paths, readJson } from '../lib/paths.mjs';
import { inspectDbxDb } from '../lib/dbx-store.mjs';

const jsonMode = process.argv.includes('--json');

async function main() {
  const p = paths();
  const defaultDir = defaultDbxDataDir();
  const linkInfo = { path: p.homeLink, target: null, isLink: false };
  try {
    const st = fs.lstatSync(p.homeLink);
    linkInfo.isLink = st.isSymbolicLink();
    linkInfo.target = fs.realpathSync(p.homeLink);
  } catch {
    /* not created yet */
  }

  const dbInfo = p.db ? await inspectDbxDb(p.db) : { ok: false, reason: 'dbx.db not found' };
  const sel = readJson(p.selection);
  const state = readJson(p.state);

  const report = {
    ok: Boolean(p.db && dbInfo.ok),
    platform: process.platform,
    dataDir: p.dataDir || null,
    defaultDataDir: defaultDir,
    db: p.db || null,
    homeLink: linkInfo,
    selectionFile: { path: p.selection, exists: sel.ok, model: sel.ok ? sel.value?.model ?? null : null },
    stateFile: { path: p.state, active: Boolean(state.ok && state.value?.active) },
    dbSummary: dbInfo,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  }

  console.log('DBX Magpie plugin preflight');
  console.log('  data dir      :', report.dataDir ?? `(not found; expected ${defaultDir})`);
  console.log('  database      :', report.db ?? '(not found)');
  console.log('  home link     :', `${linkInfo.path} -> ${linkInfo.target ?? '(created when Magpie loads the plugin)'}`);
  console.log('  selection file:', `${p.selection} (${sel.ok ? `model=${sel.value?.model || '(none)'}` : 'not connected'})`);
  if (dbInfo.ok) {
    console.log(`  AI configs    : ${dbInfo.configCount} total, default=${dbInfo.defaultConfig ?? '(none)'}`);
    console.log(
      `  Magpie row    : ${
        dbInfo.magpieInstalledInDb
          ? `present (active=${dbInfo.magpieModel}, ${dbInfo.magpieModels} model(s))`
          : 'not written yet'
      }`
    );
    if (dbInfo.activeChat) {
      console.log(`  chat active   : configId=${dbInfo.activeChat.configId}, modelId=${dbInfo.activeChat.modelId}`);
    }
    console.log('\nREADY — DBX database is readable and has the expected AI tables.');
    process.exit(0);
  }

  console.log(`\nPROBLEM: ${dbInfo.reason}`);
  console.log('Open DBX once so dbx.db is initialized, or set DBX_DATA_DIR to its data directory.');
  process.exit(1);
}

main().catch((err) => {
  console.error('doctor failed:', err?.message ?? err);
  process.exit(1);
});
