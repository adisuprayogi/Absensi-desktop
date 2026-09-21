'use strict';

/**
 * better-sqlite3 menolak objek parameter kosong ("Too many parameter values"),
 * jadi objek hanya diikutkan bila benar-benar berisi.
 */
function bindAll(stmt, positional = [], named = null) {
  const hasNamed = named && Object.keys(named).length > 0;
  if (positional.length && hasNamed) return stmt.all(...positional, named);
  if (positional.length) return stmt.all(...positional);
  if (hasNamed) return stmt.all(named);
  return stmt.all();
}

function bindGet(stmt, positional = [], named = null) {
  const hasNamed = named && Object.keys(named).length > 0;
  if (positional.length && hasNamed) return stmt.get(...positional, named);
  if (positional.length) return stmt.get(...positional);
  if (hasNamed) return stmt.get(named);
  return stmt.get();
}

/** Daftar tanda tanya untuk klausa IN (...). */
function placeholders(arr) {
  return arr.length ? arr.map(() => '?').join(',') : 'NULL';
}

module.exports = { bindAll, bindGet, placeholders };
