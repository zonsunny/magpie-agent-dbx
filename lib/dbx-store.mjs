import { MAGPIE_CONFIG_ID, MAGPIE_CONFIG_NAME } from '../dbx.agent.mjs';
import { openDatabase, withImmediateTx } from './sqlite.mjs';

const CHAT_SELECTION_KEY = 'ai_chat_selection_v1';
const SECRET_CONNECTION_ID = `ai_config.${MAGPIE_CONFIG_ID}`;

/** Parse Magpie's selection JSON file; returns null when disconnected or empty. */
export function parseSelection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = String(raw.gateway?.url ?? '').trim();
  const key = String(raw.gateway?.key ?? '').trim();
  const model = String(raw.model ?? '').trim();
  const models = Array.isArray(raw.models)
    ? raw.models
        .filter((m) => m && typeof m === 'object' && typeof m.name === 'string' && m.name.trim())
        .map((m) => {
          const item = { name: m.name.trim() };
          if (typeof m.label === 'string' && m.label.trim() && m.label.trim() !== item.name) {
            item.label = m.label.trim();
          }
          if (Array.isArray(m.supportedEffortLevels) && m.supportedEffortLevels.length > 0) {
            item.supportedEffortLevels = m.supportedEffortLevels.filter((x) => typeof x === 'string');
          }
          return item;
        })
    : [];

  if (!url || (!model && models.length === 0)) return null;
  const activeModel = model || models[0].name;
  if (!models.some((m) => m.name === activeModel)) {
    models.unshift({ name: activeModel });
  }
  return { gatewayUrl: url, gatewayKey: key, model: activeModel, models };
}

/** Build the AiConfig JSON stored in DBX's ai_configs.config_json. */
export function buildDbxAiConfig(selection) {
  return {
    provider: 'openai-compatible',
    // Empty on purpose: a plaintext apiKey is what DBX's secret-store
    // wizard counts, and Magpie's localhost gateway accepts any key.
    apiKey: '',
    authMethod: 'bearer',
    endpoint: selection.gatewayUrl,
    model: selection.model,
    models: selection.models,
    apiStyle: 'completions',
    customHeaders: {},
    proxyEnabled: false,
    proxyUrl: '',
    skipTlsVerify: false,
    enableThinking: true,
    reasoningLevel: 'default',
    maxOutputTokens: null,
    contextWindow: null,
    maxRetries: null,
    codexCliPath: null,
    codexCliEnv: {},
    claudeCodeCliPath: null,
    claudeCodeCliEnv: {},
    piAgentCliPath: null,
    piAgentCliEnv: {},
    opencodeCliPath: null,
    opencodeCliEnv: {},
    opencodeCliVersion: null,
    cursorCliPath: null,
    cursorCliEnv: {},
    grokCliPath: null,
    grokCliEnv: {},
    codebuddyCliPath: null,
    codebuddyCliEnv: {},
    qoderCliPath: null,
    qoderCliEnv: {},
  };
}

function uniqueConfigName(db, desired, ownId) {
  const rows = db.prepare('SELECT id, name FROM ai_configs').all();
  const taken = new Set(rows.filter((r) => r.id !== ownId).map((r) => r.name));
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired} (${n})`)) n += 1;
  return `${desired} (${n})`;
}

function readChatSelection(db) {
  const row = db.prepare('SELECT value_json FROM app_state WHERE key = ?').get(CHAT_SELECTION_KEY);
  if (!row || typeof row.value_json !== 'string') return { exists: false, value: null };
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { exists: true, value: parsed, raw: row.value_json }
      : { exists: true, value: null, raw: row.value_json };
  } catch {
    return { exists: true, value: null, raw: row.value_json };
  }
}

function hasRequiredTables(db) {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_configs', 'app_state', 'connection_secrets')")
    .all();
  return rows.length === 3;
}

/**
 * Apply Magpie's selection to DBX's dbx.db.
 * Returns { ok, changed, state, configName, modelCount, reason? }.
 */
export async function syncToDbxDb(dbPath, selection, prevState = null) {
  const db = await openDatabase(dbPath);
  try {
    if (!hasRequiredTables(db)) {
      return { ok: false, reason: 'dbx.db is missing required AI tables (ai_configs/app_state/connection_secrets)' };
    }

    return withImmediateTx(db, () => {
      const existingMagpie = db
        .prepare('SELECT id, name, model, models, config_json, is_default FROM ai_configs WHERE id = ?')
        .get(MAGPIE_CONFIG_ID);
      const currentDefault = db
        .prepare('SELECT id FROM ai_configs WHERE is_default = 1')
        .get();
      const chatState = readChatSelection(db);

      // Snapshot the user's pre-Magpie selection once on first takeover.
      const state = prevState?.active
        ? { ...prevState }
        : {
            version: 1,
            active: true,
            configId: MAGPIE_CONFIG_ID,
            previousDefaultId: currentDefault && currentDefault.id !== MAGPIE_CONFIG_ID ? currentDefault.id : null,
            previousChatActive:
              chatState.value?.active && chatState.value.active.configId !== MAGPIE_CONFIG_ID
                ? { ...chatState.value.active }
                : null,
          };

      const configName = existingMagpie?.name || uniqueConfigName(db, MAGPIE_CONFIG_NAME, MAGPIE_CONFIG_ID);
      const modelsJson = JSON.stringify(selection.models);
      const configJson = JSON.stringify(buildDbxAiConfig(selection));

      // Check whether the DB already holds the exact desired state (including active chat model).
      const desiredActive = { configId: MAGPIE_CONFIG_ID, modelId: selection.model };
      const nextChatObj = {
        ...(chatState.value ?? { version: 1, effortPreferences: [], defaultMode: 'ask', defaultAutoRouting: false }),
        version: chatState.value?.version ?? 1,
        active: desiredActive,
      };
      const nextChatJson = JSON.stringify(nextChatObj);

      // Rewrite if a previous version left a plaintext apiKey (that reopens DBX's migration wizard).
      let rowMatches = false;
      if (
        existingMagpie &&
        existingMagpie.name === configName &&
        existingMagpie.model === selection.model &&
        existingMagpie.models === modelsJson &&
        existingMagpie.is_default === 1
      ) {
        try {
          const prevCfg = JSON.parse(existingMagpie.config_json);
          const apiKeyEmpty = !prevCfg.apiKey;
          rowMatches =
            apiKeyEmpty &&
            prevCfg.provider === 'openai-compatible' &&
            prevCfg.endpoint === selection.gatewayUrl &&
            prevCfg.model === selection.model &&
            JSON.stringify(prevCfg.models ?? []) === modelsJson &&
            prevCfg.apiStyle === 'completions';
        } catch {
          rowMatches = false;
        }
      }

      const chatMatches =
        chatState.value?.active?.configId === desiredActive.configId &&
        chatState.value?.active?.modelId === desiredActive.modelId;

      if (rowMatches && chatMatches) {
        return {
          ok: true,
          changed: false,
          state: { ...state, lastGatewayKey: selection.gatewayKey },
          configName,
          modelCount: selection.models.length,
        };
      }

      if (!rowMatches) {
        db.prepare('UPDATE ai_configs SET is_default = 0 WHERE is_default = 1 AND id != ?').run(MAGPIE_CONFIG_ID);
        db.prepare(
          `INSERT INTO ai_configs (id, name, model, models, config_json, is_default)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             model = excluded.model,
             models = excluded.models,
             config_json = excluded.config_json,
             is_default = 1`
        ).run(MAGPIE_CONFIG_ID, configName, selection.model, modelsJson, configJson);
      }

      if (!chatMatches) {
        db.prepare(
          `INSERT INTO app_state (key, value_json)
           VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
        ).run(CHAT_SELECTION_KEY, nextChatJson);
      }

      return {
        ok: true,
        changed: true,
        state: { ...state, lastGatewayKey: selection.gatewayKey },
        configName,
        modelCount: selection.models.length,
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Remove Magpie's row from DBX's dbx.db and restore the previous default & active chat model.
 */
export async function restoreDbxDb(dbPath, state) {
  const db = await openDatabase(dbPath);
  try {
    if (!hasRequiredTables(db)) {
      return { ok: false, reason: 'dbx.db is missing required AI tables' };
    }

    return withImmediateTx(db, () => {
      const hadRow = Boolean(db.prepare('SELECT 1 FROM ai_configs WHERE id = ?').get(MAGPIE_CONFIG_ID));
      db.prepare('DELETE FROM ai_configs WHERE id = ?').run(MAGPIE_CONFIG_ID);
      db.prepare('DELETE FROM connection_secrets WHERE connection_id = ?').run(SECRET_CONNECTION_ID);

      // Restore previous default if it still exists and no other row is currently default.
      const hasDefault = Boolean(db.prepare('SELECT 1 FROM ai_configs WHERE is_default = 1').get());
      if (!hasDefault && state?.previousDefaultId) {
        const exists = db.prepare('SELECT 1 FROM ai_configs WHERE id = ?').get(state.previousDefaultId);
        if (exists) {
          db.prepare('UPDATE ai_configs SET is_default = 1 WHERE id = ?').run(state.previousDefaultId);
        }
      }

      // Restore active chat selection only if it currently points at Magpie.
      const chatState = readChatSelection(db);
      let restoredChat = false;
      if (chatState.value && chatState.value.active?.configId === MAGPIE_CONFIG_ID) {
        const next = { ...chatState.value };
        const prev = state?.previousChatActive;
        const prevExists =
          prev?.configId && Boolean(db.prepare('SELECT 1 FROM ai_configs WHERE id = ?').get(prev.configId));
        if (prevExists) {
          next.active = { configId: prev.configId, modelId: prev.modelId };
        } else {
          delete next.active;
        }
        db.prepare('UPDATE app_state SET value_json = ? WHERE key = ?').run(
          JSON.stringify(next),
          CHAT_SELECTION_KEY
        );
        restoredChat = true;
      }

      return { ok: true, changed: hadRow || restoredChat };
    });
  } finally {
    db.close();
  }
}

/** Read-only summary of DBX's current AI config state (for tools/doctor.mjs). */
export async function inspectDbxDb(dbPath) {
  const db = await openDatabase(dbPath, { readonly: true });
  try {
    if (!hasRequiredTables(db)) return { ok: false, reason: 'missing ai_configs/app_state tables' };
    const configs = db.prepare('SELECT id, name, model, models, is_default FROM ai_configs').all();
    const chatState = readChatSelection(db);
    const magpieRow = configs.find((c) => c.id === MAGPIE_CONFIG_ID) || null;
    let magpieModels = 0;
    if (magpieRow) {
      try {
        magpieModels = JSON.parse(magpieRow.models || '[]').length;
      } catch {
        magpieModels = 0;
      }
    }
    return {
      ok: true,
      configCount: configs.length,
      defaultConfig: configs.find((c) => c.is_default === 1)?.name || null,
      activeChat: chatState.value?.active || null,
      magpieInstalledInDb: Boolean(magpieRow),
      magpieModel: magpieRow?.model || null,
      magpieModels,
    };
  } finally {
    db.close();
  }
}
