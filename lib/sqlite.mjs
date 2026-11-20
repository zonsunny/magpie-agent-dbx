// Thin SQLite adapter supporting Bun (Magpie plugin host) and Node 22+ (tests/doctor).
let sqliteCtor;

export async function openDatabase(filePath, { readonly = false } = {}) {
  if (!sqliteCtor) {
    if (typeof globalThis.Bun !== 'undefined') {
      const mod = await import('bun:sqlite');
      sqliteCtor = { kind: 'bun', Database: mod.Database };
    } else {
      const mod = await import('node:sqlite');
      sqliteCtor = { kind: 'node', DatabaseSync: mod.DatabaseSync };
    }
  }

  const db =
    sqliteCtor.kind === 'bun'
      ? new sqliteCtor.Database(filePath, readonly ? { readonly: true } : { create: false })
      : new sqliteCtor.DatabaseSync(filePath, { readOnly: readonly });

  if (!readonly) {
    db.exec('PRAGMA busy_timeout = 5000');
  }
  return db;
}

export function withImmediateTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}
