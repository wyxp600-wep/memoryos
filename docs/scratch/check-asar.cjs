const fs = require('fs');
const b = fs.readFileSync('C:/Users/WYX/Desktop/MemoryOS/resources/app.asar');
const jl = b.readUInt32LE(12);
const json = JSON.parse(b.slice(16, 16 + jl).toString());
let n = json.files;
for (const part of ['main.js']) n = n[part];
const base = 16 + jl;
const main = b.slice(base + Number(n.offset), base + Number(n.offset) + Number(n.size));
const s = main.toString();
console.log('asar main.js length:', s.length);
console.log('has _debugLog:', s.includes('_debugLog'));
console.log('has module loaded log:', s.includes('[MO] main.js module loaded'));
console.log('has KERNEL data:', s.includes('path.join(KERNEL, "data")'));
// show first 300 chars
console.log('--- first 400 chars ---');
console.log(s.slice(0, 400));
