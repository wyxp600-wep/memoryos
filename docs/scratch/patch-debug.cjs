const fs = require('fs');
const p = 'C:/Users/WYX/Desktop/MemoryOS/main.js';
let m = fs.readFileSync(p, 'utf8');
const before = m.length;

// 找到 readConfig 函数（精确匹配原始 5 行形式）
const oldRead = [
  'function readConfig() {',
  '  try {',
  '    return JSON.parse(fs.readFileSync(configFile(), "utf8"));',
  '  } catch {',
  '    return null;',
  '  }',
'].join('\n');
const newRead = [
  'function readConfig() {',
  '  try {',
  '    const raw = fs.readFileSync(configFile(), "utf8");',
  '    fs.appendFileSync("C:/Users/WYX/Desktop/MemoryOS/exe-debug.log", "[MO] readConfig OK " + configFile() + "\\n");',
  '    return JSON.parse(raw);',
  '  } catch (e) {',
  '    fs.appendFileSync("C:/Users/WYX/Desktop/MemoryOS/exe-debug.log", "[MO] readConfig FAILED: " + e.message + " " + configFile() + "\\n");',
  '    return null;',
  '  }',
].join('\n');

if (m.includes(oldRead)) {
  m = m.replace(oldRead, newRead);
  console.log('readConfig patched');
} else {
  console.log('readConfig pattern NOT found, trying to locate...');
  const idx = m.indexOf('function readConfig()');
  console.log('readConfig at index:', idx);
  console.log('context:', m.slice(idx, idx + 200));
}

// finalizeStartup
const oldFin = 'async function finalizeStartup(cfg) {';
const newFin = 'async function finalizeStartup(cfg) {\n  fs.appendFileSync("C:/Users/WYX/Desktop/MemoryOS/exe-debug.log", "[MO] finalizeStartup called, dataDir=" + dataDir() + ", KERNEL=" + KERNEL + "\\n");';
if (m.includes(oldFin)) {
  m = m.replace(oldFin, newFin);
  console.log('finalizeStartup patched');
} else {
  console.log('finalizeStartup pattern NOT found');
}

fs.writeFileSync(p, m);
console.log('done, before=' + before + ' after=' + m.length);
