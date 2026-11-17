/**
 * #700055 / #700056 —— 工具错误文案与 401 提示冒烟（零外部依赖，读真实工具面与真实 dashboard）
 *
 * 用法：node dist/smoke-error-messages.js
 * 覆盖：中文枚举错误 / 合法取值 / 下一步建议 / 锁竞争分流 / 缺 task_id 专属引导 /
 *       不暴露堆栈与本机路径 / 401 hint 绝对路径 + 浏览器与脚本两种带 token 方式 + JSON 返回体。
 */
import { FastMCP } from "fastmcp";
import { registerAllTools } from "./server-tools.js";
import { friendlyExecutionError, missingTaskIdError } from "./error-messages.js";
import { buildApp } from "./dashboard.js";
import { openDb } from "./db.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond) failed++;
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-err-msg-"));
const DB_PATH = path.join(WS, "memory.db");
const db = openDb(DB_PATH);
const container = new FastMCP({ name: "memory-hub", version: "0.2.0" });
const { tools } = registerAllTools(container, {
    db, AGENT: "smoke-error-messages", AGENT_FPATH: null, ENV_CRED: null, dbPath: DB_PATH,
});

/* ── ① ② 参数校验：任意工具传错枚举值，中文 + 合法取值 + 末尾下一步 ── */
const enumCases = [
    ["task_admin", { action: "foobar", memory_id: 1, reason: "x" }, "block / reopen / verify"],
    ["task_done", { memory_id: 1, conclusion: "x", acceptance_results: [{ item: 1, result: "nope" }] }, "pass / fail / na"],
];
for (const [name, args, legal] of enumCases) {
    let message = "";
    try {
        await tools.get(name).parameters["~standard"].validate(args);
    } catch (e) {
        message = e.message;
    }
    check(`${name} 枚举错误为中文并列出合法取值`,
        message.includes("取值不合法") && message.includes(legal) && message.includes("foobar") === (name === "task_admin"),
        message.slice(0, 90));
    check(`${name} 枚举错误末尾附下一步`, /下一步：/.test(message.split("\n").at(-1)), message.split("\n").at(-1) ?? "");
    check(`${name} 枚举错误不含英文 Zod 原文`, !/Invalid enum value|Please check the parameter/i.test(message));
}
// 合法参数仍原样放行（防包装把正常调用拦掉）
const valid = await tools.get("task_admin").parameters["~standard"].validate({ action: "block", memory_id: 1, reason: "x" });
check("合法枚举参数放行", valid.value?.action === "block");

/* ── ③ ④ 执行期：只有真锁竞争才建议重试 ── */
const ordinary = friendlyExecutionError("task_done", new Error("请指定 task_id（地图上的任务号）"));
const busy = friendlyExecutionError("memory_write", new Error("SQLITE_BUSY: database is locked"));
check("非锁竞争错误不再出现「若为 SQLite 锁竞争」", !ordinary.includes("若为 SQLite 锁竞争"), ordinary.slice(0, 100));
check("非锁竞争错误不带重试建议", !/重试/.test(ordinary.split("\n").at(-1)) || ordinary.includes("不要盲目重复调用"));
check("真锁竞争错误仍保留重试建议", busy.includes("SQLite 锁竞争") && busy.includes("重试"), busy.split("\n").at(-1));
check("错误消息末尾均有下一步", ordinary.trimEnd().split("\n").at(-1).startsWith("下一步：") && busy.trimEnd().split("\n").at(-1).startsWith("下一步："));

/* ── ⑤ task_done 缺 task_id：只给相关下一步，不夹带无关建议 ── */
const missing = await tools.get("task_done").execute({ conclusion: "x" });
const missingText = missing?.content?.[0]?.text ?? "";
check("task_done 缺 task_id 走专属中文引导", missingText.includes("缺少 task_id") && missingText.includes("task_done"), missingText.slice(0, 100));
check("缺 task_id 提示不含锁竞争/白跑业务", !missingText.includes("锁竞争") && !missingText.includes("不存在或非任务") && missing?.isError === true);
check("缺 task_id 提示只给一条相关下一步", (missingText.match(/下一步：/g) ?? []).length === 1 && missingText.includes("task_next"));
check("缺 task_id 提示不套执行失败模板", !missingText.includes("执行失败") && !missingText.includes("会话未中断"));
check("task_claim 无编号仍可列可做集（既有能力）", typeof tools.get("task_claim").parameters.shape.task_id !== "undefined"
    && missingTaskIdError("task_claim").includes("task_next"));

/* ── ⑥ 错误消息不暴露内部堆栈与文件路径 ── */
const winPath = "C:" + String.fromCharCode(92) + "Users" + String.fromCharCode(92) + "private" + String.fromCharCode(92) + "data" + String.fromCharCode(92) + "x.db";
const leaked = friendlyExecutionError("file_read", new Error(`ENOENT: no such file, open ${winPath}\n    at Object.open (node:internal/fs/promises:1:1)`));
check("错误消息脱敏 Windows 绝对路径", !leaked.includes(winPath) && leaked.includes("[路径]"), leaked.split("\n")[0]);
check("错误消息剔除堆栈帧", !leaked.includes("at Object.open") && !leaked.includes("node:internal"));
// 六字段业务文案须逐字保留（含相对路径，不能被误脱敏）
const sixFields = friendlyExecutionError("memory_write", new Error("MEMORY_BODY_FORMAT：缺状态。\n依据：\n复现脚本在 outputs/2026-11-03/ 下。"));
check("六字段业务文案逐字保留", sixFields.includes("MEMORY_BODY_FORMAT：缺状态。") && sixFields.includes("outputs/2026-11-03/"));
/* ★ #700055 第 6 条补强：相对内部实现路径（代码文件名 + 行号）必须脱敏，业务路径原样保留 */
const internalLeak = friendlyExecutionError("tool_x", new Error(`包装层失败：见 resources/memoryos/dist/server-tools.js:88 `.trim()));
check("错误消息脱敏相对内部实现路径（代码文件+行号）", !internalLeak.includes("server-tools.js:88") && internalLeak.includes("[内部位置]"), internalLeak.split("\n")[0]);
const bizPath = friendlyExecutionError("tool_y", new Error("依据：产物在 outputs/2026-11-07/fix-700055/dump.mjs 与 outputs/2026-11-07/fix-700055/sha256.txt"));
check("业务路径原样保留（含 .mjs 但无行号）", bizPath.includes("outputs/2026-11-07/fix-700055/dump.mjs") && bizPath.includes("sha256.txt"), bizPath.split("\n")[0]);

/* ── #700056 401 提示 ── */
const app = buildApp(db, { token: "smoke-token-not-a-secret" });
const r401 = await app.inject({ method: "GET", url: "/api/summary" });
const body = r401.json();
const hint = String(body.hint ?? "");
check("不带 token 访问 /api/* 返回 401 JSON", r401.statusCode === 401 && /application\/json/.test(String(r401.headers["content-type"])) && body.ok === false && body.error === "unauthorized");
const expectedTokenPath=process.env.MEMORYOS_DATA_DIR?path.join(process.env.MEMORYOS_DATA_DIR,'data','token'):process.env.MEMORY_DB?path.join(path.dirname(process.env.MEMORY_DB),'token'):path.join(process.env.APPDATA??os.homedir(),'MemoryOS','data','token');
check("hint 含当前配置对应的 token 绝对路径", path.isAbsolute(expectedTokenPath) && hint.includes(expectedTokenPath), hint.slice(0, 140));
check("hint 说明未启动桌面壳时的数据目录位置", hint.includes("运行数据目录") || hint.includes("未启动桌面壳"));
check("hint 同时覆盖浏览器与脚本两种带 token 方式", hint.includes("浏览器") && hint.includes("脚本") && hint.includes("?token=<令牌>"));
await app.close();

db.close();
try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响判定 */ }
console.log(failed ? `\nsmoke-error-messages: ${failed} FAIL` : "\nsmoke-error-messages: 全绿");
process.exit(failed ? 1 : 0);
