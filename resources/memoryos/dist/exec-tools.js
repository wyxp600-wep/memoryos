/**
 * MemoryOS — 执行工具面（P0）
 * 内容：file_read（L0 只读） / file_write（L1 必审 + 改前自动备份） / exec_run（L1 必审 + 参数数组执行 + cwd 白名单 + 超时杀进程树）
 * 设计要点（对应 docs/agent-completion/FINAL-补全方案.md）：
 *  ① TOOL_RISK 是**全部工具**（口径以 `Object.keys(TOOL_RISK)` / `node dist/smoke-toolrisk.mjs` 为准）的风险级/审批策略单一真相源 —— 修 F1（原先 agent-core.js:15-19 硬编码 WRITE_TOOLS）。
 *     server.js 在 addTool 覆写处把 `⟨risk:Lx|gate:required|auto⟩` 前缀注入工具描述；
 *     agent-core 从 tools/list 解析该前缀决定是否过 writeGate，**解析不到一律按需审批（fail-closed）**。
 *  ② 输出预算：stdout/stderr 各留 head 50 行 + tail 50 行，超限全文落 data/artifacts/ 并回传路径（修 F3 只保头部丢尾部）。
 *  ③ exec_run 用参数数组 spawn（**不用 shell 字符串拼接**，杜绝命令注入），执行前校验 cwd 在允许根内。
 *  ④ 每次调用写 exec_audit（append-only），审计失败不阻断执行。
 * 纪律：不写入凭据；路径一律经 resolveInside 校验（真实路径比对，防符号链接逃逸）。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

/* ── 风险表：全部工具（F1 单一真相源）──────────────────────────────
   L0 只读无副作用 / L1 工作区内变异 / L2 工作区外变异 / L3 网络 / L4 特权
   gate:true = 必须过 writeGate 审批；false = 自动放行                          */
export const TOOL_RISK = {
    // — 记忆域 —
    memory_search: { risk: "L0", gate: false },
    memory_read: { risk: "L0", gate: false },
    memory_ask: { risk: "L0", gate: false },
    memory_projects: { risk: "L0", gate: false },
    memory_context: { risk: "L0", gate: false },
    memory_report: { risk: "L0", gate: false },
    memory_health: { risk: "L0", gate: false },
    memory_write: { risk: "L1", gate: true },
    memory_feedback: { risk: "L1", gate: true },
    memory_cite: { risk: "L1", gate: true },
    memory_credential: { risk: "L4", gate: true },   // ★ 2026-09-22 补缺：凭据签发/撤销/查询 = 特权操作
    // — Obsidian 域 —
    obsidian_import: { risk: "L1", gate: true },
    obsidian_export: { risk: "L1", gate: true },
    obsidian_write_note: { risk: "L1", gate: true },
    // — 任务域 —
    task_next: { risk: "L0", gate: false },
    task_assign: { risk: "L1", gate: true },
    task_claim: { risk: "L1", gate: true },
    task_done: { risk: "L1", gate: true },
    task_supersede: { risk: "L1", gate: true },
    task_gate: { risk: "L1", gate: true },           // ★ 2026-09-22 补缺（方案 A 实用分级）
    task_delegate: { risk: "L1", gate: true },
    task_block: { risk: "L1", gate: true },
    task_reopen: { risk: "L1", gate: true },
    task_verify: { risk: "L1", gate: true },
    task_heartbeat: { risk: "L0", gate: false },     // 纯续期心跳，无人值守必需，自动放行
    task_release: { risk: "L1", gate: true },        // 归还锁/租约；无头预授权见 HEADLESS_PREAUTHORIZED
    // — 执行域（P0 新增）—
    file_read: { risk: "L0", gate: false },
    file_write: { risk: "L1", gate: true },
    exec_run: { risk: "L1", gate: true },
};

/** 无头（--work / --auto-write）模式的预授权白名单 —— 用户决策「方案 c」：
 *  仅 task_* 与 memory_* 预授权，**执行类 L1（file_write/exec_run 等）仍然拒绝**。
 *  注：obsidian_* 不在预授权内 —— 它们会写工作区外的 vault，无头模式下同样需要显式同意。
 *  ★ 2026-09-22（方案 A）：补 task_release —— 无头模式不归还锁/租约会泄漏资源；
 *    task_gate/delegate/block/reopen/verify 与 memory_credential **不在**预授权内（状态流转/特权仍需人）。 */
export const HEADLESS_PREAUTHORIZED = new Set([
    "task_assign", "task_claim", "task_done", "task_supersede", "task_release",
    "memory_write", "memory_feedback", "memory_cite",
]);

/** 描述前缀（agent-core 解析用）。★ 2026-09-22 fail-closed 兜底（用户拍板「server 注入端兜底」）：
 *  未知工具（不在 TOOL_RISK）返回 L4/required —— 注入端保证 tools/list 上 100% 工具带前缀，
 *  新增工具漏登记只会「多审批」，绝不会静默放行；agent-core 的 LEGACY_WRITE_TOOLS 回落
 *  仅服务真正未打前缀的旧 server（本端不再产生无前缀工具）。 */
export function riskPrefix(name) {
    const m = TOOL_RISK[name];
    if (!m) return "⟨risk:L4|gate:required⟩ ";
    return `⟨risk:${m.risk}|gate:${m.gate ? "required" : "auto"}⟩ `;
}

/* ── 输出预算与 artifact ─────────────────────────────────────── */
const OUT_BUDGET_BYTES = 4096;   // shell/文件读取的单流预算
const HEAD_LINES = 50;
const TAIL_LINES = 50;
const ARGS_DIGEST_MAX = 300;     // 审计里参数摘要上限
const DETAIL_MAX = 400;
const SENSITIVE_KEY = /(key|token|secret|password|passwd|credential|authorization)/i;

/** 参数摘要：截断 + 剔除敏感键值（审计绝不落凭据） */
export function digestArgs(args) {
    let s;
    try {
        s = JSON.stringify(args ?? {}, (k, v) => (SENSITIVE_KEY.test(k) ? "«已隐去»" : v));
    } catch { s = "(不可序列化)"; }
    return s.length > ARGS_DIGEST_MAX ? s.slice(0, ARGS_DIGEST_MAX) + `…(+${s.length - ARGS_DIGEST_MAX})` : s;
}

/** 把长文本切成 head/tail 摘要；返回 {text, truncated, totalBytes, totalLines} */
export function headTail(raw) {
    const s = String(raw ?? "");
    const totalBytes = Buffer.byteLength(s, "utf8");
    const lines = s.split(/\r?\n/);
    const totalLines = lines.length;
    const truncated = totalBytes > OUT_BUDGET_BYTES;
    if (!truncated) return { text: s, truncated: false, totalBytes, totalLines };
    const head = lines.slice(0, HEAD_LINES).join("\n");
    const tail = lines.slice(-TAIL_LINES).join("\n");
    return {
        text: `${head}\n\n…（中间省略 ${Math.max(0, totalLines - HEAD_LINES - TAIL_LINES)} 行 / 全文 ${totalLines} 行、${totalBytes} 字节，完整内容见 artifact）…\n\n${tail}`,
        truncated: true,
        totalBytes,
        totalLines,
    };
}

/** 大输出落盘，返回相对可读路径（失败返回 null，不阻断） */
function spillArtifact(dataDir, tool, text) {
    try {
        const dir = path.join(dataDir, "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const file = path.join(dir, `${tool}-${ts}-${crypto.randomBytes(3).toString("hex")}.txt`);
        fs.writeFileSync(file, String(text ?? ""), "utf8");
        return file;
    } catch (e) {
        // 落盘失败降级返回 null（工具主结果不受影响），但必须留痕——否则大输出静默丢失无从排查
        console.error(`[exec] artifact 落盘失败（${tool}）: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

/* ── 路径与命令安全 ─────────────────────────────────────────── */
/** 解析并强制路径落在允许根内（比对真实路径，防符号链接逃逸）；越界抛错 */
export function resolveInside(root, p) {
    if (typeof p !== "string" || !p.trim()) throw new Error("路径不能为空");
    if (/^\\\\|^\/\//.test(p)) throw new Error("拒绝 UNC 路径");
    const abs = path.resolve(root, p);
    const realRoot = fs.realpathSync(root);
    // 目标可能尚不存在（新建文件）：退化为校验其最近的已存在祖先目录
    let probe = abs;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    const realProbe = fs.realpathSync(probe);
    const inside = (target) => target === realRoot || target.startsWith(realRoot + path.sep);
    if (!inside(realProbe) || !inside(path.resolve(abs))) {
        throw new Error(`路径越界（必须位于工作区 ${realRoot} 内）：${p}`);
    }
    return abs;
}

/** 命令可执行文件白名单（保守默认：**不含 shell 宿主与脚本解释器**——cmd/powershell/pwsh/python
 *  一旦放行，["powershell","-Command","…"] 即绕过整个清单，等于没有白名单；
 *  确需时用 MEMORYOS_EXEC_ALLOW 显式加入，并自行承担 shell 逃逸面） */
export function execAllowlist() {
    const env = process.env.MEMORYOS_EXEC_ALLOW;
    if (env && env.trim()) return new Set(env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
    return new Set(["npm", "npx", "node", "git"]);
}

/** 杀整棵进程树（Windows 用 taskkill /T /F，与 services/core-process.js 既有模式一致） */
function killTree(child) {
    try {
        if (process.platform === "win32") {
            if (child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
            try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
    } catch { /* 已退出 */ }
}

/* ── 工具实现 ───────────────────────────────────────────────── */
/**
 * @param {object} o
 * @param {string} o.workspaceRoot 允许读写的工作区根（cwd 白名单）
 * @param {string} o.dataDir       内核数据目录（artifact 落 <dataDir>/artifacts）
 * @param {string} o.agent         调用方 agent 名（审计用）
 * @param {Function} o.logAudit    (row) => void ；审计写入，失败会被吞掉
 */
export function createExecTools({ workspaceRoot, dataDir, agent = "unknown", logAudit = () => { } }) {
    const audit = (row) => { try { logAudit({ agent, ...row }); } catch { /* 审计失败不阻断执行 */ } };

    return [
        /* ── file_read（L0，自动放行）──────────────────────── */
        {
            name: "file_read",
            description: `读取工作区内文本文件（带行号）。默认工作区：${workspaceRoot}`,
            parameters: z.object({
                path: z.string().describe("文件路径（相对工作区或工作区内绝对路径）"),
                offset: z.number().int().min(1).optional().describe("起始行（1 基），默认 1"),
                limit: z.number().int().min(1).max(2000).optional().describe("最多返回行数，默认 400"),
            }),
            async execute(args) {
                const t0 = Date.now();
                try {
                    const abs = resolveInside(workspaceRoot, args.path);
                    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${args.path}`);
                    const st = fs.statSync(abs);
                    if (st.isDirectory()) throw new Error(`这是目录，不是文件：${args.path}（目录浏览请用 file_list/glob）`);
                    const raw = fs.readFileSync(abs, "utf8");
                    const lines = raw.split(/\r?\n/);
                    const off = (args.offset ?? 1) - 1;
                    const lim = args.limit ?? 400;
                    const slice = lines.slice(off, off + lim);
                    const numbered = slice.map((l, i) => `${String(off + i + 1).padStart(5)}| ${l}`).join("\n");
                    const { text, truncated, totalLines } = headTail(numbered);
                    audit({ tool: "file_read", risk: "L0", approval: "auto", argsDigest: digestArgs(args), detail: `${totalLines} 行`, durationMs: Date.now() - t0 });
                    return `【file_read】${abs}\n共 ${lines.length} 行，返回第 ${off + 1}–${off + slice.length} 行${truncated ? "（已按预算裁剪）" : ""}\n${text}`;
                } catch (e) {
                    audit({ tool: "file_read", risk: "L0", approval: "auto", argsDigest: digestArgs(args), detail: `错误: ${e.message}`, durationMs: Date.now() - t0 });
                    throw e;
                }
            },
        },

        /* ── file_write（L1，必审；改前自动备份）──────────── */
        {
            name: "file_write",
            description: `写入/覆盖工作区内文本文件。默认改前自动生成时间戳备份（.bak-p0exec-<ts>）。工作区：${workspaceRoot}`,
            parameters: z.object({
                path: z.string().describe("文件路径（相对工作区或工作区内绝对路径）"),
                content: z.string().describe("完整文件内容（整文件覆盖）"),
                backup: z.boolean().optional().describe("是否在覆盖前备份，默认 true（仅对已存在文件生效）"),
            }),
            async execute(args) {
                const t0 = Date.now();
                let backupPath = null;
                try {
                    const abs = resolveInside(workspaceRoot, args.path);
                    const existed = fs.existsSync(abs);
                    if (existed && args.backup !== false) {
                        const ts = new Date().toISOString().replace(/[:.]/g, "-");
                        backupPath = `${abs}.bak-p0exec-${ts}`;
                        fs.copyFileSync(abs, backupPath);
                    }
                    fs.mkdirSync(path.dirname(abs), { recursive: true });
                    fs.writeFileSync(abs, String(args.content ?? ""), "utf8");
                    const bytes = Buffer.byteLength(String(args.content ?? ""), "utf8");
                    audit({ tool: "file_write", risk: "L1", approval: "gate-allowed", argsDigest: digestArgs(args), detail: `${existed ? "覆盖" : "新建"} ${bytes} 字节${backupPath ? " 已备份" : ""}`, durationMs: Date.now() - t0 });
                    return `【file_write】已${existed ? "覆盖" : "新建"} ${abs}（${bytes} 字节）${backupPath ? `\n改前备份：${backupPath}` : ""}`;
                } catch (e) {
                    audit({ tool: "file_write", risk: "L1", approval: "gate-allowed", argsDigest: digestArgs(args), detail: `错误: ${e.message}`, durationMs: Date.now() - t0 });
                    throw e;
                }
            },
        },

        /* ── exec_run（L1，必审；参数数组，无 shell 拼接）──── */
        {
            name: "exec_run",
            description: `在工作区内执行一条命令。参数为**数组**（如 ["npm","test"]，不经过 shell 拼接，故不支持管道/重定向）。cwd 受限于工作区；超时会杀掉整棵进程树。`,
            parameters: z.object({
                cmd: z.array(z.string()).min(1).describe('命令与参数数组，例：["npm","test"] 或 ["git","status","--short"]'),
                cwd: z.string().optional().describe("工作目录（相对工作区，默认工作区根）"),
                timeout_ms: z.number().int().min(1000).max(600000).optional().describe("超时毫秒，默认 30000，上限 600000"),
            }),
            async execute(args) {
                const t0 = Date.now();
                const timeoutMs = args.timeout_ms ?? 30000;
                const auditRow = { tool: "exec_run", risk: "L1", approval: "gate-allowed", argsDigest: digestArgs(args) };
                let cwd;
                try {
                    cwd = resolveInside(workspaceRoot, args.cwd ?? ".");
                    if (!fs.statSync(cwd).isDirectory()) throw new Error(`cwd 不是目录：${args.cwd}`);
                } catch (e) {
                    audit({ ...auditRow, detail: `cwd 校验失败: ${e.message}`, durationMs: Date.now() - t0 });
                    throw e;
                }
                const [exe, ...rest] = args.cmd;
                const base = path.basename(String(exe)).replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
                const allow = execAllowlist();
                if (!allow.has(base)) {
                    const msg = `命令 ${exe} 不在允许清单内（当前允许：${[...allow].join(", ")}）。如确需，请用安装/配置流程加入 MEMORYOS_EXEC_ALLOW。`;
                    audit({ ...auditRow, detail: msg, durationMs: Date.now() - t0 });
                    throw new Error(msg);
                }
                return await new Promise((resolve, reject) => {
                    const child = spawn(exe, rest, { cwd, windowsHide: true, shell: false, detached: process.platform !== "win32" });
                    let out = "", err = "", timedOut = false, settled = false;
                    const cap = OUT_BUDGET_BYTES * 8; // 采集上限（防内存爆），超出后仍继续接收但丢弃多余
                    child.stdout.on("data", (d) => { if (out.length < cap) out += d.toString(); });
                    child.stderr.on("data", (d) => { if (err.length < cap) err += d.toString(); });
                    const timer = setTimeout(() => {
                        timedOut = true;
                        killTree(child);
                    }, timeoutMs);
                    child.on("error", (e) => {
                        if (settled) return; settled = true; clearTimeout(timer);
                        audit({ ...auditRow, detail: `spawn 失败: ${e.message}`, durationMs: Date.now() - t0 });
                        reject(new Error(`命令启动失败：${e.message}`));
                    });
                    child.on("close", (code) => {
                        if (settled) return; settled = true; clearTimeout(timer);
                        const ms = Date.now() - t0;
                        const o = headTail(out), e2 = headTail(err);
                        let artifact = null;
                        if (o.truncated || e2.truncated) {
                            artifact = spillArtifact(dataDir, "exec_run", `$ ${args.cmd.join(" ")}\n[exit ${code}${timedOut ? " / TIMEOUT" : ""}]\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
                        }
                        const head = `【exec_run】$ ${args.cmd.join(" ")}  (cwd=${cwd})\nexit=${timedOut ? "TIMEOUT" : code}  用时 ${ms}ms${artifact ? `\n完整输出：${artifact}` : ""}`;
                        const body = `\n--- stdout (${o.totalLines} 行) ---\n${o.text || "(空)"}\n--- stderr (${e2.totalLines} 行) ---\n${e2.text || "(空)"}`;
                        audit({ ...auditRow, detail: `exit=${timedOut ? "TIMEOUT" : code} ${ms}ms out=${o.totalBytes}B err=${e2.totalBytes}B`, durationMs: ms });
                        if (timedOut) { resolve(`${head}${body}\n\n⚠ 已超时（${timeoutMs}ms），进程树已终止。`); return; }
                        if (code !== 0) { resolve(`${head}${body}\n\n⚠ 命令失败（退出码 ${code}）。请按 stderr 尾部定位（错误通常在尾部）。`); return; }
                        resolve(`${head}${body}`);
                    });
                });
            },
        },
    ];
}
