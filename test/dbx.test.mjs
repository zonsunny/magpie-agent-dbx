import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agent, connect, MAGPIE_CONFIG_ID } from '../dbx.agent.mjs';
import { defaultDbxDataDir, paths, resolveDbxDataDir, syncHomeLink, writeJsonAtomic } from '../lib/paths.mjs';
import { openDatabase } from '../lib/sqlite.mjs';
import { inspectDbxDb, parseSelection, restoreDbxDb, syncToDbxDb } from '../lib/dbx-store.mjs';
import plugin, { runSyncOnce } from '../index.mjs';

async function createMockDbxDb(dbFile, { withUserConfig = true, collidingName = null } = {}) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE ai_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '[]',
      config_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_ai_configs_default ON ai_configs(is_default) WHERE is_default = 1;
    CREATE TABLE app_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
    CREATE TABLE connection_secrets (
      connection_id TEXT NOT NULL,
      key TEXT NOT NULL,
      secret TEXT NOT NULL,
      secret_enc TEXT,
      PRIMARY KEY (connection_id, key)
    );
  `);
  if (withUserConfig) {
    const name = collidingName || 'glm-5.3-flash';
    const cfg = JSON.stringify({
      provider: 'zhipu',
      apiKey: '',
      authMethod: 'bearer',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3-flash',
      models: [],
      apiStyle: 'completions',
    });
    db.prepare(
      'INSERT INTO ai_configs (id, name, model, models, config_json, is_default) VALUES (?, ?, ?, ?, ?, 1)'
    ).run('user-cfg-1', name, 'glm-5.3-flash', '[]', cfg);
    db.prepare('INSERT INTO app_state (key, value_json) VALUES (?, ?)').run(
      'ai_chat_selection_v1',
      JSON.stringify({
        version: 1,
        active: { configId: 'user-cfg-1', modelId: 'glm-5.3-flash' },
        effortPreferences: [],
        defaultMode: 'ask',
        defaultAutoRouting: false,
      })
    );
    db.prepare(
      'INSERT INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?, ?, ?, ?)'
    ).run('ai_config.user-cfg-1', 'config', '', 'dbxenc1.user-secret-stay');
  }
  db.close();
}

test('Magpie v1 host contract: default is {id, server}', () => {
  assert.equal(typeof plugin, 'object');
  assert.equal(plugin.id, 'dbx-agent');
  assert.equal(typeof plugin.server, 'function');
  assert.equal(typeof plugin.default, 'undefined');
});

test('agent descriptor and connect() produce valid DBX selection payload', () => {
  assert.equal(agent.id, 'dbx');
  assert.equal(agent.name, 'DBX');
  assert.equal(agent.dir, '~/.config/magpie/dbx-home');
  assert.equal(agent.config, '~/.config/magpie/dbx-agent.json');
  assert.equal(agent.model, 'model');
  assert.equal(agent.bin, undefined);
  assert.match(agent.icon, /^data:image\/png;base64,/);

  const out = connect({
    gateway: { url: 'http://127.0.0.1:3425', v1: 'http://127.0.0.1:3425/v1', key: 'magpie-dbx' },
    model: { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', efforts: ['low', 'high', 'invalid'] },
    models: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', efforts: ['low', 'high', 'invalid'] },
      { id: 'openai/gpt-5', name: 'openai/gpt-5', efforts: ['medium', 'xhigh'] },
      { id: 'deepseek/deepseek-chat', name: 'duplicate' },
    ],
  });

  assert.equal(out['gateway.url'], 'http://127.0.0.1:3425/v1');
  assert.equal(out['gateway.key'], 'magpie-dbx');
  assert.equal(out.model, 'deepseek/deepseek-chat');
  assert.deepEqual(out.models, [
    { name: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', supportedEffortLevels: ['low', 'high'] },
    { name: 'openai/gpt-5', supportedEffortLevels: ['medium', 'xhigh'] },
  ]);
});

test('defaultDbxDataDir matches Tauri app_data_dir on macOS, Windows and Linux', () => {
  assert.equal(
    defaultDbxDataDir({ HOME: '/Users/alice' }, 'darwin'),
    path.join('/Users/alice', 'Library', 'Application Support', 'com.dbx.app')
  );
  assert.equal(
    defaultDbxDataDir({ APPDATA: 'C:/Users/alice/AppData/Roaming' }, 'win32'),
    path.join('C:/Users/alice/AppData/Roaming', 'com.dbx.app')
  );
  assert.equal(
    defaultDbxDataDir({ HOME: '/home/alice' }, 'linux'),
    path.join('/home/alice', '.local', 'share', 'com.dbx.app')
  );
});

test('syncHomeLink creates, updates, cleans dangling, and refuses non-symlink directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-dbx-link-'));
  try {
    const home = path.join(root, 'home');
    const env = { HOME: home };

    // No DBX yet -> no link created
    assert.equal(resolveDbxDataDir(env, 'darwin'), '');
    assert.equal(syncHomeLink(env, 'darwin').ok, false);
    assert.equal(fs.existsSync(paths(env, 'darwin').homeLink), false);

    // Create DBX db -> link created
    const dataDir = defaultDbxDataDir(env, 'darwin');
    await createMockDbxDb(path.join(dataDir, 'dbx.db'));
    const first = syncHomeLink(env, 'darwin');
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(fs.realpathSync(first.link), fs.realpathSync(dataDir));

    // Idempotent second call
    const second = syncHomeLink(env, 'darwin');
    assert.equal(second.ok, true);
    assert.equal(second.created, false);

    // Repointing via DBX_DATA_DIR does not delete old target
    const customDir = path.join(root, 'custom-dbx');
    await createMockDbxDb(path.join(customDir, 'dbx.db'));
    const marker = path.join(dataDir, 'keep.txt');
    fs.writeFileSync(marker, 'stay');
    const repoint = syncHomeLink({ ...env, DBX_DATA_DIR: customDir }, 'darwin');
    assert.equal(repoint.ok, true);
    assert.equal(repoint.created, true);
    assert.equal(fs.realpathSync(repoint.link), fs.realpathSync(customDir));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'stay');

    // Refuse real folder in place of link
    const realHome = path.join(root, 'home-real-dir');
    const realLink = path.join(realHome, '.config', 'magpie', 'dbx-home');
    fs.mkdirSync(realLink, { recursive: true });
    fs.writeFileSync(path.join(realLink, 'user.txt'), 'mine');
    const refused = syncHomeLink({ HOME: realHome, DBX_DATA_DIR: customDir }, 'darwin');
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /not a link/);
    assert.equal(fs.readFileSync(path.join(realLink, 'user.txt'), 'utf8'), 'mine');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('syncToDbxDb + restoreDbxDb preserves user configs, handles name collision, and restores default & chat selection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-dbx-sql-'));
  try {
    const dbFile = path.join(root, 'dbx.db');
    await createMockDbxDb(dbFile, { withUserConfig: true, collidingName: 'Magpie' });

    const sel = parseSelection({
      gateway: { url: 'http://127.0.0.1:3425/v1', key: 'magpie-dbx' },
      model: 'deepseek/deepseek-chat',
      models: [
        { name: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
        { name: 'anthropic/claude-sonnet-4-6', supportedEffortLevels: ['low', 'high'] },
      ],
    });

    // First sync
    const res1 = await syncToDbxDb(dbFile, sel, null);
    assert.equal(res1.ok, true);
    assert.equal(res1.changed, true);
    assert.equal(res1.configName, 'Magpie (2)'); // avoided UNIQUE name collision
    assert.equal(res1.state.previousDefaultId, 'user-cfg-1');
    assert.deepEqual(res1.state.previousChatActive, { configId: 'user-cfg-1', modelId: 'glm-5.3-flash' });

    // Verify DB contents
    const db = await openDatabase(dbFile, { readonly: true });
    const rows = db.prepare('SELECT id, name, model, models, config_json, is_default FROM ai_configs ORDER BY id').all();
    assert.equal(rows.length, 2);
    const magpie = rows.find((r) => r.id === MAGPIE_CONFIG_ID);
    const user = rows.find((r) => r.id === 'user-cfg-1');
    assert.equal(magpie.is_default, 1);
    assert.equal(user.is_default, 0);
    assert.equal(magpie.model, 'deepseek/deepseek-chat');
    const cfg = JSON.parse(magpie.config_json);
    assert.equal(cfg.provider, 'openai-compatible');
    assert.equal(cfg.endpoint, 'http://127.0.0.1:3425/v1');
    assert.equal(cfg.apiKey, 'magpie-dbx');
    assert.equal(cfg.apiStyle, 'completions');
    // User's own encrypted secret must be untouched
    const userSec = db.prepare('SELECT secret_enc FROM connection_secrets WHERE connection_id = ?').get('ai_config.user-cfg-1');
    assert.equal(userSec.secret_enc, 'dbxenc1.user-secret-stay');
    const chatSel = JSON.parse(db.prepare("SELECT value_json FROM app_state WHERE key = 'ai_chat_selection_v1'").get().value_json);
    assert.deepEqual(chatSel.active, { configId: MAGPIE_CONFIG_ID, modelId: 'deepseek/deepseek-chat' });
    db.close();

    // Idempotent second sync (including after DBX migrates apiKey into connection_secrets!)
    const dbW = await openDatabase(dbFile);
    const strippedCfg = { ...cfg, apiKey: '' };
    dbW.prepare('UPDATE ai_configs SET config_json = ? WHERE id = ?').run(JSON.stringify(strippedCfg), MAGPIE_CONFIG_ID);
    dbW.prepare("INSERT INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?, 'config', '', 'dbxenc1.migrated')").run(
      `ai_config.${MAGPIE_CONFIG_ID}`
    );
    dbW.close();

    const res2 = await syncToDbxDb(dbFile, sel, res1.state);
    assert.equal(res2.ok, true);
    assert.equal(res2.changed, false);

    // Switching model updates row and clears stale secret so DBX re-migrates cleanly
    const sel2 = parseSelection({
      gateway: { url: 'http://127.0.0.1:3425/v1', key: 'magpie-dbx' },
      model: 'anthropic/claude-sonnet-4-6',
      models: sel.models,
    });
    const res3 = await syncToDbxDb(dbFile, sel2, res2.state);
    assert.equal(res3.ok, true);
    assert.equal(res3.changed, true);

    const summary = await inspectDbxDb(dbFile);
    assert.equal(summary.magpieModel, 'anthropic/claude-sonnet-4-6');
    assert.equal(summary.activeChat.modelId, 'anthropic/claude-sonnet-4-6');

    // Disconnect restores user's original default and chat selection
    const restored = await restoreDbxDb(dbFile, res3.state);
    assert.equal(restored.ok, true);
    assert.equal(restored.changed, true);

    const after = await inspectDbxDb(dbFile);
    assert.equal(after.configCount, 1);
    assert.equal(after.magpieInstalledInDb, false);
    assert.equal(after.defaultConfig, 'Magpie'); // original user config's name
    assert.deepEqual(after.activeChat, { configId: 'user-cfg-1', modelId: 'glm-5.3-flash' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runSyncOnce full host lifecycle: detect -> connect -> update -> disconnect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-dbx-host-'));
  try {
    const home = path.join(root, 'home');
    const env = { HOME: home };
    const dataDir = defaultDbxDataDir(env, 'darwin');
    const dbFile = path.join(dataDir, 'dbx.db');
    await createMockDbxDb(dbFile);

    // Idle before selection file exists
    const idle = await runSyncOnce(env, 'darwin');
    assert.equal(idle.ok, true);
    assert.equal(idle.stage, 'idle');
    assert.equal(idle.home.ok, true);

    // Magpie writes selection file
    const p = paths(env, 'darwin');
    writeJsonAtomic(p.selection, {
      gateway: { url: 'http://127.0.0.1:3425/v1', key: 'magpie-dbx' },
      model: 'openai/gpt-5',
      models: [{ name: 'openai/gpt-5' }],
    });

    const synced = await runSyncOnce(env, 'darwin');
    assert.equal(synced.ok, true);
    assert.equal(synced.stage, 'sync');
    assert.equal(synced.changed, true);
    assert.equal(fs.existsSync(p.state), true);

    // Magpie disconnects (empties keys / removes selection)
    writeJsonAtomic(p.selection, {});
    const restored = await runSyncOnce(env, 'darwin');
    assert.equal(restored.ok, true);
    assert.equal(restored.stage, 'restore');
    assert.equal(restored.changed, true);
    assert.equal(fs.existsSync(p.state), false);

    const summary = await inspectDbxDb(dbFile);
    assert.equal(summary.magpieInstalledInDb, false);
    assert.equal(summary.defaultConfig, 'glm-5.3-flash');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
