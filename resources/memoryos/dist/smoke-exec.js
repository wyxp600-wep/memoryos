#!/usr/bin/env node
/**
 * MemoryOS — 执行面 P0 验收冒烟（**git 纳管版**）
 * 原版在 `.workbuddy/tmp/smoke-exec.mjs`，但 `.workbuddy/` 被 .gitignore 忽略 ⇒ 无 git 回滚链、
 * 清理 tmp 即永久丢失（与 F18「新代码没进 git」同型问题）。本文件是唯一权威副本，tmp 版为遗留。
 *
 * 用法：cd resources/memoryos && node dist/smoke-exec.js
 * 隔离：全部动作发生在 mkdtemp 临时工作区 + 临时库内，退出即自清理，**绝不触碰生产库**。
 * 覆盖：① 单元级（needsGate / pickTools / truncateToolResult / resolveInside）
 *       ② 无头门禁语义（F7 用户决策 c）③ MCP 真调用三工具的正常与安全拒绝路径
 *       ④ exec_audit 落行与脱敏
 * 退出码：0 全绿 / 1 有失败
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { needsGate, pickTools, truncateToolResult, parseRiskPrefix } from "./agent-core.js";
import { makeHeadlessGate, makeAutoWriteGate } from "./agent.js";
import { resolveInside } from "./exec-tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));      // …/resources/memoryos/dist
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-exec-smoke-"));
const DB = path.join(WS, "smoke-exec.db");
const SHIM = path.join(WS, "agent-fpath.txt");                   // 不指向任何真实客户端配置
fs.writeFileSync(SHIM, "smoke-exec\n", "utf8");

let failed = 0, passed = 0;
function check(name, cond, detail = "") {
    if (cond) { passed++; console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
    else { failed++; console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}
const cleanup = () => { try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on("exit", cleanup);

/* ── 起 MCP 服务端（临时工作区 + 临时库）────────────────────── */
const proc = spawn(process.execPath, [path.join(HERE, "server.js")], {
    env: {
        ...process.env,
        MEMORY_DB: DB,
        MEMORY_AGENT: "smoke-exec",
        MEMORY_AGENT_FPATH: SHIM,
        MEMORYOS_WORKSPACE: WS,          // ← 执行面工作区锁定到临时目录
        MEMORYOS_EXEC_ON: "1",          // ★ P0-2 后执行面默认关闭，验收须显式开启
        MEMORYOS_EXEC_OFF: "",          // 显式确保熔断开关未置 1
    },
    windowsHide: true,
});
let buf = "";
let lastId = 0;
const pending = new Map();
function send(method, params) {
    const id = ++lastId;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}
proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r(msg); }
    }
});
const textOf = (resp) => (resp?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
const call = async (name, args) => textOf(await send("tools/call", { name, arguments: args }));

try {
    /* ── ① 单元级：不依赖服务端 ───────────────────────────── */
    check("needsGate：L1 前缀 → 需审批", needsGate({ name: "file_write", description: "⟨risk:L1|gate:required⟩ x" }) === true);
    check("needsGate：L0 前缀 → 放行", needsGate({ name: "file_read", description: "⟨risk:L0|gate:auto⟩ x" }) === false);
    check("needsGate：无前缀回落静态名单（memory_write 需审批）", needsGate({ name: "memory_write", description: "无前缀" }) === true);
    check("needsGate：无前缀且不在名单 → 放行（仅旧服务端兼容路径）", needsGate({ name: "some_readonly", description: "无前缀" }) === false);
    check("parseRiskPrefix 解析 L4 fail-closed", parseRiskPrefix("⟨risk:L4|gate:required⟩ y")?.risk === "L4");

    const all = [{ function: { name: "a" } }, { function: { name: "b" } }];
    check("pickTools(undefined) = 全量", pickTools(all, undefined).length === 2);
    check("pickTools([]) = 零工具（★ 修 F17：旧实现会回落成全量）", pickTools(all, []).length === 0);
    let threw = false; try { pickTools(all, ["a", "typo"]); } catch { threw = true; }
    check("pickTools 含未知名 → 抛错（不再静默）", threw);

    const long = "HEAD_MARKER\n" + "x".repeat(9000) + "\nTAIL_ERROR_MARKER";
    const tr = truncateToolResult(long);
    check("truncateToolResult 保留头部", tr.includes("HEAD_MARKER"));
    check("truncateToolResult 保留尾部（★ 修 F3：错误在尾部，旧实现会丢）", tr.includes("TAIL_ERROR_MARKER"));

    threw = false; try { resolveInside(WS, "../../Windows/win.ini"); } catch { threw = true; }
    check("resolveInside 拒绝越界路径", threw);
    threw = false; try { resolveInside(WS, "\\\\server\\share\\x"); } catch { threw = true; }
    check("resolveInside 拒绝 UNC 路径", threw);

    /* ── ② 无头门禁语义（★ P0 修 F7，用户决策「方案 c」）────── */
    const hg = makeHeadlessGate();
    const _err = console.error; console.error = () => { };   // 静音门禁日志
    const hTaskDone = await hg("task_done", {});
    const hClaim = await hg("task_claim", {});
    const hMemWrite = await hg("memory_write", {});
    const hFileWrite = await hg("file_write", {});
    const hExec = await hg("exec_run", {});
    const hObsidian = await hg("obsidian_write_note", {});
    const ag = await makeAutoWriteGate()("file_write", {});
    console.error = _err;
    check("F7① --work 预授权 task_done（否则无人值守无法结项）", hTaskDone === true);
    check("F7② --work 预授权 task_claim", hClaim === true);
    check("F7③ --work 预授权 memory_write", hMemWrite === true);
    check("F7④ --work 拒绝执行类 file_write（旧行为=全放行）", hFileWrite === false);
    check("F7⑤ --work 拒绝 exec_run", hExec === false);
    check("F7⑥ --work 拒绝 obsidian_write_note（写工作区外 vault）", hObsidian === false);
    check("F7⑦ --auto-write 显式全放行", ag === true);

    /* ── ③ MCP 级：真调三个工具 ───────────────────────────── */
    await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-exec", version: "1" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await send("tools/list", {})).result?.tools ?? [];
    check("tools/list 含执行面三工具", ["file_read", "file_write", "exec_run"].every((n) => tools.some((t) => t.name === n)), `count=${tools.length}`);
    check("执行工具都带风险前缀", tools.filter((t) => ["file_read", "file_write", "exec_run"].includes(t.name)).every((t) => parseRiskPrefix(t.description) !== null));

    fs.mkdirSync(path.join(WS, "sub"), { recursive: true });
    fs.writeFileSync(path.join(WS, "sub", "a.txt"), "第一行\n第二行\n第三行\n", "utf8");

    const r1 = await call("file_read", { path: "sub/a.txt" });
    check("file_read 正常读取", r1.includes("第一行") && r1.includes("第三行"), r1.split("\n")[0]);

    const r2 = await call("file_read", { path: "../../Windows/win.ini" });
    check("file_read 越界被拒", r2.includes("越界") || r2.includes("执行失败"), r2.slice(0, 80));

    const r3 = await call("file_write", { path: "sub/new.txt", content: "hello-p0" });
    check("file_write 新建成功", fs.existsSync(path.join(WS, "sub", "new.txt")) && r3.includes("新建"), r3.split("\n")[0]);

    const r4 = await call("file_write", { path: "sub/new.txt", content: "hello-p0-v2" });
    const bak = fs.readdirSync(path.join(WS, "sub")).filter((f) => f.includes(".bak-p0exec-"));
    check("file_write 覆盖前自动备份（B2 纪律工具化）", bak.length === 1 && r4.includes("改前备份"), `backups=${bak.join(",")}`);

    const r5 = await call("exec_run", { cmd: ["node", "-e", "console.log('EXEC_OK_42')"] });
    check("exec_run 正常执行", r5.includes("EXEC_OK_42") && r5.includes("exit=0"), r5.split("\n")[1]);

    const r6 = await call("exec_run", { cmd: ["curl", "http://127.0.0.1:9/"] });
    check("exec_run 非白名单命令被拒", r6.includes("不在允许清单") || r6.includes("执行失败"), r6.slice(0, 80));

    const r7 = await call("exec_run", { cmd: ["node", "-e", "setTimeout(()=>{},60000)"], timeout_ms: 1500 });
    check("exec_run 超时①标记 TIMEOUT", r7.includes("TIMEOUT"), r7.split("\n")[1]);
    check("exec_run 超时②提示进程树已终止", r7.includes("进程树已终止"));

    const r8 = await call("exec_run", { cmd: ["node", "-e", "console.log(1)"], cwd: "../.." });
    check("exec_run cwd 越界被拒", r8.includes("越界") || r8.includes("执行失败"), r8.slice(0, 80));

    const r9 = await call("exec_run", { cmd: ["node", "-e", "for(let i=0;i<900;i++)console.log('LINE_'+i)"] });
    check("大输出落 artifact 并回传路径（修 F3）", /完整输出：.*artifacts/.test(r9) && fs.existsSync((r9.match(/完整输出：(.+)/) ?? [])[1]?.trim() ?? ""));
    check("大输出仍保留尾部（LINE_8xx 可见）", /LINE_8\d\d/.test(r9));

    proc.kill();
    await new Promise((r) => setTimeout(r, 700));

    /* ── ④ 审计落行 ──────────────────────────────────────── */
    const db = new DatabaseSync(DB, { readOnly: true });
    const rows = db.prepare("SELECT tool,risk,approval,detail FROM exec_audit ORDER BY id").all();
    const byTool = (t) => rows.filter((r) => r.tool === t).length;
    check("exec_audit 有记录（P0 验收：≥3 行）", rows.length >= 3, `rows=${rows.length}`);
    check("exec_audit 覆盖三工具", byTool("file_read") > 0 && byTool("file_write") > 0 && byTool("exec_run") > 0, `file_read=${byTool("file_read")} file_write=${byTool("file_write")} exec_run=${byTool("exec_run")}`);
    check("exec_audit 记录了风险级", rows.every((r) => /^L[0-4]$/.test(r.risk)));
    check("exec_audit 参数摘要已隐去敏感键", !JSON.stringify(rows).includes("Bearer "));
    db.close();
} catch (e) {
    failed++;
    console.log(`FAIL  冒烟脚本异常：${e instanceof Error ? e.stack : String(e)}`);
} finally {
    if (!proc.killed) proc.kill();
}

console.log(`\n== 执行面 P0 冒烟：${passed} PASS / ${failed} FAIL ==`);
process.exit(failed ? 1 : 0);
