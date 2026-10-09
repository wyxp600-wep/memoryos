const { DatabaseSync } = require('node:sqlite');
const path = 'C:/Users/WYX/AppData/Roaming/MemoryOS/data/memory.db';

// 1. check pragmas
const db = new DatabaseSync(path);
console.log('journal_mode:', db.prepare('PRAGMA journal_mode').get());
console.log('readonly flag:', db.prepare('PRAGMA readonly').get());
console.log('integrity:', db.prepare('PRAGMA integrity_check').get());
console.log('foreign_key_check (skipped, expensive on big db)');
db.close();

// 2. copy db to temp dir, write to the COPY
const fs = require('fs');
const tmp = 'C:/Users/WYX/Desktop/MemoryOS/_rwcopy_test';
fs.mkdirSync(tmp, { recursive: true });
fs.copyFileSync(path, tmp + '/memory.db');
const db2 = new DatabaseSync(tmp + '/memory.db');
try {
  db2.exec('CREATE TABLE IF NOT EXISTS _rw_probe(x INTEGER)');
  console.log('COPY write OK -> source db is likely NOT corrupted, lock/attr issue on the original');
  db2.exec('DROP TABLE _rw_probe');
} catch (e) {
  console.log('COPY write FAILED too -> db file itself is corrupted/readonly on disk:', e.message);
}
db2.close();
fs.rmSync(tmp, { recursive: true, force: true });
