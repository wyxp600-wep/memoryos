/**
 * MemoryOS Dashboard P0 阶段优化回归验证套件
 * 运行方式: node test-p0-verify.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

const baseDir = path.resolve(__dirname,'..');
const htmlPath = path.join(baseDir, "index.html");
const appPath = path.join(baseDir, "app.js");
const fontsDir = path.join(baseDir, "fonts");

const html = fs.readFileSync(htmlPath, "utf8");
const app = fs.readFileSync(appPath, "utf8");

let passed = 0;
let failed = 0;

function check(title, fn) {
  try {
    fn();
    console.log(`  [PASS] ${title}`);
    passed++;
  } catch (e) {
    console.error(`  [FAIL] ${title}: ${e.message}`);
    failed++;
  }
}

console.log("=== MemoryOS Dashboard P0 Regression Suite ===");

// 1. 渲染缺陷消除
console.log("\n[Group 1: 渲染缺陷修复]");
check("表头 height: 100px 彻底消除", () => {
  assert(!html.includes("height: 100px\" data-sort"), "仍有 table header height 100px");
});

check("allCount 仅有 1 个合法的 style 属性（双 style 语法错误已修复）", () => {
  const line = html.split("\n").find(l => l.includes("id=\"allCount\""));
  assert(line, "未找到 allCount 元素");
  const count = (line.match(/style=/g) || []).length;
  assert.strictEqual(count, 1, `allCount 属性中 style 数量应为 1，实为 ${count}`);
});

check("开发构建标记 UI 09-11 已清除", () => {
  assert(!html.includes("UI 09-11 23:36"), "开发时间戳仍然残留");
});

check("HTML body 区域浅色模式隐形的 rgba(255,255,255,0.06/0.6) 内联白底已清零", () => {
  const bodyIdx = html.indexOf("<body");
  const bodyHtml = bodyIdx !== -1 ? html.substring(bodyIdx) : html;
  const count = (bodyHtml.match(/background:\s*rgba\(255\s*,\s*255\s*,\s*255/g) || []).length;
  assert.strictEqual(count, 0, `body 区域依然残留 ${count} 处内联白色透明背景`);
});

check("跨工具协同假数据占位已替换为动态 ID 容器", () => {
  assert(html.includes("id=\"crossToolCount\""), "缺失 crossToolCount ID");
  assert(html.includes("id=\"crossRefRate\""), "缺失 crossRefRate ID");
  assert(html.includes("id=\"crossTopWriter\""), "缺失 crossTopWriter ID");
});

// 2. 样式层级去重与冲突消除
console.log("\n[Group 2: 样式层级去重与冲突消除]");
check("完全重复的 .agent-run-status 样式块已移除（仅保留唯一定义）", () => {
  const count = (html.match(/\.agent-run-status\s*\{/g) || []).length;
  assert.strictEqual(count, 1, `.agent-run-status 定义次数应为 1，实为 ${count}`);
});

check("冲突的 6px 滚动条规则已安全移除", () => {
  assert(!html.includes("::-webkit-scrollbar { width: 6px; height: 6px; }"), "6px 冲突滚动条未删除");
});

check("旧版废弃 .cmd-palette 规则块已移除", () => {
  assert(!html.includes(".cmd-palette-list {"), "仍残留 .cmd-palette-list 规则");
});

check("旧版废弃 .topbar 规则块已移除，main-content 侧栏边距归零", () => {
  assert(!html.includes(".topbar-actions { display: flex; align-items: center; gap: 12px; }"), "仍残留 .topbar 规则");
  assert(!html.includes("margin-left: var(--sidebar-w);"), "main-content 仍残留旧侧栏边距");
});

check("设置弹窗宽度三方打架已收敛为统一规范 min(640px, 92vw)", () => {
  assert(!html.includes("style=\"width:560px"), "依然存在内联 560px 宽度");
  assert(!html.includes("#settingsModal .modal { width: 600px !important;"), "依然残留 important 弹窗宽度覆盖");
  assert(html.includes("#settingsModal .modal { width: min(640px, 92vw); }"), "缺少基础 min(640px, 92vw) 规范");
});

// 3. 性能优化与加载阻塞释放
console.log("\n[Group 3: 性能优化与加载阻塞释放]");
check("4 个 WOFF2 字体二进制文件提取就绪且体积合规", () => {
  const fonts = ["inter-400.woff2", "inter-600.woff2", "jetbrains-mono-400.woff2", "jetbrains-mono-600.woff2"];
  for (const f of fonts) {
    const p = path.join(fontsDir, f);
    assert(fs.existsSync(p), `字体缺失: ${f}`);
    assert(fs.statSync(p).size > 20000, `字体体积异常: ${f}`);
  }
});

check("HTML 中已添加核心字体的 preload 预加载标签", () => {
  assert(html.includes("<link rel=\"preload\" href=\"./fonts/inter-400.woff2\" as=\"font\""), "缺少 inter-400 preload");
  assert(html.includes("<link rel=\"preload\" href=\"./fonts/inter-600.woff2\" as=\"font\""), "缺少 inter-600 preload");
});

check("app.js 脚本标签已添加 defer 属性", () => {
  assert(html.includes("<script src=\"./app.js\" defer></script>"), "app.js 脚本标签缺少 defer 属性");
});

check("HTML 在恢复必要结构样式后仍小于原版体积的 82%", () => {
  const size = fs.statSync(htmlPath).size;
  assert(size < 350000, `HTML 尺寸未降至 350KB 以下 (当前: ${size} 字节，原 430KB)`);
});

// 4. 无障碍规范达标
console.log("\n[Group 4: 无障碍规范达标]");
check("7 个顶层导航 <a> 标签全部具备真实可聚焦的路由 href", () => {
  const routes = ["agent", "memory", "tasks", "obsidian", "govern", "rules", "skills"];
  for (const r of routes) {
    const reg = new RegExp(`class="nav-item"[^>]*data-route="${r}"[^>]*href="#${r}"|class="nav-item"[^>]*href="#${r}"[^>]*data-route="${r}"`);
    assert(reg.test(html), `导航路由 ${r} 缺少 href="#${r}"`);
  }
});

check("7 处无文字模态框关闭按钮全部具备 aria-label='关闭'", () => {
  const ids = ["approvalClose", "modalClose", "editModalClose", "shortcutsClose", "settingsClose", "connectModalClose", "sourceModalClose"];
  for (const id of ids) {
    const reg = new RegExp(`id="${id}"[^>]*aria-label="关闭"|<button[^>]*aria-label="关闭"[^>]*id="${id}"`);
    assert(reg.test(html), `关闭按钮 #${id} 缺失 aria-label="关闭"`);
  }
});

check("状态文字前景色加深满足 WCAG 4.5:1 对比度要求", () => {
  assert(html.includes(".run-card-state.ok { color: var(--success-ink, #15803d); }"), "运行成功文字未加深");
  assert(html.includes(".run-card-state.pending { color: var(--warning-ink, #b45309); }"), "运行等待文字未加深");
});

check("10px/11px 超小字号全部升级至 12px 基础字阶", () => {
  const smallMatches = html.match(/font-size:\s*1[01]px/g) || [];
  assert.strictEqual(smallMatches.length, 0, `仍然残留 ${smallMatches.length} 处 10px/11px 字号`);
});

// 5. app.js 动态计算逻辑验证
console.log("\n[Group 5: app.js 动态计算与数据绑定]");
check("app.js 静态语法验证通过", () => {
  const syntaxCheck = require("node:child_process").spawnSync(process.execPath, ["-c", appPath]);
  assert.strictEqual(syntaxCheck.status, 0, `app.js 存在语法错误: ${syntaxCheck.stderr.toString()}`);
});

console.log(`\n========================================`);
console.log(`P0 验证结果: ${passed} 通过, ${failed} 失败 (共 ${passed + failed} 项)`);
console.log(`========================================`);
process.exit(failed > 0 ? 1 : 0);
