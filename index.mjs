// Magpie Bun plugin host for DBX.
// 1. Links ~/.config/magpie/dbx-home -> DBX's data dir so Magpie detects DBX.
// 2. Watches ~/.config/magpie/dbx-agent.json (written by Magpie via dbx.agent.mjs)
//    and syncs the Magpie provider row into DBX's SQLite database (dbx.db).
// 3. On disconnect, removes our row and restores DBX's previous default model.
import fs from 'node:fs';
import { paths, readJson, syncHomeLink, writeJsonAtomic } from './lib/paths.mjs';
import { parseSelection, restoreDbxDb, syncToDbxDb } from './lib/dbx-store.mjs';

const STARTED = Symbol.for('magpie.agent.dbx.started.v1');
const POLL_MS = 2000;

export async function runSyncOnce(env = process.env, platform = process.platform) {
  const home = syncHomeLink(env, platform);
  const p = paths(env, platform);
  if (!p.db) {
    return { ok: false, stage: 'detect', home, reason: home.reason || 'DBX database not found' };
  }

  const selFile = readJson(p.selection);
  if (!selFile.ok && !selFile.missing) {
    return { ok: false, stage: 'selection', home, reason: `unreadable selection file: ${selFile.error}` };
  }
  const selection = selFile.ok ? parseSelection(selFile.value) : null;

  const stateFile = readJson(p.state);
  const prevState =
    stateFile.ok && stateFile.value && typeof stateFile.value === 'object' ? stateFile.value : null;

  if (!selection) {
    if (!prevState?.active) {
      return { ok: true, stage: 'idle', home, changed: false };
    }
    const restored = await restoreDbxDb(p.db, prevState);
    if (restored.ok) {
      fs.rmSync(p.state, { force: true });
    }
    return { ...restored, stage: 'restore', home };
  }

  const synced = await syncToDbxDb(p.db, selection, prevState);
  if (synced.ok && synced.state) {
    const nextState = { ...synced.state, lastSyncedAt: new Date().toISOString() };
    if (
      !prevState ||
      synced.changed ||
      prevState.lastGatewayKey !== nextState.lastGatewayKey ||
      prevState.previousDefaultId !== nextState.previousDefaultId
    ) {
      writeJsonAtomic(p.state, nextState);
    }
  }
  return { ...synced, stage: 'sync', home };
}

function start(input) {
  if (globalThis[STARTED]) return;
  globalThis[STARTED] = true;

  const log = (level, message) => {
    try {
      input?.client?.app?.log?.({ body: { service: 'dbx', level, message } })?.catch?.(() => {});
    } catch {
      /* logging must never crash the plugin host */
    }
  };

  let lastMsg = '';
  const say = (level, msg) => {
    if (msg === lastMsg) return;
    lastMsg = msg;
    log(level, msg);
  };

  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    runSyncOnce()
      .then((res) => {
        if (!res.ok) {
          if (res.stage !== 'detect') say('warn', `dbx: ${res.reason}`);
          return;
        }
        if (res.stage === 'sync' && res.changed) {
          say('info', `dbx: synced ${res.modelCount} model(s) into dbx.db`);
        } else if (res.stage === 'restore' && res.changed) {
          say('info', 'dbx: removed Magpie config and restored previous default');
        }
      })
      .catch((err) => {
        say('error', `dbx: ${err?.message ?? err}`);
      })
      .finally(() => {
        busy = false;
      });
  };

  tick();
  setInterval(tick, POLL_MS).unref?.();
}

async function runPlugin(input) {
  start(input);
  return {};
}

// Magpie v1: default {id, server} is the only function the host calls. A default
// function would also invoke every named export (runSyncOnce) as a plugin.
export default {
  id: 'dbx-agent',
  server: runPlugin,
};
