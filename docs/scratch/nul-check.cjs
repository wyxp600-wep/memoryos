const fs = require("fs");
const NUL = String.fromCharCode(0);
for (const f of process.argv.slice(2)) {
    const b = fs.readFileSync(f, "utf8");
    let i = -1, n = 0, first = null;
    while ((i = b.indexOf(NUL, i + 1)) >= 0) { n++; if (first === null) first = i; }
    console.log(f, "NUL:", n, first !== null ? "first@ctx=" + JSON.stringify(b.slice(Math.max(0, first - 30), first + 30).replace(new RegExp(NUL, "g"), "X")) : "");
}
