import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_IDENTIFIER = 'com.dbx.app';
export const HOME_LINK = 'dbx-home';
export const SELECTION_FILE = 'dbx-agent.json';
export const STATE_FILE = '.magpie-dbx-state.json';

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function magpieConfigRoot(env = process.env) {
  return path.join(homeDir(env), '.config', 'magpie');
}

export function defaultDbxDataDir(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(homeDir(env), 'Library', 'Application Support', APP_IDENTIFIER);
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDir(env), 'AppData', 'Roaming');
    return path.join(appData, APP_IDENTIFIER);
  }
  const xdg = env.XDG_DATA_HOME || path.join(homeDir(env), '.local', 'share');
  return path.join(xdg, APP_IDENTIFIER);
}

export function dbxDbPath(dataDir) {
  return dataDir ? path.join(dataDir, 'dbx.db') : '';
}

/** Resolve DBX's data directory: DBX_DATA_DIR if set, else Tauri's app_data_dir when dbx.db exists. */
export function resolveDbxDataDir(env = process.env, platform = process.platform) {
  const override = String(env.DBX_DATA_DIR ?? '').trim();
  if (override) {
    return fs.existsSync(dbxDbPath(override)) ? override : '';
  }
  const candidate = defaultDbxDataDir(env, platform);
  return fs.existsSync(dbxDbPath(candidate)) ? candidate : '';
}

export function paths(env = process.env, platform = process.platform) {
  const root = magpieConfigRoot(env);
  const dataDir = resolveDbxDataDir(env, platform);
  return {
    root,
    dataDir,
    db: dbxDbPath(dataDir),
    homeLink: path.join(root, HOME_LINK),
    selection: path.join(root, SELECTION_FILE),
    state: path.join(root, STATE_FILE),
  };
}

/**
 * Maintain ~/.config/magpie/dbx-home -> DBX data dir so Magpie detects DBX.
 * Never removes a real directory and never recursively deletes through the link.
 */
export function syncHomeLink(env = process.env, platform = process.platform) {
  const target = resolveDbxDataDir(env, platform);
  const link = path.join(magpieConfigRoot(env), HOME_LINK);

  let stat = null;
  try {
    stat = fs.lstatSync(link);
  } catch (err) {
    if (err?.code !== 'ENOENT') return { ok: false, reason: err.message, link };
  }

  if (stat && !stat.isSymbolicLink()) {
    return { ok: false, reason: `${link} already exists and is not a link`, link };
  }

  if (!target) {
    if (stat) fs.unlinkSync(link);
    return { ok: false, reason: 'DBX database (dbx.db) not found', link };
  }

  if (stat) {
    try {
      if (fs.realpathSync(link) === fs.realpathSync(target)) {
        return { ok: true, created: false, link, target };
      }
    } catch {
      /* dangling link; replace below */
    }
    fs.unlinkSync(link);
  }

  fs.mkdirSync(path.dirname(link), { recursive: true });
  // 'junction' needs no admin rights on Windows and is ignored on POSIX.
  fs.symlinkSync(target, link, 'junction');
  return { ok: true, created: true, link, target };
}

export function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, missing: err?.code === 'ENOENT', error: err?.message ?? String(err) };
  }
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
