import {preferences,sourceAllowed} from './personal-settings.js';
const MEMORIES = "main.knowledge_records"; // ★ 2026-11-17（B4 组7）：导入导出/规则反思直连记忆物理表（merge-db 保持视图，它能读旧单库）
/**
 * MemoryOS — 采集消化（ingest）：读取本机各 AI Agent 的明文记忆/规则/对话，提炼入库。
 * 流程：源发现 → 读文本 → 分块 → 本地嵌入 → 库内相似去重 → LLM 提炼 → writeMemory 入库。
 * 只覆盖「明文可读」的知识源；不可读（私有/加密/沙箱）如实不采。
 * 用法：getSources() 枚举可采源；ingestAll(db,{dryLimit}) 执行。
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHash } from 'node:crypto';
import { memoryFields } from './memory-fields.js';
import { getEmbedder, cosine } from "./embed.js";
import { logUsage, logDaemon, getVectorsOnProject, getIngestStates, setIngestState } from "./db.js";
import { createMemoryRow } from "./memory-writer.js"; // ★ 2026-11-17（B8 前置）：写入直连物理表，不再经 temp.memories 视图
import { extractFromSource } from "./llm.js";
const MAX_CALLS = Math.max(1, Number(process.env.INGEST_MAX_CALLS ?? 80) || 80); // 单轮 LLM 提炼总次数上限（默认80，覆盖环境变量）
const BLOCKS_PER_SOURCE = 12; // 每源最多提炼块数（防单源吃掉全部预算）
// ★ 2026-11-08（卡外 item3）：同源块级熔断阈值 —— 同一源连续 N 块提炼失败即跳过该源本轮剩余块。
//   典型触发是 429 限流/鉴权失效：继续逐块重试只是空刷配额并拖长整轮时长。
//   恢复条件：下一轮采集 srcFailStreak 归零自然重试；该源同时受 noteSourceFailure 的 30min→6h 退避约束。
const SRC_FAIL_STREAK_MAX = Math.max(1, Number(process.env.INGEST_SRC_FAIL_STREAK_MAX ?? 3) || 3);
const home = os.homedir();
/** 明文知识源清单：以「真实存在」为准，运行时可读才返回 */
const SOURCE_SPECS = [
    { id: "codex-rules", agent: "codex", name: "Codex 规则 default.rules", kind: "rule", exp: (h) => [`${h}/.codex/rules/default.rules`] },
    { id: "codex-agents", agent: "codex", name: "Codex 全局约束 AGENTS.md", kind: "rule", exp: (h) => [`${h}/.codex/AGENTS.md`] },
    { id: "codex-mem-raw", agent: "codex", name: "Codex 原始记忆 raw_memories", kind: "memory", exp: (h) => [`${h}/.codex/memories/raw_memories.md`] },
    { id: "codex-mem-diff", agent: "codex", name: "Codex 工作区差异记忆", kind: "memory", exp: (h) => [`${h}/.codex/memories/phase2_workspace_diff.md`] },
    { id: "codex-mem-rollout", agent: "codex", name: "Codex 会话摘要(rollout)", kind: "memory", exp: (h) => glob(`${h}/.codex/memories/rollout_summaries/*.md`, { maxFiles: 15, includeFilter: (n) => /report-summary|session-summary/i.test(n) }) },
    { id: "zcode-mem", agent: "zcode", name: "ZCode 记忆", kind: "memory", exp: (h) => glob(`${h}/.zcode/cli/memories/**`, { maxFiles: 20, maxDepth: 2 }) },
    { id: "zcode-log", agent: "zcode", name: "ZCode 对话日志 jsonl", kind: "convo", exp: (h) => glob(`${h}/.zcode/cli/log/*.jsonl`, { maxFiles: 8, includeFilter: (n) => /\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) }) },
    { id: "zcode-agents", agent: "zcode", name: "ZCode 会话 agents", kind: "convo", exp: (h) => glob(`${h}/.zcode/cli/agents/sess_*/transcript.jsonl`, { maxFiles: 8, maxDepth: 2, includeFilter: (n) => n === "transcript.jsonl" }) },
    { id: "claude-config", agent: "claude", name: "Claude 配置 config.json", kind: "rule", exp: (h) => [`${h}/.claude/config.json`] },
    { id: "claude-settings", agent: "claude", name: "Claude 设置 settings.json", kind: "rule", exp: (h) => [`${h}/.claude/settings.json`] },
    { id: "wb-memory", agent: "workbuddy", name: "WorkBuddy MEMORY", kind: "rule", exp: (h) => [`${h}/.workbuddy/MEMORY.md`] },
    { id: "wb-user", agent: "workbuddy", name: "WorkBuddy USER", kind: "memory", exp: (h) => [`${h}/.workbuddy/USER.md`] },
    { id: "wb-soul", agent: "workbuddy", name: "WorkBuddy SOUL", kind: "rule", exp: (h) => [`${h}/.workbuddy/SOUL.md`] },
    { id: "wb-identity", agent: "workbuddy", name: "WorkBuddy IDENTITY", kind: "memory", exp: (h) => [`${h}/.workbuddy/IDENTITY.md`] },
    { id: "wbai-memory", agent: "workbuddy-ai", name: "WorkBuddy AI UUID 记忆", kind: "memory", exp: (h) => glob(`${h}/.workbuddy-ai/memory/*_memory.md`, { maxFiles: 20, maxDepth: 1, includeFilter: (n) => /_memory\.md$/.test(n) && !n.endsWith(".bak") }) },
    // Trae CN 记忆系统（~/.trae-cn/memory/）
    { id: "trae-user-profile", agent: "trae", name: "Trae 用户画像 user_profile", kind: "memory", exp: (h) => [`${h}/.trae-cn/memory/user_profile.md`] },
    { id: "trae-project-mem", agent: "trae", name: "Trae 项目记忆 project_memory", kind: "memory", exp: (h) => glob(`${h}/.trae-cn/memory/projects/*/project_memory.md`, { maxFiles: 10, maxDepth: 3, includeFilter: (n) => n === "project_memory.md" }) },
    { id: "trae-topics", agent: "trae", name: "Trae 会话主题 topics", kind: "convo", exp: (h) => glob(`${h}/.trae-cn/memory/projects/**/topics.md`, { maxFiles: 30, maxDepth: 4, includeFilter: (n) => n === "topics.md" }) },
    { id: "trae-session-jsonl", agent: "trae", name: "Trae 会话明细 session_memory", kind: "convo", transform: "trae-learned", exp: (h) => glob(`${h}/.trae-cn/memory/projects/**/session_memory_*.jsonl`, { maxFiles: 20, maxDepth: 4, includeFilter: (n) => n.startsWith("session_memory_") && n.endsWith(".jsonl") }) },
    // ── 2026-09-11 补采：审计日志风险事件 + 各 Agent 会话记录（实测这些源此前完全未采）──
    { id: "wb-audit", agent: "workbuddy", name: "WorkBuddy 审计日志(风险/决策事件)", kind: "convo", transform: "audit-jsonl", exp: (h) => glob(`${h}/.workbuddy/audit-log/*.jsonl`, { maxFiles: 8, maxDepth: 1, includeFilter: (n) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(n) }) },
    { id: "wbai-audit", agent: "workbuddy-ai", name: "WorkBuddy AI 审计日志(风险/决策事件)", kind: "convo", transform: "audit-jsonl", exp: (h) => glob(`${h}/.workbuddy-ai/audit-log/*.jsonl`, { maxFiles: 8, maxDepth: 1, includeFilter: (n) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(n) }) },
    { id: "claude-sessions", agent: "claude", name: "Claude Code 会话记录", kind: "convo", exp: (h) => glob(`${h}/.claude/projects/*/*.jsonl`, { maxFiles: 6, maxDepth: 2, includeFilter: (n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n) }) },
    { id: "codex-archived", agent: "codex", name: "Codex 归档会话", kind: "convo", exp: (h) => glob(`${h}/.codex/archived_sessions/*.jsonl`, { maxFiles: 4, maxDepth: 1 }) },
];
/**
 * L1 源（内容本身已是「提炼好的结论」）→ 免 LLM 直读入库。
 * 判据：文件本身就是人/Agent 写下的结论，而非过程记录。对这类内容再跑一次 LLM 提炼
 * 属于「二次蒸馏」——只会丢信息、不会增价值，还白白消耗提炼预算。
 */
const L1_SOURCE_IDS = new Set([
    // 规则 / 约束类
    "codex-rules", "codex-agents", "wb-memory", "wb-user", "wb-soul", "wb-identity",
    // 已沉淀记忆类
    "codex-mem-raw", "codex-mem-diff", "codex-mem-rollout", "zcode-mem", "wbai-memory",
    // 已加工摘要类（learned[] / topics / project_memory / 用户画像）
    "trae-user-profile", "trae-project-mem", "trae-topics", "trae-session-jsonl",
]);
export function customSourcesPath() {
    if (process.env.MEMORY_SOURCES)
        return process.env.MEMORY_SOURCES;
    // APPDATA 优先；缺失时按平台回退到家目录（CLI / 非 Electron 启动场景，APPDATA 可能未注入）
    const appdata = process.env.APPDATA ||
        (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Roaming") : path.join(os.homedir(), ".config"));
    return appdata ? path.join(appdata, "MemoryOS", "sources.json") : "";
}
/** 读用户自定义源；文件不存在 / 解析失败 → 返回空数组（绝不影响内置源） */
export function loadCustomSpecs() {
    const p = customSourcesPath();
    if (!p)
        return [];
    try {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        const arr = Array.isArray(j) ? j : j?.sources;
        if (!Array.isArray(arr))
            return [];
        return arr.filter((s) => s && typeof s.id === "string" && typeof s.path === "string");
    }
    catch {
        return [];
    }
}
/** ★ 2026-11-16 安全加固（M-5）：采集源的敏感路径闸。
 *  自定义源允许任意绝对路径（用户导入自己的笔记），但不能把凭据/密钥/系统目录
 *  变成「可检索记忆」。目录级拒绝 + 文件级扩展名拒绝，双层。
 *  需排除时用 MEMORYOS_INGEST_DENY_OFF=1（明确知情，自行承担）。 */
const INGEST_SENSITIVE_SEG_RE = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config[\\/]gcloud|AppData|Windows|Program Files|Program Files \(x86\))([\\/]|$)/i;
const INGEST_SENSITIVE_EXT_RE = /\.(pem|key|pfx|p12|jks|keystore|env|db|db-wal|db-shm|sqlite|sqlite3|cookies?|credentials|token|secret)$/i;
function ingestDenyOn() {
    return process.env.MEMORYOS_INGEST_DENY_OFF !== "1";
}
export function isSensitiveIngestPath(p) {
    if (!ingestDenyOn())
        return false;
    const s = String(p ?? "").replace(/\\/g, "/");
    return INGEST_SENSITIVE_SEG_RE.test(s) || INGEST_SENSITIVE_EXT_RE.test(s);
}
/** 校验单个自定义源：路径合法性 + 展开后的文件数/总大小/样例（不写盘，供前端预检）
 *  只接受绝对路径（`C:\…` / `/…`）或 `~` 开头的家目录路径，拒绝相对路径（避免 cwd 歧义）。 */
export function validateCustomSource(spec) {
    const raw = String(spec.path ?? "").trim();
    if (!raw)
        return { ok: false, error: "路径不能为空", files: 0, totalBytes: 0, samples: [] };
    if (!/^~[/\\]/.test(raw) && !/^[a-zA-Z]:[/\\]/.test(raw) && !raw.startsWith("/")) {
        return { ok: false, error: "请填绝对路径（如 C:\\Users\\you\\notes）或以 ~ 开头的家目录路径", files: 0, totalBytes: 0, samples: [] };
    }
    // ★ 2026-11-16（M-5）：敏感目录（.ssh/.aws/AppData/Windows/Program Files…）一律拒绝
    if (isSensitiveIngestPath(raw))
        return { ok: false, error: "该路径属于敏感目录（凭据/系统目录），不允许作为采集源；如确需请设 MEMORYOS_INGEST_DENY_OFF=1 自行承担风险", files: 0, totalBytes: 0, samples: [] };
    const maxFiles = Math.min(Math.max(Number(spec.maxFiles ?? 50) || 50, 1), 200);
    const maxDepth = Math.min(Math.max(Number(spec.maxDepth ?? 3) || 3, 0), 6);
    let re;
    if (spec.includeFilter) {
        try {
            re = new RegExp(spec.includeFilter, "i");
        }
        catch {
            return { ok: false, error: "includeFilter 不是合法正则", files: 0, totalBytes: 0, samples: [] };
        }
    }
    // 统一为正斜杠：glob 内部用 lastIndexOf("/") 取 pattern 尾部，反斜杠会导致尾部判定失效
    const expanded = raw.replace(/^~(?=[/\\])/, home).replace(/\\/g, "/");
    const filter = re ? (n) => re.test(n) : undefined;
    let files = [];
    try {
        if (expanded.includes("*")) {
            files = glob(expanded, { maxFiles, maxDepth, includeFilter: filter });
        }
        else if (fs.existsSync(expanded)) {
            const st = fs.statSync(expanded);
            if (st.isDirectory())
                files = glob(`${expanded.replace(/\/+$/, "")}/**`, { maxFiles, maxDepth, includeFilter: filter });
            else if (st.isFile())
                files = [expanded];
        }
    }
    catch (e) {
        return { ok: false, error: `路径展开失败：${e instanceof Error ? e.message : String(e)}`, files: 0, totalBytes: 0, samples: [] };
    }
    files=files.filter(f=>sourceAllowed(f,spec.id||''));
    if (!files.length) {
        return {
            ok: false,
            error: "该路径下未找到可采集的文本文件（仅收 .md/.txt/.rules/.jsonl；请检查路径是否存在、或 includeFilter 是否把文件全过滤掉了）",
            files: 0,
            totalBytes: 0,
            samples: [],
        };
    }
    let totalBytes = 0;
    for (const f of files) {
        try {
            totalBytes += fs.statSync(f).size;
        }
        catch {
            /* 单个文件不可读 → 跳过统计 */
        }
    }
    return { ok: true, files: files.length, totalBytes, samples: files.slice(0, 3), truncated: files.length >= maxFiles };
}
/** 写用户自定义源（整表覆盖，写入 `sources.json`）；写前备份原文件。
 *  安全约束：只写 customSourcesPath() 指向的文件，绝不动内置 SOURCE_SPECS。 */
export function saveCustomSpecs(specs) {
    const p = customSourcesPath();
    if (!p)
        return { ok: false, error: "无法定位 sources.json（APPDATA 不可用且未设 MEMORY_SOURCES）", path: "" };
    let backupPath;
    try {
        if (fs.existsSync(p)) {
            backupPath = `${p}.bak-${Date.now()}`;
            fs.copyFileSync(p, backupPath);
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ sources: specs }, null, 2), "utf8");
        return { ok: true, path: p, backupPath };
    }
    catch (e) {
        console.error(`[sources] sources.json 保存失败（${p}）: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, error: e instanceof Error ? e.message : String(e), path: p, backupPath };
    }
}
/** 枚举真实存在、非空、可读的源文件（同一物理文件仅归属首个匹配的 spec，避免重复采集） */
export function sourceCatalog(){ return SOURCE_SPECS.map(s=>({id:s.id,name:s.name,kind:s.kind,builtin:true})).concat(loadCustomSpecs().map(s=>({id:s.id,name:s.name||s.id,kind:s.kind,builtin:false}))); }
export function getSources() {
    const prefs=preferences();
    const out = [];
    const seen = new Set();
    for (const spec of SOURCE_SPECS) {
        for (const f of spec.exp(home)) {
            try {
                if (!f)
                    continue;
                const st = fs.statSync(f);
                if (!st.isFile() || st.size <= 0)
                    continue;
                // 按规范化路径去重：同一文件只归首个 spec 所有
                const norm = f.replace(/\\/g, "/");
                if (seen.has(norm))
                    continue;
                seen.add(norm);
                out.push({ id: spec.id, agent: spec.agent, name: spec.name, kind: spec.kind, path: f, size: st.size, transform: spec.transform, level: L1_SOURCE_IDS.has(spec.id) ? "L1" : "L2" });
            }
            catch {
                /* 不可读/不存在，跳过 */
            }
        }
    }
    // ── 用户自定义源（sources.json）：追加语义，与内置源按规范化路径去重 ──
    for (const c of loadCustomSpecs()) {
        // 停用状态（enabled=false）→ 不参与采集，但保留在配置里供前端展示与重新启用
        if (c.enabled === false)
            continue;
        // 统一正斜杠：glob 内部用 lastIndexOf("/") 判定 pattern 尾部，反斜杠会失效
        const expanded = c.path.replace(/^~(?=[/\\])/, home).replace(/\\/g, "/");
        const maxFiles = Math.min(Math.max(Number(c.maxFiles ?? 50) || 50, 1), 200);
        const maxDepth = Math.min(Math.max(Number(c.maxDepth ?? 3) || 3, 0), 6);
        let filter;
        if (c.includeFilter) {
            try {
                const re = new RegExp(c.includeFilter, "i");
                filter = (n) => re.test(n);
            }
            catch {
                continue; // 正则非法 → 跳过该源，不影响其他源
            }
        }
        let files = [];
        try {
            if (expanded.includes("*")) {
                files = glob(expanded, { maxFiles, maxDepth, includeFilter: filter });
            }
            else if (fs.existsSync(expanded)) {
                const st = fs.statSync(expanded);
                // 目录：递归展开（此前只认 glob 与单文件，导致用户填目录时静默无源）
                if (st.isDirectory())
                    files = glob(`${expanded.replace(/\/+$/, "")}/**`, { maxFiles, maxDepth, includeFilter: filter });
                else if (st.isFile())
                    files = [expanded];
            }
        }
        catch {
            continue;
        }
        for (const f of files) {
            try {
                const st = fs.statSync(f);
                if (!st.isFile() || st.size <= 0)
                    continue;
                const norm = f.replace(/\\/g, "/");
                if (seen.has(norm))
                    continue;
                seen.add(norm);
                out.push({
                    id: c.id,
                    agent: c.agent,
                    name: c.name,
                    kind: c.kind ?? "memory",
                    path: f,
                    size: st.size,
                    transform: c.transform,
                    level: c.level ?? (L1_SOURCE_IDS.has(c.id) ? "L1" : "L2"),
                });
            }
            catch { /* ignore */ }
        }
    }
    return out.filter(f=>sourceAllowed(f.path,f.id,prefs));
}
/** 安全 glob：递归但带深度/文件数上限，跳过 .git 等内部目录，仅收文本扩展名。
 *  includeFilter(filename) 可进一步过滤文件名（如只收 project_memory.md）。
 *  未显式传 includeFilter 时，用 pattern 尾部 glob 段（最后一个 / 之后）生成默认过滤器：
 *  如 `*.md` → 只收 .md 结尾；`*_memory.md` → 收该模式；`project_memory.md` → 精确名。
 *  避免"写了 *.md 却收进 json/txt"的宽 glob 噪声。 */
function glob(pattern, opts = {}) {
    const { maxFiles = 300, maxDepth = 3, includeFilter } = opts;
    const results = [];
    let count = 0;
    let defaultFilter;
    if (pattern.includes("*")) {
        const tail = pattern.slice(pattern.lastIndexOf("/") + 1);
        if (tail !== "**") {
            if (tail.includes("*")) {
                const re = new RegExp("^" + tail.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
                defaultFilter = (n) => re.test(n);
            }
            else {
                defaultFilter = (n) => n === tail;
            }
        }
    }
    const walk = (dir, depth) => {
        // ★ 2026-09-22（A 分区跨区最小修复）：此处原为 `depth > maxDepth || results.length >= maxFiles`，
        //   在 for 循环内也有一次同样的提前 return。maxFiles 是**整棵目录树的全局上限**，
        //   一达上限即中止后续**所有**目录遍历，且收集顺序取 readdirSync 遍历序（非日期序）
        //   → 先遍历到的项目/日期吃光预算，其余目录永不访问。实测后果：trae session_memory
        //   磁盘 71 个文件只解析出最早的 20 个，该通道自 09-13 起停摆。现改为遍历不截断，
        //   收集后在函数尾部按 mtime 倒序取最近 maxFiles 个（见下方 statted 段）。
        if (depth > maxDepth)
            return;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (e.name === ".git")
                    continue;
                walk(path.join(dir, e.name), depth + 1);
            }
            else if (/\.(md|txt|rules|jsonl)$/i.test(e.name)) {
                const hit = includeFilter ?? defaultFilter;
                if (hit && !hit(e.name))
                    continue;
                results.push(path.join(dir, e.name));
                count++;
            }
        }
    };
    if (pattern.includes("*")) {
        const star = pattern.indexOf("*");
        const base = pattern.slice(0, star).replace(/[\/\\]+$/, "");
        // 归一化分隔符：Windows 混合路径（如 C:\Users\WYX/.trae-cn/...）会导致 lastIndexOf 截断错误
        const normBase = base.replace(/\\/g, "/");
        // 如果 base 本身就是一个已存在的目录，直接用它作为起点，否则取父目录
        const dir = fs.existsSync(normBase) && fs.statSync(normBase).isDirectory()
            ? normBase
            : (normBase.includes("/") ? normBase.slice(0, normBase.lastIndexOf("/")) : ".");
        walk(dir, 0);
    }
    else if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
        results.push(pattern);
    }
    // ★ 2026-09-22（A 分区跨区最小修复）：收集完成后按 mtime 倒序取最近 maxFiles 个。
    //   语义变化：maxFiles 由「遍历序前 N 个」改为「最近修改的 N 个」——后者才符合
    //   「同步最新会话/笔记」的意图，且不会因新目录加入而永久停摆。
    //   同时把原先的 isFile() 过滤合并进来（只 stat 一次，避免二次 I/O）。
    const statted = [];
    for (const f of results) {
        try {
            const st = fs.statSync(f);
            if (st.isFile())
                statted.push({ f, mtimeMs: st.mtimeMs });
        }
        catch { /* 取不到 stat 的跳过 */ }
    }
    statted.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return statted.slice(0, maxFiles).map((x) => x.f);
}
/** 读文件全文（失败返回 ''） */
export function readText(f, maxBytes = 50_000_000) {
    try {
        // ★ 2026-11-16（M-5）：文件级闸只按**扩展名**（.env/.pem/.key/.db…）拒绝。
        //   这里不套目录规则 —— 内置源可能位于 AppData 等目录，按目录拒绝会静默丢数据。
        if (ingestDenyOn() && INGEST_SENSITIVE_EXT_RE.test(String(f).replace(/\\/g, "/"))) {
            console.warn(`[ingest] 跳过敏感文件（安全策略）：${String(f).slice(0, 200)}`);
            return "";
        }
        const size=fs.statSync(f).size;
        if(size>maxBytes)throw new RangeError(`INGEST_SOURCE_TOO_LARGE: ${size} bytes exceeds ${maxBytes}; 未读取、未截断、未推进水位`);
        const buf = fs.readFileSync(f);
        return buf.toString("utf8");
    }
    catch (e) {
        if(e instanceof RangeError)throw e;
        return "";
    }
}
/**
 * 审计日志文本化（transform=audit-jsonl）。
 * 实测 WorkBuddy/WBAI 的 audit-log 中 96%+ 是 `command-safety.sandbox-executed / decision=allowed`
 * 的普通命令放行记录（`ls`/`cd` 之类），整份送 LLM 纯属浪费预算。
 * 只保留「风险/决策类」事件：被拒/被拦/失败/需审批/已审批/策略变更/命令被排除。
 * 无风险事件时返回空串（调用方会跳过该源）。
 */
function auditJsonlToText(raw, label) {
    const keep = [];
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let o;
        try {
            o = JSON.parse(line);
        }
        catch {
            continue;
        }
        const ev = String(o.eventType ?? "");
        const dec = String(o.decision ?? "");
        const interesting = /rejected|blocked|failed|denied/.test(dec) ||
            /needs-approval|rejected|blocked|failed|denied|updated|excluded|auto-approved|system-tool-confirm/.test(ev);
        if (!interesting)
            continue;
        let ts = "";
        const raw_ts = o.timestamp;
        if (raw_ts != null) {
            const n = Number(raw_ts);
            const d = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(String(raw_ts));
            if (!Number.isNaN(d.getTime()))
                ts = d.toISOString().slice(0, 19).replace("T", " ");
        }
        const cmd = String(o.commandPreview ?? "").replace(/\s+/g, " ").slice(0, 200);
        const params = o.messageParams ? JSON.stringify(o.messageParams).slice(0, 160) : "";
        const key = o.messageKey ? String(o.messageKey).split(".").pop() : "";
        keep.push(`[${ts}] ${ev} (${dec})${key ? " " + key : ""}${cmd ? " | " + cmd : ""}${params ? " | " + params : ""}`.trim());
    }
    if (!keep.length)
        return "";
    return `# ${label} —— 风险/决策事件 ${keep.length} 条（已过滤普通放行记录）\n` + keep.join("\n");
}
/** 从 Trae session_memory jsonl 抽取 learned[] 结论（免 LLM；与 shared-sync 同源同义） */
function traeLearnedToText(raw) {
    const uniq = new Set();
    for (const line of raw.split("\n")) {
        if (!line.trim())
            continue;
        let o;
        try {
            o = JSON.parse(line);
        }
        catch {
            continue;
        }
        const arr = o?.learned;
        if (!Array.isArray(arr))
            continue;
        for (const l of arr) {
            const t = typeof l === "string" ? l.trim() : "";
            if (t.length >= 20)
                uniq.add(t);
        }
    }
    return [...uniq].join("\n\n");
}
/**
 * L1 条目切分：以 markdown 列表项 / 小节标题为界聚合成「一条一记忆」。
 * 不用 1500 字硬切 —— L1 内容本身是结论，硬切会把一条完整结论劈成两半。
 */
export function splitL1Items(text) {
    const clean = String(text).replace(/\r\n?/g,'\n').trim();
    const conclusions=memoryFields(clean).filter(f=>f.name==='结论');
    if(conclusions.length)return conclusions.map((f,i)=>clean.slice(i?f.index:0,conclusions[i+1]?.index??clean.length).trim()).filter(t=>t.length>=20);
    const out = [];
    let cur = "",fence=null;
    const flush = () => { const t = cur.trim(); if (t.length >= 20)
        out.push(t); cur = ""; };
    for (const ln of clean.split(/\r?\n/)) {
        const mark=ln.trim().match(/^(`{3,}|~{3,})/);
        const inCode=!!fence;
        if(mark){if(!fence)fence=mark[1];else if(mark[1][0]===fence[0]&&mark[1].length>=fence.length)fence=null;}
        const isBoundary = !inCode&&!mark&&/^(?:[-*+]\s|\d+[.、)]\s|#{1,6}\s)/.test(ln);
        if (isBoundary && cur.trim())
            flush();
        cur = cur ? cur + "\n" + ln : ln;
    }
    flush();
    return out;
}
/**
 * L1 轻量门禁：只挡真正不可用的内容。
 * 注意：这里**刻意不用 garbledRatio** —— 它的白名单不含 `\ | > * + = % ~ @ # $ ^ <` 等符号，
 * 而 L1 源多为规则/路径密集的 markdown（表格、加粗、Windows 路径 `C:\...`），
 * 用它会误杀大量正常内容（首次实跑 513 块被拒 320 条，62%）。改用控制字符判定「真乱码」。
 */
export function l1Gate(content) {
    const t = content.trim();
    if (t.length < 20)
        return false;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufff0-\uffff]/.test(t))
        return false; // 控制字符 / 特殊区
    if (/^#{1,6}\s*$/.test(t))
        return false; // 纯标题行
    // ★ 2026-11-01（记忆库整理，本次归档 120 条结构碎片的根因）：
    //   ① 纯引用条目——只有反引号片段（路径/命令/URL）与标点，没有一句可复用的判断；
    //   ② 单行标题——没有正文的裸标题，分块后只剩标题本身。
    //   两条判据都放在既有白名单之后：规则/路径密集的 markdown 仍按原口径放行，
    //   只挡「去掉引用与标点后什么都不剩」的条目。
    if (/^#{1,6}\s/.test(t) && !t.includes("\n"))
        return false; // 单行标题（无正文）
    const bare = t
        .replace(/`[^`\n]*`/g, "")            // 去反引号片段
        .replace(/^[\s>*+\-#\d.、)]+/, "")    // 去 markdown 列表/标题前缀
        .replace(/[及和与或、]/g, "")          // 去并列连接词（`a`及`b` 这类纯清单）
        .replace(/[\p{P}\p{S}\s]/gu, "");     // 去标点、符号、空白
    if (bare.length === 0 && /`/.test(t))
        return false; // 纯引用条目
    return true;
}
/** 按源的 transform 规则取文本；返回空串表示该源本轮无有效内容 */
export function readSourceText(src) {
    const raw = readText(src.path);
    if (!raw)
        return "";
    if (src.transform === "audit-jsonl")
        return auditJsonlToText(raw, src.name);
    if (src.transform === "trae-learned")
        return traeLearnedToText(raw);
    return raw;
}
/** 记录采集水位（源处理完成后调用）。
 *  ⚠️ L1 分支与 L2 分支都要调 —— L1 用 `continue` 提前跳出，会跳过循环末尾的统一写法，
 *  否则 L1 永远不写水位、每轮全量重读（实测：41 个 L1 文件全部缺水位的根因）。 */
function markIngestState(db, src) {
    try {
        const st = fs.statSync(src.path);
        setIngestState(db, src.path, st.size, Math.floor(st.mtimeMs));
    }
    catch { /* 文件消失则忽略 */ }
}
/* ── ★ #700059（2026-11-07）：失败源退避 + 死信 ──────────────────────────────
 * 背景：原实现 srcLlmFail>0 就整源不写水位（下方 markIngestState 的 old 判据），
 *   一个块 429 会让整个源每轮从同一处重跑 —— 实测 desktop.log 7 天 1,103 次「提炼失败」，
 *   settings.json 水位停在 3,617B/10-31，真实已 24,658B/11-07（漏采 7 天）。
 * 现改为：
 *   ① 失败不再阻塞水位（按源推进到文件末尾），但失败块必须落 dead-letter（可精确重放）；
 *   ② 失败源按 fail_count 指数退避（30min→6h 封顶），冷却期内不读文件、不调 LLM；
 *   ③ 退避状态落在 ingest_state 的新列，跨进程/跨重启有效（不再依赖单轮内存的 srcLlmFailStreak）。
 * 为什么不用「块内逐条位移」：ingest_state 只有 (size,mtime)，没有字节偏移；readSourceText
 *   每次读整文件，逐条位移既不减少读放大，又要多维护一套游标与一致性；而入库前的向量去重
 *   (cos>0.92) 已能保证已采内容不会重复写入。故取「源级推进 + 块级死信」，代价最小且可观测。
 */
const RETRY_BASE_MIN = 30;
const RETRY_MAX_MIN = 360;
/** 指数退避分钟数：30 → 60 → 120 … 封顶 360（6h） */
export function backoffMinutes(failCount) {
    const n = Math.max(1, Math.min(Number(failCount) || 1, 10));
    return Math.min(RETRY_BASE_MIN * 2 ** (n - 1), RETRY_MAX_MIN);
}
/** 幂等补齐退避列 + 死信表；只读库/旧库不允许 ALTER 时静默降级为「无退避」但流程不中断。
 *  死信为什么落独立表而不是塞 daemon_log：daemon_log 是审计流水（写入量已 27 万行、无保留策略），
 *  死信是「待重放队列」，需要按源/块精确查（source+block+fp）且要存正文才能脱离原文件重放；
 *  混进审计表既查不快也难清理，故单开一张小表（每轮至多 BLOCKS_PER_SOURCE 行/源）。 */
function ensureIngestColumns(db) {
    try {
        const cols = db.prepare("PRAGMA table_info(ingest_state)").all().map((c) => c.name);
        if (!cols.includes("fail_count"))
            db.exec("ALTER TABLE ingest_state ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0");
        if (!cols.includes("next_retry_at"))
            db.exec("ALTER TABLE ingest_state ADD COLUMN next_retry_at TEXT");
        if (!cols.includes("last_error"))
            db.exec("ALTER TABLE ingest_state ADD COLUMN last_error TEXT");
        db.exec(`CREATE TABLE IF NOT EXISTS ingest_dead_letters (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            source     TEXT    NOT NULL,
            name       TEXT,
            block      INTEGER NOT NULL DEFAULT -1,
            chars      INTEGER NOT NULL DEFAULT 0,
            fp         TEXT,
            error      TEXT,
            content    TEXT,
            created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ingest_dl_source ON ingest_dead_letters(source, created_at);`);
        return true;
    }
    catch {
        return false; // 迁移失败不阻断采集（退化为原行为）
    }
}
/** 读源的退避状态；无行/无列 → null（当作可采） */
function retryStateOf(db, p) {
    try {
        return db.prepare("SELECT fail_count, next_retry_at FROM ingest_state WHERE path = ?").get(p) ?? null;
    }
    catch {
        return null;
    }
}
/** 记一次失败：fail_count+1 并按退避算 next_retry_at；不写 size/mtime（水位另由 markIngestState 推进） */
function noteSourceFailure(db, src, errMsg, failCount) {
    try {
        const next = new Date(Date.now() + backoffMinutes(failCount) * 60000).toISOString();
        const msg = String(errMsg).slice(0, 300);
        const cur = db.prepare("SELECT size, mtime_ms FROM ingest_state WHERE path = ?").get(src.path);
        if (cur) {
            db.prepare(`UPDATE ingest_state SET fail_count = ?, next_retry_at = ?, last_error = ?,
                last_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE path = ?`).run(failCount, next, msg, src.path);
        }
        else {
            db.prepare(`INSERT INTO ingest_state(path, size, mtime_ms, last_at, fail_count, next_retry_at, last_error)
                VALUES(?, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?)`).run(src.path, failCount, next, msg);
        }
    }
    catch { /* 退避落库失败不阻断本轮 */ }
}
/** 成功一轮 → 清退避（保留水位，由 markIngestState 单独写） */
function clearSourceFailure(db, p) {
    try {
        db.prepare("UPDATE ingest_state SET fail_count = 0, next_retry_at = NULL, last_error = NULL WHERE path = ?").run(p);
    }
    catch { /* 旧库无列时忽略 */ }
}
/** 死信摘要：块内容指纹（FNV-1a）→ 让「哪一块失败」可被精确重放 */
function blockFingerprint(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}
/** 死信：失败块落 ingest_dead_letters，带正文 → 即使水位已推进、原文件后续再变，也能脱离文件重放。
 *  block = -1 表示「整源级失败」（嵌入失败，一个块都没进 LLM）。 */
function logDeadLetter(db, src, blockIndex, block, errMsg) {
    try {
        const body = String(block ?? "");
        db.prepare(`INSERT INTO ingest_dead_letters(source, name, block, chars, fp, error, content)
            VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
            src.path,
            src.name ?? "",
            blockIndex,
            body.length,
            blockFingerprint(body),
            String(errMsg).slice(0, 300),
            body,
        );
    }
    catch { /* 死信落库失败不阻断采集（stats.deadLetters 仍有计数） */ }
}
/** 按段落分块，每块约 ~1500 字符；单段落超长按 size 硬切，避免块膨胀 */
/** 成本治理·渐进压缩（P1 CostGuard「渐进式压缩-降级-终止」第一级）：
 * 预算吃紧时把输入块压缩到 ≤45% 再送 LLM（省 token），保留句首与结论性句子。 */
function compressBlock(block, ratio = 0.45) {
    const lines = String(block).split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 4)
        return lines.join("\n");
    // 启发式：保留含结论/数值/路径/命令的句子（信息密度高），丢过程性叙述
    const keep = lines.filter((l) => /(。|结论|原因|解法|路径|命令|http|\.js|\.md|exit=|错误|踩坑|决策)/.test(l));
    const pool = keep.length ? keep : lines;
    const cap = Math.max(2, Math.round(pool.length * ratio));
    // 头部 + 尾部双端保留（中段截断），与 agent-core 截断口径一致
    const head = pool.slice(0, Math.ceil(cap / 2));
    const tail = pool.slice(-Math.ceil(cap / 2));
    const seen = new Set(head);
    for (const t of tail)
        if (!seen.has(t))
            head.push(t);
    return head.join("\n").slice(0, 700);
}
export function chunk(text, size = 1500) {
    const blocks = [];
    let cur = "";
    for (const para of text.split(/\n{2,}|\r?\n/)) {
        let p = para.trim();
        if (!p)
            continue;
        // 单段超长：按 size 硬切
        while (p.length > size) {
            if (cur) {
                blocks.push(cur.trim());
                cur = "";
            }
            blocks.push(p.slice(0, size));
            p = p.slice(size);
        }
        if ((cur + "\n" + p).length > size && cur) {
            blocks.push(cur.trim());
            cur = p;
        }
        else {
            cur = cur ? cur + "\n" + p : p;
        }
    }
    if (cur.trim())
        blocks.push(cur.trim());
    return blocks;
}
/** 非中英文/常用标点/空白字符占比——专治 "CONFI ICT" / "fail-e nfiumf" 类乱码 */
function garbledRatio(text) {
    const chars = [...text];
    if (!chars.length)
        return 1;
    const bad = chars.filter((ch) => !/[\u4e00-\u9fff\u3400-\u4dbf\w\s，。；：、（）【】《》""''！？…—·,.?!;:()\-{}\[\]]/u.test(ch)).length;
    return bad / chars.length;
}
function hardGate(content) {
    if (content.length < 20)
        return { verdict: "reject", reason: "过短<20字信息量不足" };
    if (content.length > 800)
        return { verdict: "review", reason: "过长>800字" };
    if (garbledRatio(content) >= 0.02)
        return { verdict: "reject", reason: `乱码占比${(garbledRatio(content) * 100).toFixed(1)}%` };
    if (/MemoryOS|记忆系统|memoryhub/i.test(content))
        return { verdict: "meta", reason: "Meta自指路由meta scope" };
    const t = content.toLowerCase();
    if (/^(闲聊|聊天|你好|谢谢|再见|开心|难过)/.test(t))
        return { verdict: "reject", reason: "闲聊前缀" };
    if (/心情|日常|人设|性格|爱好|兴趣|喜欢.+?不喜欢/.test(t))
        return { verdict: "reject", reason: "闲聊词" };
    if (/^[①②③④⑤⑥⑦⑧⑨⑩一二三四五六七八九十]/.test(content))
        return { verdict: "reject", reason: "序号流水账" };
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufff0-\uffff]/.test(content))
        return { verdict: "reject", reason: "控制字符" };
    if (/(正在|即将|下一步|待办|今天|明天|收尾|进行中)/.test(t))
        return { verdict: "review", reason: "过程性词转审查" };
    if (/(可能|也许|大概|应该是|猜测)/.test(t))
        return { verdict: "review", reason: "猜测性转审查" };
    return { verdict: "pass", reason: "ok" };
}
/** 执行一轮采集：读全部源 → 分块 → 嵌入 → 库内去重 → LLM 提炼 → 入库。
 *  dryLimit>0 时只处理前 dryLimit 个源（调试用）；出错单源跳过不中断。 */
export async function ingestAll(db, dryLimit = 0, opts = {}) {
    const stats = { sources: 0, files: 0, chunks: 0, skippedDup: 0, skippedUnchanged: 0, skippedBackoff: 0, deadLetters: 0, l1Inserted: 0, l1Files: 0, llmFail: 0, inserted: 0, qualityReject: 0, gateReview: 0, gateMeta: 0, terminatedSources: [], items: [], errors: [] };
    // ★ #700059：退避列 + 死信表幂等迁移（首次运行自动建；失败则退化为原行为，不阻断采集）
    const hasRetryCols = ensureIngestColumns(db);
    // 原文与分块进度分开保留：预算耗尽只能暂停，不能把未尝试的尾部标成已读。
    db.exec(`CREATE TABLE IF NOT EXISTS ingest_source_snapshots(hash TEXT PRIMARY KEY,source TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS ingest_block_progress(source TEXT PRIMARY KEY,hash TEXT NOT NULL,next_block INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ingest_item_sources(memory_id INTEGER NOT NULL,source_hash TEXT NOT NULL,block INTEGER NOT NULL,quote TEXT NOT NULL,PRIMARY KEY(memory_id,source_hash,block));`);
    const sources = getSources();
    stats.sources = sources.length;
    const all = dryLimit > 0 ? sources.slice(0, dryLimit) : sources;
    // l1Only：只跑免 LLM 的 L1 源（快速通道，用于验证 / 定时轻量跑）
    const picked = opts.l1Only ? all.filter((s) => (s.level ?? "L2") === "L1") : all;
    // 增量模式：已有水位的源，若 (size, mtime) 未变则跳过 —— 定时采集的空跑成本降到 stat 级
    const states = opts.incremental ? getIngestStates(db) : null;
    let embedder;
    try {
        embedder = (await getEmbedder());
    }
    catch (e) {
        stats.errors.push(`嵌入器不可用：${String(e)}`);
        return stats;
    }
    // 库内现有向量缓存（global scope，去重比较用）
    const existingContents = new Set(db.prepare(`SELECT content FROM ${MEMORIES} WHERE project='global' AND status IN ('active','trial')`).all().map(r=>r.content));
    let calls = 0; // 本轮 LLM 提炼次数，达 MAX_CALLS 停止后续源
    let budgetExhausted = false;
    // ★ P1 成本治理·三级渐进（CostGuard）：按已耗预算比例切档，不是一刀切 break
    //   L1 正常（<50% 预算）；L2 压缩（50–80%，输入块压缩到 45% 省 token，统计记 budgetCompress）；
    //   L3 降级+终止（≥80% 或 LLM 连续失败，剩余源跳过不再调 LLM，统计记 budgetDowngrade/budgetExhausted）。
    const budgetLevel = () => {
        const frac = calls / MAX_CALLS;
        if (frac >= 0.8 || (srcLlmFailStreak >= 3))
            return "downgrade";
        if (frac >= 0.5)
            return "compress";
        return "normal";
    };
    let srcLlmFailStreak = 0; // LLM 连续失败计数（触发降级的信号之一）
    let budgetCompress = 0;   // 预算治理统计
    let budgetDowngrade = 0;
    let budgetTerminated = 0;
    stats.budgetLevel = "normal"; // 最终档位（dashboard 展示）
    for (const src of picked) {
        // ★ P1 成本治理·三级渐进（CostGuard）：按已耗预算切档，不一刀切
        const level = budgetLevel();
        stats.budgetLevel = level; // 持续更新最终档位
        if (level === "downgrade") {
            // L3 降级+终止：剩余源跳过不再调 LLM（只放行 L1 免 LLM 源）
            budgetDowngrade++;
            if ((src.level ?? "L2") === "L2") {
                // ★ #700059：原实现只累加计数、没有 continue —— L2 源照旧读文件并调 LLM，
                //   熔断名存实亡。现在真正跳过，并记下被终止的源名以便与计数对账。
                budgetTerminated++;
                stats.terminatedSources.push(src.name);
                continue;
            }
        }
        if (budgetExhausted)
            break;
        if (calls >= MAX_CALLS) {
            budgetExhausted = true;
            break;
        }
        // ★ #700059：失败源退避冷却 —— 冷却期内整源跳过（不 stat / 不读 / 不调 LLM）
        let prevFail = 0;
        if (hasRetryCols) {
            const rs = retryStateOf(db, src.path);
            prevFail = rs?.fail_count || 0;
            if (rs && rs.next_retry_at && Date.parse(rs.next_retry_at) > Date.now()) {
                stats.skippedBackoff++;
                continue;
            }
        }
        // 增量：size+mtime 未变 → 跳过（本轮零读取成本）
        if (states) {
            try {
                const st = fs.statSync(src.path);
                const prev = states.get(src.path);
                if (prev && prevFail===0 && prev.size === st.size && prev.mtime_ms === Math.floor(st.mtimeMs)) {
                    stats.skippedUnchanged++;
                    continue;
                }
            }
            catch {
                continue; // 文件已消失/不可读
            }
        }
        let srcLlmFail = 0;   // 本源本轮 LLM 失败块数（只用于统计与退避计数，不再作为「不写水位」的判据）
        let srcFirstErr = ""; // 本轮首个失败原因 → ingest_state.last_error（可回查是哪类错）
        let text;
        try{text=readSourceText(src);}catch(e){stats.errors.push(`${src.name} 读取失败：${String(e)}`);noteSourceFailure(db,src,e,prevFail+1);continue;}
        if (!text) {
            // 本源无有效内容（如审计日志过滤后没有风险事件）→ 同样要记水位，
            // 否则这类源每轮都被重读一遍（大文件如 12MB 的会话 transcript 尤其浪费）。
            markIngestState(db, src);
            clearSourceFailure(db, src.path);
            continue;
        }
        const sourceHash=createHash('sha256').update(text).digest('hex');
        db.prepare('INSERT OR IGNORE INTO ingest_source_snapshots(hash,source,content) VALUES(?,?,?)').run(sourceHash,src.path,text);
        stats.files++;
        // ── L1：内容本身已是结论 → 免 LLM 直读入库（省掉二次蒸馏与提炼预算）──
        if ((src.level ?? "L2") === "L1") {
            stats.l1Files++;
            const l1items = splitL1Items(text);
            if (!l1items.length) {
                // 切不出条目 ≠ 没读完：不写水位会让本文件每轮重读（原 L1 全量重跑的同类问题）
                markIngestState(db, src);
                clearSourceFailure(db, src.path);
                continue;
            }
            let l1vecs;
            try {
                l1vecs = await embedder.embedTexts(l1items);
            }
            catch (e) {
                // 整源嵌入失败：一条都没入库，此时推进水位等于永久丢这一版内容 → 不推进，只记退避。
                // 冷区（cooling）到期后会重试；死信记整源一条（block=-1）便于回查。
                stats.errors.push(`${src.name} 嵌入失败：${String(e)}`);
                stats.deadLetters++;
                logDeadLetter(db, src, -1, text, e);
                noteSourceFailure(db, src, e, prevFail + 1);
                srcLlmFail++;
                continue;
            }
            const l1type = src.kind === "rule" ? "rule" : "experience";
            let l1WriteFailure=null;
            for (let i = 0; i < l1items.length; i++) {
                stats.chunks++;
                const it = l1items[i];
                const vec = l1vecs[i];
                if (existingContents.has(it)) {
                    stats.skippedDup++;
                    continue;
                }
                if (!l1Gate(it)) {
                    stats.qualityReject++;
                    continue;
                }
                try {
                    const row = createMemoryRow(db, {
                        content: it,
                        type: l1type,
                        agent: src.agent,
                        agent_fpath: src.path,
                        project: "global",
                        embedding: vec ?? undefined,
                        confidence: 0.7,
                        status: "trial",
                        // ★ 2026-10-14（③）：采集来源标记 —— 外部文件内容不得进规则反思候选（见 rule-reflection.js）
                        source: "ingest",
                    });
                    existingContents.add(it);
                    db.prepare('INSERT OR IGNORE INTO ingest_item_sources VALUES(?,?,?,?)').run(row.id,sourceHash,i,it);
                    logUsage(db, { memory_id: row.id, event: "write", reader_agent: src.agent, writer_agent: src.agent, project: row.project });
                    stats.inserted++;
                    stats.l1Inserted++;
                    stats.items.push({ id: row.id, type: row.type, content: row.content.slice(0, 80), agent: row.agent });
                }
                catch (e) {
                    stats.errors.push(`${src.name} 写入失败：${String(e)}`);
                    console.error(`[ingest] L1 写入失败（${src.name}）: ${String(e).slice(0, 300)}`);
                    l1WriteFailure=e;
                }
            }
            if(l1WriteFailure){noteSourceFailure(db,src,l1WriteFailure,prevFail+1);continue;}
            // ⚠️ 必须在此写水位：continue 会跳过循环末尾的统一写法，否则 L1 每轮全量重跑。
            // ★ #700059：L1 免 LLM，能走到这里即表示不含「整源级失败」（嵌入失败已在上方 continue），
            //   故无条件推进水位 + 清退避；原实现依赖 opts.incremental（states 非空）才写，
            //   手动/全量采集时水位永远不更新。
            markIngestState(db, src);
            clearSourceFailure(db, src.path);
            continue; // 关键：L1 不消耗 LLM 预算
        }
        const blocks = chunk(text);
        if (!blocks.length) {
            markIngestState(db, src);
            clearSourceFailure(db, src.path);
            continue;
        }
        const progress=db.prepare('SELECT hash,next_block FROM ingest_block_progress WHERE source=?').get(src.path);
        const previousBlock=progress?.hash===sourceHash?Number(progress.next_block):0;
        const startBlock=prevFail>0&&previousBlock>=blocks.length?0:previousBlock;
        let earliestFailed=null;
        const saveProgress=next=>db.prepare('INSERT OR REPLACE INTO ingest_block_progress VALUES(?,?,?)').run(src.path,sourceHash,earliestFailed==null?next:Math.min(next,earliestFailed));
        let truncated = false; // 块循环因全局预算耗尽提前 break（这些块未尝试，不得推进水位）
        let circuitBroken = false; // ★ 同源连续失败熔断提前 break（同上：剩余块未尝试，不推进水位）
        let srcFailStreak = 0; // ★ 本源的「连续失败块数」；成功一块即清零（与跨源的 srcLlmFailStreak 分开统计）
        for (let i = startBlock; i < blocks.length; i++) {
            if(i-startBlock>=BLOCKS_PER_SOURCE){truncated=true;break;}
            stats.chunks++;
            let block = blocks[i];
            // LLM 提炼（受全局预算约束）
            if (calls >= MAX_CALLS) {
                truncated = true;
                break;
            }
            // ★ P1 成本治理 L2 压缩档：预算 50–80% 时压缩输入块（省 token），统计 budgetCompress
            const lvl = budgetLevel();
            if (lvl === "compress") {
                // 保留完整块；预算通过暂停/续读控制，不能删中间事实换成本。
                budgetCompress++;
            }
            calls++;
            let items;
            try {
                items = await extractFromSource(block, src.kind, `${src.agent}:${src.path}`);
                srcLlmFailStreak = 0; // 一次成功即清零连续失败
                srcFailStreak = 0; // ★ 本源连续失败同样清零
            }
            catch (e) {
                stats.llmFail++;
                earliestFailed=earliestFailed==null?i:Math.min(earliestFailed,i);
                saveProgress(i);
                srcLlmFail++;
                srcLlmFailStreak++;
                stats.errors.push(`${src.name} 提炼失败：${String(e)}`);
                if (!srcFirstErr)
                    srcFirstErr = String(e);
                // ★ #700059：失败块落死信（存 blocks[i] 原文，不是压缩后的副本），
                //   但**不阻塞同源后续块** —— 一个 429 不该让整源剩余块陪葬。
                stats.deadLetters++;
                logDeadLetter(db, src, i, blocks[i], e);
                // ★ 2026-11-08（卡外 item3）：同源块级熔断 —— 同一源连续 SRC_FAIL_STREAK_MAX 块失败
                //   （典型 429 / 鉴权失效）判定该源本轮不可用，跳过剩余块，避免继续空刷配额。
                //   已失败块均已落死信（可重放）；剩余块未尝试 → truncated=true 不推进水位；
                //   源级退避在块循环外补记（noteSourceFailure），下轮按 30min→6h 退避重试。
                srcFailStreak++;
                if (srcFailStreak >= SRC_FAIL_STREAK_MAX) {
                    circuitBroken = true;
                    truncated = true;
                    stats.errors.push(`${src.name} 连续 ${srcFailStreak} 块提炼失败 → 本轮跳过剩余 ${blocks.length - i - 1} 块（源退避后下轮重试）`);
                    break;
                }
                continue;
            }
            if (!items.length){saveProgress(i+1);
                continue;
            }
            const itemVectors=await embedder.embedTexts(items.map(it=>it.content)).catch(e=>{stats.errors.push(`${src.name} 正文嵌入失败，保留原文走词法检索：${String(e)}`);return [];});
            let itemIndex=-1;
            let blockWriteFailure=null;
            for (const it of items) {
                itemIndex++;
                const vec=itemVectors[itemIndex];
                if(existingContents.has(it.content)){stats.skippedDup++;continue;}
                // P2 硬门禁：pass 直入；review 降置信走 trial；meta 路由 meta scope；reject 拒收（管道一律 status='trial' 由 daemon 考核）
                const gate = hardGate(it.content);
                if (gate.verdict === "reject") {
                    stats.qualityReject++;
                    // reject 也要落日志，否则"门控拦截量"无法从 daemon_log 观测（review/meta 走下方 write 已可见）
                    logDaemon(db, { task: "ingest", op: "reject", operator: `ingest:${src.agent}`, detail: `门控拒收 ${src.name}: ${gate.reason}` });
                    continue;
                }
                if (gate.verdict === "review")
                    stats.gateReview++;
                if (gate.verdict === "meta")
                    stats.gateMeta++;
                const project = gate.verdict === "meta" ? "meta" : "global";
                const confidence = gate.verdict === "review" ? 0.5 : 0.7; // review 低置信，trial 淘汰兜底
                let row;
                try {
                    // ★ M10（R4 裁决）：LLM 提炼的情绪信号落库 —— |valence|≥0.5 归入 affective 扇区（自动提炼写入路径）
                    const affective = it.valence !== undefined && Math.abs(it.valence) >= 0.5;
                    row = createMemoryRow(db, {
                        content: it.content,
                        type: it.type,
                        agent: src.agent,
                        agent_fpath: src.path,
                        project,
                        embedding: vec ?? undefined,
                        confidence,
                        status: "trial",
                        // ★ 2026-10-14（③）：采集来源标记（同上）
                        source: "ingest",
                        source_ref: `ingest:${sourceHash}#block=${i}`,
                        sector: affective ? "affective" : undefined,
                        valence: it.valence,
                        arousal: it.arousal,
                    });
                    db.prepare('INSERT OR IGNORE INTO ingest_item_sources VALUES(?,?,?,?)').run(row.id,sourceHash,i,it.source_quote);
                    if(!vec)db.prepare(`UPDATE ${MEMORIES} SET embedding_stale=1 WHERE id=?`).run(row.id);
                    // 同步补进去重缓存：同一轮内后续源再命中相同内容也能去重，避免重复入库
                    existingContents.add(it.content);
                    // 写入必须落 usage（漏斗 write 基线）；仅 logDaemon 会被"只写不搜"触发率高估
                    logUsage(db, { memory_id: row.id, event: "write", reader_agent: src.agent, writer_agent: src.agent, project: row.project });
                    logDaemon(db, {
                        task: "ingest",
                        op: "write",
                        memory_id: row.id,
                        operator: `ingest:${src.agent}`,
                        detail: `采集自 ${src.name} (gate=${gate.verdict}${gate.verdict === "pass" ? "" : `:${gate.reason}`})`,
                    });
                }
                catch (e) {
                    stats.errors.push(`${src.name} 写入失败：${String(e)}`);
                    console.error(`[ingest] L2 写入失败（${src.name}）: ${String(e).slice(0, 300)}`);
                    blockWriteFailure=e;
                    continue;
                }
                stats.inserted++;
                stats.items.push({ id: row.id, type: row.type, content: row.content.slice(0, 80), agent: row.agent });
            }
            if(blockWriteFailure){
                truncated=true;
                circuitBroken=true;
                srcLlmFail++;
                srcFirstErr=String(blockWriteFailure);
                earliestFailed=earliestFailed==null?i:Math.min(earliestFailed,i);
                saveProgress(i);
                break; // 本块仍须重试；已成功条目由正文去重，不能推进越过失败写入。
            }
            saveProgress(i+1);
        }
        // ★ #700059：水位「按源推进」—— 不再因 srcLlmFail>0 整源回滚。
        //   失败块已落 ingest_dead_letters（带正文，可重放），水位必须前移；否则整源每轮从同一处重跑，
        //   正是 desktop.log 7 天 1,103 次「提炼失败」的根因。
        //   唯一例外：预算耗尽导致块循环 break（truncated）—— 那些块压根没尝试，推进等于静默丢弃；
        //   下轮重跑时已采块会被 cos>0.92 去重挡在 LLM 之前，成本可控。
        if (!truncated&&srcLlmFail===0) {
            markIngestState(db, src);
            if (srcLlmFail === 0)
                clearSourceFailure(db, src.path);
            else
                noteSourceFailure(db, src, srcFirstErr || "LLM 提炼失败", prevFail + 1);
        }
        // ★ 2026-11-08（卡外 item3）：熔断虽然也置了 truncated（不推进水位），但成因是「源不可用」，
        //   必须补记源级退避 —— 否则下一轮立刻重刷同一源，熔断就白做了。
        else if (circuitBroken||srcLlmFail>0) {
            noteSourceFailure(db, src, srcFirstErr || "同源连续块提炼失败熔断", prevFail + 1);
        }
    }
    // ★ P1 成本治理：最终档位 + 三级统计（normal/compress 次数、downgrade 终止数），供 dashboard 展示
    stats.budgetLevel = budgetLevel();
    stats.budgetCompress = budgetCompress;
    stats.budgetDowngrade = budgetDowngrade;
    stats.budgetTerminated = budgetTerminated;
    return stats;
}
