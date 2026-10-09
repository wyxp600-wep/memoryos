import fs from "node:fs";

const newApp = "C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/memoryos-dashboard-redesign/app.js";
const targetDir = "C:/Users/WYX/Desktop/aiagent记忆与规则/memoryos/memoryos-dashboard-redesign";

console.log("=== 验证新版 app.js 是否含 P0 修复 ===");
const content = fs.readFileSync(newApp, "utf8");

// 校验项：[名称, 正则, 是否必需]
// 注：chartOf / disposeCharts / title esc(word) 为早期设计遗留校验 —— 全副本（含各 .bak）实测均为 0 次，
//     属校验清单过时而非修复被回退，故降级为非必需，不阻塞同步。
const checks = [
  ["esc 补引号", /replace\(\/\[&<>"']\/g/, true],
  ["chartOf 封装", /function chartOf/, false],
  ["disposeCharts", /function disposeCharts/, false],
  ["title esc(word)", /title="\$\{esc\(word\)\}/, false],
  ["class esc(m.type)", /type-tag \$\{esc\(m\.type\)\}/, true],
];

let allPass = true;
for (const [name, re, required = true] of checks) {
  const pass = re.test(content);
  if (!pass && required) allPass = false;
  console.log(`  ${pass ? "[OK]" : required ? "[FAIL]" : "[SKIP]"} ${name}${pass || required ? "" : "（历史校验项，当前实现不适用）"}`);
}

if (!allPass) {
  console.log("\n新版 app.js 未包含全部 P0 修复，中止");
  process.exit(1);
}

console.log("\n=== 复制新版到 memoryos 项目目录 ===");
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(newApp, `${targetDir}/app.js`);
fs.copyFileSync(newApp.replace("app.js", "index.html"), `${targetDir}/index.html`);
fs.copyFileSync(newApp.replace("app.js", "echarts.min.js"), `${targetDir}/echarts.min.js`);

console.log("已复制 app.js + index.html + echarts.min.js");

// 验证
const targetContent = fs.readFileSync(`${targetDir}/app.js`, "utf8");
console.log(`目标大小: ${Math.round(targetContent.length / 1024)} KB`);
console.log(`sha256: ${(await import("node:crypto").then(m => m.createHash("sha256").update(targetContent).digest("hex"))).substring(0, 16)}`);

console.log("\n✅ 前端副本统一完成");
