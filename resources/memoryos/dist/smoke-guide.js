/**
 * 接入向导单测（connectGuideFor + applyConnectWrite，注入内存 fsx，不碰真实配置）
 * G1 codex：可自动写 + TOML 片段含 [[mcp_servers]]，未连接状态
 * G2 zcode（未实证载体）：canAutoWrite=false + 手动步骤非空，绝不自动写
 * G3 applyConnectWrite dry-run：可自动写的 agent 返回 ok，但 fsx.write 未被调用（不落盘）
 * G4 applyConnectWrite 实际写：备份 + 追加片段 + 返回 backupPath；未实证 agent 返回 error
 * 用法：npx tsx src/smoke-guide.ts
 */
import { connectGuideFor, applyConnectWrite } from "./scan.js";
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
function fakeAgent(id, name = id) {
    return { id, name, type: "CLI Agent", version: null, connected: false, path: null };
}
/** 内存文件系统（记录 writes / copies） */
function memFsx() {
    const files = {};
    const writes = [];
    const copies = [];
    return {
        fsx: {
            read: (p) => files[p] ?? "",
            exists: (p) => p in files,
            mkdir: () => { },
            copy: (p, d) => { copies.push(`copy:${p}->${d}`); files[d] = files[p] ?? "backup"; },
            write: (p, c) => { writes.push(p); files[p] = c; },
        },
        files, writes, copies,
    };
}
// G1 codex：可自动写
const codexA = fakeAgent("codex", "OpenAI Codex CLI");
const m1 = memFsx();
const g1 = connectGuideFor(codexA, { read: (p) => m1.fsx.read(p) });
check("G1.codex canAutoWrite=true", g1.canAutoWrite === true, `auto=${g1.canAutoWrite}`);
check("G1.codex TOML 片段含 [[mcp_servers]]", (g1.attachSnippet || "").includes("[[mcp_servers]]") && (g1.attachSnippet || "").includes("memoryos"));
// G2 未实证（zcode）→ 手动
const zcodeA = fakeAgent("zcode", "ZCode");
const g2 = connectGuideFor(zcodeA, { read: () => "" });
check("G2.zcode canAutoWrite=false", g2.canAutoWrite === false);
check("G2.zcode manualSteps 非空", !!g2.manualSteps && g2.manualSteps.length > 0, `steps=${g2.manualSteps?.length}`);
check("G2.zcode snippet 是 JSON + 含绝对路径(可复制即用)", !!g2.manualSnippet && g2.manualSnippet.includes('"memoryos"') && g2.manualSnippet.includes("C:/Users/WYX") && !g2.manualSnippet.includes("memoryos\\dist"), g2.manualSnippet?.slice(0, 60));
check("G2.zcode steps 含绝对路径(非相对)", g2.manualSteps?.some(s => s.includes("C:/Users/WYX")) === true);
// G3 dry-run：codex 返回 ok 但 write 未调用
const m3 = memFsx();
m3.files["C:\\Users\\WYX\\.codex\\config.toml"] = ""; // 已存在空 config
const r3 = applyConnectWrite(codexA, { dryRun: true }, m3.fsx);
check("G3.dry-run ok", r3.ok === true);
check("G3.dry-run 未落盘(write 未调)", m3.writes.length === 0, `writes=${m3.writes.length}`);
// G4 实际写：备份 + 追加 + backupPath；未实证报 error
const m4 = memFsx();
m4.files["C:\\Users\\WYX\\.codex\\config.toml"] = "# existing\n";
const r4 = applyConnectWrite(codexA, {}, m4.fsx);
check("G4.codex 实际写 ok + backup", r4.ok === true && !!r4.backupPath, `bk=${r4.backupPath?.slice(-30)}`);
check("G4.codex 写入含 memoryos 片段", (m4.files["C:\\Users\\WYX\\.codex\\config.toml"] || "").includes("[[mcp_servers]]"), "injected");
check("G4.codex 做了备份(copy)", m4.copies.length === 1, `copies=${m4.copies.length}`);
const r5 = applyConnectWrite(zcodeA, {}, m4.fsx);
check("G4.zcode 拒绝自动写(error)", r5.ok === false && !!r5.error, `err=${r5.error?.slice(0, 30)}`);
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
