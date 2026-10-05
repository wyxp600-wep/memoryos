/**
 * MemoryOS — 本机 AI Agent 扫描（scan/connect 最小前置）
 * 只读探测，不写库。检测两类：
 *   1. PATH 中的 CLI Agent（codex / claude / aider / gemini / qwen ...）→ 报名称/版本
 *   2. 已配置 memoryhub MCP 的 agent（~/.codex/config.toml、~/.claude.json）→ 报 connected
 * 返回结果供 Dashboard「工具连接」页真实展示。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
/** 探测 CLI 版本字符串，失败返回 null */
function probeCli(cmd) {
    try {
        const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 8000, windowsHide: true, shell: true });
        const out = String(r.stdout || "") || String(r.stderr || "");
        const first = out.split("\n").map(s => s.trim()).find(Boolean);
        return { version: first ? first.slice(0, 60) : null };
    }
    catch {
        return { version: null };
    }
}
function exePath(cmd) {
    try {
        const isWin = process.platform === "win32";
        const r = spawnSync(isWin ? "where" : "which", [cmd], { encoding: "utf8", timeout: 5000, windowsHide: true });
        const first = (r.stdout || "").split("\n").map(s => s.trim()).find(Boolean);
        return first || null;
    }
    catch {
        return null;
    }
}
/** 探测 PATH 中是否存在某命令（返回可执行路径或 null） */
function hasCommand(cmd) {
    return exePath(cmd) !== null;
}
function memoryhubConnected(agentId) {
    try {
        const home = os.homedir();
        if (agentId === "codex") {
            const cfg = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
            return /memoryos|memoryhub/i.test(cfg); // 兼容新旧 MCP server 名
        }
        if (agentId === "claude") {
            const cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
            return !!(cfg.mcpServers && (cfg.mcpServers.memoryos || cfg.mcpServers.memoryhub));
        }
    }
    catch {
        return false;
    }
    return false;
}
/**
 * 桌面 IDE / 客户端的 memoryhub 连接探测（按真实配置载体，2026-09-06 实证）：
 *   Trae 系列 → ~/.trae-cn/mcps/ 树下出现 mcp_memoryos server 目录（UI/手动配置落盘）
 *   WorkBuddy → ~/.workbuddy/connectors/ 各子目录 mcp.json 内声明 memoryos/memoryhub
 * 未实证载体（ZCode/WorkBuddy AI/智谱清言 等）如实返回 false，不臆测。
 */
function ideMemoryhubConnected(agentId) {
    const home = os.homedir();
    try {
        if (agentId === "traecode" || agentId === "traework" || agentId === "trae") {
            return findMemoryosServer(path.join(home, ".trae-cn", "mcps"));
        }
        if (agentId === "zcode") {
            // ZCode 工作区级 MCP 配置：~/.zcode/cli/config.json 的 mcp.servers（2026-09-10 实证）
            const cfgPath = path.join(home, ".zcode", "cli", "config.json");
            if (fs.existsSync(cfgPath)) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
                    const servers = cfg?.mcp?.servers ?? {};
                    return !!(servers.memoryos || servers.memoryhub);
                }
                catch {
                    return false;
                }
            }
            return false;
        }
        if (agentId === "workbuddy") {
            // 顶层 mcp.json（WorkBuddy「配置 MCP」弹窗落盘，2026-09-06 截图实证）+ connectors 子目录
            const top = path.join(home, ".workbuddy", "mcp.json");
            if (fs.existsSync(top) && /memoryos|memoryhub/i.test(fs.readFileSync(top, "utf8")))
                return true;
            const base = path.join(home, ".workbuddy", "connectors");
            if (!fs.existsSync(base))
                return false;
            for (const dir of fs.readdirSync(base)) {
                const f = path.join(base, dir, "mcp.json");
                if (fs.existsSync(f) && /memoryos|memoryhub/i.test(fs.readFileSync(f, "utf8")))
                    return true;
            }
            return false;
        }
        if (agentId === "workbuddy-ai") {
            // WorkBuddy AI：connector 式 mcp.json（~/.workbuddy-ai/connectors/<name>/mcp.json，2026-09-10 实证 mcpServers 结构）
            const base = path.join(home, ".workbuddy-ai", "connectors");
            if (!fs.existsSync(base))
                return false;
            for (const dir of fs.readdirSync(base)) {
                const f = path.join(base, dir, "mcp.json");
                if (fs.existsSync(f)) {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
                        const servers = cfg?.mcpServers ?? {};
                        if (servers.memoryos || servers.memoryhub)
                            return true;
                    }
                    catch { /* 单个文件解析失败不断链 */ }
                }
            }
            return false;
        }
        if (agentId === "minimax") {
            // MiniMax Code：~/.minimax/mcp.json 的 mcpServers.memoryos（2026-09-10 实证落盘，schema 含 type/enabled/configured）
            const f = path.join(home, ".minimax", "mcp.json");
            if (fs.existsSync(f)) {
                try {
                    const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
                    const servers = cfg?.mcpServers ?? {};
                    return !!(servers.memoryos || servers.memoryhub);
                }
                catch {
                    return false;
                }
            }
            return false;
        }
    }
    catch {
        return false;
    }
    return false;
}
/** 在 mcps 目录树下（深度≤4）找名为 mcp_memoryos 的 server 目录 */
function findMemoryosServer(root) {
    try {
        if (!fs.existsSync(root))
            return false;
        let stack = [root];
        for (let depth = 0; depth < 4 && stack.length; depth++) {
            const next = [];
            for (const d of stack) {
                let entries = [];
                try {
                    entries = fs.readdirSync(d, { withFileTypes: true });
                }
                catch {
                    continue;
                }
                for (const e of entries) {
                    if (!e.isDirectory())
                        continue;
                    const full = path.join(d, e.name);
                    if (/mcp_memoryos/i.test(e.name))
                        return true;
                    next.push(full);
                }
            }
            stack = next;
        }
        return false;
    }
    catch {
        return false;
    }
}
const CLI_AGENTS = [
    { id: "codex", name: "OpenAI Codex CLI", cmd: "codex" },
    { id: "claude", name: "Claude Code", cmd: "claude" },
    { id: "aider", name: "Aider", cmd: "aider" },
    { id: "gemini", name: "Gemini CLI", cmd: "gemini" },
    { id: "glm", name: "智谱 GLM CLI", cmd: "glm" },
    { id: "qwen", name: "Qwen Code", cmd: "qwen" },
    { id: "openrouter", name: "OpenRouter", cmd: "openrouter" },
];
/**
 * 桌面 AI Agent（IDE / 客户端）：按真实安装点探测可执行文件是否存在。
 * 路径来源（2026-09-06 本机实证，从开始菜单 .lnk 与 Programs 目录反解）：
 *   ZCode/WorkBuddy/WorkBuddyAI/Trae CN/TRAE SOLO CN/MiniMax Code → AppData\Local\Programs
 *   Codex++ → AppData\Local\Programs\Codex++
 *   智谱清言 → AppData\Local\ZP\chatglm（不在 Programs，需单独登记）
 */
const DESKTOP_AGENTS = [
    { id: "zcode", name: "ZCode", type: "IDE Agent", relExe: "AppData/Local/Programs/ZCode/ZCode.exe" },
    { id: "workbuddy", name: "WorkBuddy", type: "IDE Agent", relExe: "AppData/Local/Programs/WorkBuddy/WorkBuddy.exe" },
    { id: "workbuddy-ai", name: "WorkBuddy AI", type: "IDE Agent", relExe: "AppData/Local/Programs/WorkBuddyAI/WorkBuddyAI.exe" },
    { id: "traecode", name: "TraeCode CN", type: "IDE Agent", relExe: "AppData/Local/Programs/Trae CN/Trae CN.exe" },
    { id: "traework", name: "TraeWork CN", type: "IDE Agent", relExe: "AppData/Local/Programs/TRAE SOLO CN/TRAE SOLO CN.exe" },
    { id: "zhipu", name: "智谱清言", type: "IDE Agent", relExe: "AppData/Local/ZP/chatglm/智谱清言.exe" },
    { id: "codexpp", name: "Codex++", type: "IDE Agent", relExe: "AppData/Local/Programs/Codex++/codex-plus-plus.exe" },
    { id: "minimax", name: "MiniMax Code", type: "IDE Agent", relExe: "AppData/Local/Programs/MiniMax Code/MiniMax Code.exe" },
];
/* ========== 自动发现清单外 AI 编程 IDE（补充固定清单，2026-09 加） ==========
 * 固定 DESKTOP_AGENTS 只覆盖已实证的 8 个；用户实际可能装了清单外的 IDE/编辑器
 * （如 VS Code/Cursor/Windsurf/Continue 等）。这里扫描开始菜单 .lnk 与 Programs
 * 目录，命中「AI 编程/编辑器」关键词的目录补进结果。不服务于 connected 深度判断
 * （只给读取到的安装路径，connected 由 ideMemoryhubConnected 探测）。
 */
function discoverAIIdeAgents(home) {
    const found = [];
    // ① 开始菜单 .lnk（两个根：用户 + 公共）
    const lnkRoots = [
        path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs"),
        process.env.ProgramData
            ? path.join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs")
            : path.join("C:", "ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    ];
    // ② Programs 目录下的子目录名（作为补充，覆盖 .lnk 未落盘场景）
    const progRoot = path.join(home, "AppData", "Local", "Programs");
    // 识别规则：目录/快捷名含以下关键词即视为 AI 编程工具候选（alias 映射到规范 id/名）
    const RULES = [
        { re: /visual\s*studio\s*code|vs\s*code/i, id: "vscode", name: "VS Code" },
        { re: /^cursor/i, id: "cursor", name: "Cursor" },
        { re: /windsurf/i, id: "windsurf", name: "Windsurf" },
        { re: /github\s*desktop/i, id: "github-desktop", name: "GitHub Desktop" },
        // 注意：不补通用 /trae/——Trae 家族已由固定清单 traecode/traework 精确覆盖，补通配会重复
        { re: /deepseek|harness|^dsh/i, id: "dsh", name: "DeepSeek Harness" },
        { re: /gemini.*cli/i, id: "gemini-cli", name: "Gemini CLI" },
        { re: /qwen.*code|tongyi/i, id: "qwen-code", name: "Qwen Code" },
        { re: /continue/i, id: "continue", name: "Continue" },
    ];
    const seen = new Set(DESKTOP_AGENTS.map(a => a.id)); // 固定清单已覆盖的 id 不再补
    const pools = [];
    // 收集候选字符串：（lnk 名, Programs 子目录名, 对应 exe 探测路径）
    for (const root of lnkRoots) {
        if (!fs.existsSync(root))
            continue;
        try {
            for (const e of fs.readdirSync(root, { withFileTypes: true })) {
                if (e.name.toLowerCase().endsWith(".lnk"))
                    pools.push({ label: e.name.replace(/\.lnk$/i, ""), kind: "lnk", root });
            }
        }
        catch { /* 单目录失败不阻断 */ }
    }
    if (fs.existsSync(progRoot)) {
        try {
            for (const d of fs.readdirSync(progRoot, { withFileTypes: true })) {
                if (d.isDirectory())
                    pools.push({ label: d.name, kind: "dir", root: progRoot, dirName: d.name });
            }
        }
        catch { /* 忽略 */ }
    }
    for (const p of pools) {
        for (const rule of RULES) {
            if (!rule.re.test(p.label))
                continue;
            if (seen.has(rule.id)) {
                seen.add(rule.id);
                break;
            } // 已处理过该 id
            try {
                // 探测真实 exe：优先 Programs 子目录内 Code.exe，其次该目录下主 .exe（排除 Uninstall），再退目录路径
                let full = null;
                if (p.kind === "dir" && p.dirName) {
                    const dirPath = path.join(progRoot, p.dirName);
                    const codeExe = path.join(dirPath, "Code.exe");
                    if (fs.existsSync(codeExe))
                        full = codeExe;
                    else if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
                        try {
                            const exe = fs.readdirSync(dirPath).find(f => f.toLowerCase().endsWith(".exe") && !/uninstall/i.test(f));
                            if (exe)
                                full = path.join(dirPath, exe);
                            else
                                full = dirPath;
                        }
                        catch {
                            full = dirPath;
                        }
                    }
                }
                found.push({ id: rule.id, name: rule.name, type: "IDE Agent", version: null, connected: ideMemoryhubConnected(rule.id), path: full || p.root });
            }
            catch { /* 忽略 */ }
            seen.add(rule.id);
            break;
        }
    }
    return found;
}
/* ========== ★ 批次⑦B（2026-09-23）：通用 MCP 载体指纹发现 ==========
 * 原流程三层全硬编码（CLI 清单 / 桌面 relExe / 关键词正则），清单外新 agent 永远扫不出。
 * 新流程：清单保留为已实证快路径；通用层不比名字、改比「MCP 载体文件」指纹——
 * 任何 agent 只要在配置目录落了 MCP 载体（config.toml [mcp_servers] / mcp.json /
 * .claude.json / config.json 的 mcpServers|mcp.servers 等）即判为 AI agent 候选；
 * 载体内容命中 memoryos|memoryhub → connected。纯只读探测，不写不执行。 */
const CARRIER_FILES = ["config.toml", ".claude.json", "mcp.json", ".mcp.json", "config.json", path.join("cli", "config.json"), "claude_desktop_config.json"]; // ★20261005 补 Claude Desktop 载体
const MCP_FINGERPRINT = /\[mcp_servers|mcpServers|mcp\.servers|"mcp"\s*:|memoryos|memoryhub/i;
const MEMORY_HIT = /memoryos|memoryhub/i;
/** 通配载体探测：给任意配置目录，返回首个 MCP 载体 {file, connected} 或 null（不按 id 硬编码） */
export function probeCarrier(dir) {
    if (!dir)
        return null;
    const test = (f) => {
        try {
            if (!fs.existsSync(f) || !fs.statSync(f).isFile())
                return null;
            const txt = fs.readFileSync(f, "utf8").slice(0, 262144);
            if (!MCP_FINGERPRINT.test(txt))
                return null;
            return { file: f, connected: MEMORY_HIT.test(txt) };
        }
        catch {
            return null;
        }
    };
    for (const rel of CARRIER_FILES) {
        const hit = test(path.join(dir, rel));
        if (hit)
            return hit;
    }
    // connectors/<name>/mcp.json（WorkBuddy 系载体，深度 1）
    try {
        const base = path.join(dir, "connectors");
        if (fs.existsSync(base)) {
            for (const d of fs.readdirSync(base)) {
                const hit = test(path.join(base, d, "mcp.json"));
                if (hit)
                    return hit;
            }
        }
    }
    catch { /* 目录不可读跳过 */ }
    return null;
}
/** ★ 批次⑨S2（2026-09-24）：名称启发式 —— 「装了但没配 MCP 载体」的 agent 也要列出（存在与连接分层）。
 *  宽进口径：目录/点目录名命中即为「已安装·未连接」候选；connected 仍只由 probeCarrier 载体指纹判定。
 *  短词（dsh/pi）加 \b 词边界，防 pip/spin 等误命中；其余按子串匹配。 */
const AI_NAME_RE = /(code|agent|coding|assistant|copilot|claude|codex|cursor|windsurf|trae|zcode|qwen|glm|chatglm|deepseek|mimo|commandcode|continue|aider|gemini|\bdsh\b|\bpi\b)/i;
/** 名称 → 规范 id：让「Microsoft VS Code / Trae CN / MiniMax Code / DSH Desktop…」归一到固定清单 id，
 *  由 scanAgents 按 id 去重（不重复列出）；清单外新 agent（Command Code/OpenCode/MiMo…）拿到稳定唯一 id。 */
const AI_NAME_ALIAS = [
    [/visual\s*studio\s*code|vs\s*code/i, "vscode"],
    [/deepseek|\bdsh\b/i, "dsh"],
    [/trae[-\s]*cn/i, "traecode"],
    [/trae[-\s]*solo/i, "traework"],
    [/workbuddy\s*ai|workbuddyai/i, "workbuddy-ai"],
    [/minimax/i, "minimax"],
    [/codex/i, "codexpp"],
    [/command\s*code/i, "commandcode"],
    [/opencode/i, "opencode"],
    [/xiaomi\s*mimo|\bmimo\b/i, "mimo"],
    [/pi[\s-]*agent/i, "pi-agent"],
];
/** 清单外 agent 通用发现：home 点目录 + Programs 安装目录（含 目录名→点目录 slug 映射） */
export function discoverCarrierAgents(home = os.homedir()) {
    const found = [];
    const seen = new Set();
    const consider = (dir) => {
        try {
            const resolved = path.resolve(dir);
            if (seen.has(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
                return;
            seen.add(resolved);
            const base = path.basename(resolved);
            const hit = probeCarrier(resolved);
            const id = (base.startsWith(".") ? base.slice(1) : base).toLowerCase().replace(/[^a-z0-9-]/g, "") || "unknown";
            if (hit) {
                found.push({ id, name: base.replace(/^\./, ""), type: "MCP 载体发现", version: null, connected: hit.connected, path: hit.file, configFile: hit.file, evidence: `MCP 载体指纹：${path.basename(hit.file)}` });
                return;
            }
            // ★ 批次⑨S2：无载体但名称像 agent → 降级列出「已安装」（装了没配 MCP 也可见）
            if (AI_NAME_RE.test(base)) {
                const alias = AI_NAME_ALIAS.find(([re]) => re.test(base));
                found.push({ id: alias ? alias[1] : id, name: base.replace(/^\./, ""), type: "已安装", version: null, connected: false, path: resolved, evidence: "目录存在（未检出 MemoryOS MCP 载体）" });
            }
        }
        catch { /* 单点失败跳过 */ }
    };
    // ① home 点目录（agent 配置惯例 ~/.<id>）
    try {
        for (const e of fs.readdirSync(home, { withFileTypes: true })) {
            if (e.isDirectory() && e.name.startsWith("."))
                consider(path.join(home, e.name));
        }
    }
    catch { /* 忽略 */ }
    // ② Programs 安装目录本体 + slug 映射点目录（"New Agent" → ~/.newagent）
    const prog = path.join(home, "AppData", "Local", "Programs");
    try {
        for (const e of fs.readdirSync(prog, { withFileTypes: true })) {
            if (!e.isDirectory())
                continue;
            consider(path.join(prog, e.name));
            const nospace = e.name.toLowerCase().replace(/\s+/g, "");
            for (const slug of new Set([e.name.toLowerCase(), nospace, nospace.replace(/[^a-z0-9]/g, "")])) {
                if (slug)
                    consider(path.join(home, "." + slug));
            }
        }
    }
    catch { /* 忽略 */ }
    return found;
}
/* ========== ★ 批次⑦B：手动登记清单（%APPDATA%\MemoryOS\agents.custom.json）==========
 * 扫描兜底：指纹也认不出的新 agent 由用户手动登记（名称 + 可选配置目录/安装路径），
 * 每次扫描合并进结果；填了 configDir 则 probeCarrier 通判 connected。 */
function customAgentsPath() {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "MemoryOS", "agents.custom.json");
}
export function loadCustomAgents() {
    try {
        const arr = JSON.parse(fs.readFileSync(customAgentsPath(), "utf8"));
        return Array.isArray(arr) ? arr.filter((x) => x && typeof x.name === "string" && x.name.trim()) : [];
    }
    catch {
        return [];
    }
}
export function saveCustomAgents(list) {
    const f = customAgentsPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(list, null, 2), "utf8");
}
/** 扫描本机已装的 agent（存在才返回） */
export function scanAgents() {
    const agents = [];
    for (const a of CLI_AGENTS) {
        if (hasCommand(a.cmd)) {
            const { version } = probeCli(a.cmd);
            agents.push({
                id: a.id,
                name: a.name,
                type: "CLI Agent",
                version,
                connected: memoryhubConnected(a.id),
                path: exePath(a.cmd),
            });
        }
    }
    // 桌面 IDE Agent / 客户端：按真实安装路径探测 exe 是否存在（不执行）
    for (const t of DESKTOP_AGENTS) {
        const full = path.join(os.homedir(), t.relExe);
        if (fs.existsSync(full)) {
            agents.push({ id: t.id, name: t.name, type: t.type, version: null, connected: ideMemoryhubConnected(t.id), path: full });
        }
    }
    // 自动发现补充：扫描开始菜单/Programs，补入固定清单外的 AI 编程 IDE（如 VS Code）
    for (const d of discoverAIIdeAgents(os.homedir())) {
        // 按 id 去重，避免与固定清单重复
        if (!agents.some(a => a.id === d.id))
            agents.push(d);
    }
    // ★ 批次⑦B：通用 MCP 载体指纹发现合并（清单 id 已覆盖的天然跳过：~/.codex→codex、~/.zcode→zcode…）
    for (const d of discoverCarrierAgents()) {
        if (!agents.some(a => a.id === d.id))
            agents.push(d);
    }
    // ★ 批次⑦B：手动登记合并（指纹也认不出的新 agent 兜底；configDir 在则通判 connected）
    for (const c of loadCustomAgents()) {
        const slug = String(c.id || c.name).toLowerCase().replace(/[^a-z0-9-]/g, "");
        // 非 ASCII 名（如中文）slug 为空 → 用名字哈希出稳定 id，避免多条撞成同一 id 被当重复跳过
        let id = slug;
        if (!id) {
            let h = 5381;
            for (const ch of String(c.name)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
            id = "custom-" + h.toString(36);
        }
        if (agents.some(a => a.id === id))
            continue;
        const hit = c.configDir ? probeCarrier(c.configDir) : null;
        agents.push({
            id,
            name: c.name,
            type: "手动登记",
            version: null,
            connected: !!(hit && hit.connected),
            path: c.path || (hit ? hit.file : (c.configDir || "")),
            configFile: hit ? hit.file : null,
            evidence: hit ? `MCP 载体指纹：${path.basename(hit.file)}` : "手动登记（未探测到载体）",
        });
    }
    const connected = agents.filter(a => a.connected).length;
    return { agents, total: agents.length, connected };
}
/* ========== 接入向导（Connect Guide）：让用户把未连接 agent 接上 memoryhub ==========
 * 安全原则：
 *  - 只对「载体已实证」的 agent 允许自动写（canAutoWrite=true），且写入前备份原文件到 _pending-delete/connect-backup
 *  - 未实证载体的 agent（zcode/zhipu/minimax/codexpp/workbuddy-ai）只给手动步骤 + 可复制模板，绝不猜写
 * 设计目标：工具连接页「操作」列渲染接入动作，而非空窗。
 */
/** memoryhub server.js 绝对路径（复制即用，勿用相对路径——用户从客户端根目录粘贴会失效）
 * 优先级：env MEMORYOS_SERVER（桌面版/便携包注入安装后真实路径）
 * > ★ 批次⑦（2026-09-23）按本模块位置动态推导（scan.js 与 server.js 同在 dist/）——
 *   原硬编码旧目录 "Desktop/aiagent记忆与规则/..." 项目搬迁后指向不存在路径，接入片段照抄即连错 */
const MEMORYOS_SERVER = process.env.MEMORYOS_SERVER?.trim() ||
    fileURLToPath(new URL("server.js", import.meta.url)).split(path.sep).join("/");
/** ★ 2026-09-25（双库分裂修复）：接入片段必须显式注入 MEMORY_DB=应用库（与壳层 core-process.js spawnCore 同口径）。
 *  server.js 缺省是「仓内 ../data/memory.db」（开发库）——照旧片段接入的 agent 全部落开发库，
 *  与 claude/codex/minimax/仪表盘（应用库 %APPDATA%\MemoryOS）互不可见：A 写的记忆 B 搜不到，
 *  是"跨 agent 召回差/不同步"的结构性根因（本机实证：opencode 漏注入即长期写错库）。
 *  口径与 merge-db.js DEFAULT_TO 一致；原实配（claude/codex）本就注入应用库，此处只是让模板对齐事实。 */
const MEMORYOS_DB = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "MemoryOS", "data", "memory.db");
/** ★20261005 嵌入口径真源对齐（services/core-process.js:62-63）：壳层给 MCP server 注入 EMBED_MODE=local + EMBED_CACHE_DIR=<内核>/models。
 *  旧片段不注 EMBED_* → server 兕底 local 但缓存落 ~/.cache/memoryos-embed（embed.js:157），同机两份模型缓存；
 *  现片段与壳层同源，接入即与仪表盘共用同一份本地嵌入模型缓存。 */
const MEMORYOS_KERNEL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MEMORYOS_EMBED = { EMBED_MODE: "local", EMBED_CACHE_DIR: path.join(MEMORYOS_KERNEL_ROOT, "models") };
/** 接入片段共用 env（MEMORY_AGENT 按 agent 注入，身份缺失会被心跳判定 unknown →「连上了也显示未连接」） */
function mcpEnv(agentId) {
    const fwd = (s) => String(s).split(path.sep).join("/");
    return { MEMORY_AGENT: agentId, MEMORY_DB: fwd(MEMORYOS_DB), EMBED_MODE: "local", EMBED_CACHE_DIR: fwd(path.join(MEMORYOS_KERNEL_ROOT, "models")) };
}
const toTomlInlineEnv = (env) => Object.entries(env).map(([k, v]) => `${k} = '${String(v).split(path.sep).join("/")}'`).join(", ");
const toJsonInlineEnv = (env) => JSON.stringify(Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])));
/** memoryhub MCP server 配置片段（各载体语法；★20261005 codex 改键表风格对齐本机工作实配 [mcp_servers.memoryos]，数组表 [[mcp_servers]]+name 实配无此形态） */
function buildMcpServers(agentId) {
    const env = mcpEnv(agentId);
    const serverFwd = MEMORYOS_SERVER;
    const dbFwd = MEMORYOS_DB.split(path.sep).join("/");
    return {
        codex: `[mcp_servers.memoryos]
command = "node"
args = [${JSON.stringify(serverFwd)}]
env = { ${toTomlInlineEnv({ ...env, MEMORY_DB: dbFwd })} }`,
        claude: `"memoryos": { "command": "node", "args": [${JSON.stringify(serverFwd)}], "env": ${toJsonInlineEnv(env)} }`,
        trae: `// 在 Trae 的教学面板「管理 MCP 服务器」中新增：
//  Name: memoryos
//  Type: stdio
//  Command: node
//  Args: ${serverFwd}
//  Env: ${toJsonInlineEnv({ ...env, MEMORY_DB: dbFwd })}
// 自动写会创建 ~/.trae-cn/mcps/<project>/<type>/mcp_memoryos/SERVER_METADATA.json（需项目上下文，故建议手动）`,
        workbuddy: `{
  "memoryos": {
    "command": "node",
    "args": [${JSON.stringify(serverFwd)}],
    "env": ${toJsonInlineEnv(env)}
  }
}`,
        /** 通用 stdio MCP JSON（未实证 agent 也能直接复制粘贴；miniMax 2026-09-10 实证接受 transport+enabled+args 数组）
         *  ★ 2026-09-25：各载体 env/environment 字段名不一（claude/workbuddy/generic 用 env，opencode 用 environment），
         *   片段按 env 给出并标注；若目标 agent 只认 environment 键，请把 env 改名为 environment（库/嵌入注入内容不变）。 */
        generic: `{
  "memoryos": {
    "transport": "stdio",
    "command": "node",
    "args": [${JSON.stringify(serverFwd)}],
    "env": ${toJsonInlineEnv(env)},
    "enabled": true
  }
}`,
    };
}
/** ★20261005 载体事实提取：读载体文件，识别形状并解析出「memoryos 条目当前的 server 路径与库路径」。
 *  只读不写，解析失败不抛错（返回 shape=invalid + parseError，供前端点亮「改库」告警与 needsDbFix）。 */
export function readCarrierFacts(filePath, fileSvc = { read: (p) => fs.readFileSync(p, "utf8"), exists: (p) => fs.existsSync(p) }) {
    const exists = fileSvc.exists ? !!fileSvc.exists(filePath) : fs.existsSync(filePath);
    if (!exists)
        return { exists: false, shape: "missing", declares: false, serverPath: null, carrierDb: null, parseError: null };
    let txt;
    try {
        txt = fileSvc.read(filePath);
    }
    catch (e) {
        return { exists: true, shape: "unreadable", declares: false, serverPath: null, carrierDb: null, parseError: String(e?.message ?? e) };
    }
    if (/\.toml$/i.test(filePath)) {
        // TOML：无解析器（零新依赖），逐行状态机切段（表头→收行）。
        // ★20261005 修：正则切段被「args 数组内 [ 字符」与「表头内引号路径含 ]」双重干扰；
        //   状态机按「行首 [..] 表头」切段，行体逐行收集，可靠；引号双兼容（真实载体用单引号）；
        //   memoryos 键优先于旧名 memoryhub（同仓多段时取正确的库路径）。
        const segs = {};
        let cur = null;
        for (const line of txt.split(/\r?\n/)) {
            const h = line.match(/^[ \t]*\[(.+)\][ \t]*$/);
            if (h) {
                cur = h[1];
                segs[cur] = segs[cur] || [];
                continue;
            }
            if (cur)
                segs[cur].push(line);
        }
        let serverPath = null, carrierDb = null, declares = /memoryos|memoryhub/i.test(txt);
        const mcpKeys = Object.keys(segs).filter((k) => /mcp_servers/i.test(k) && /memoryos|memoryhub/i.test(k));
        mcpKeys.sort((x, y) => (y.includes("memoryos") ? 1 : 0) - (x.includes("memoryos") ? 1 : 0));
        for (const key of mcpKeys) {
            const body = segs[key].join("\n");
            const cmd = body.match(/command\s*=\s*['"]([^'"]+)['"]/i);
            const args = body.match(/args\s*=\s*\[([^\]]*)\]/i);
            const db = body.match(/MEMORY_DB\s*=\s*['"]([^'"]+)['"]/i);
            if (cmd && args) {
                const first = args[1].match(/['"]([^'"]+)['"]/);
                serverPath = cmd[1] === "node" && first ? first[1] : (first ? first[1] : cmd[1]);
                if (db)
                    carrierDb = db[1];
                break;
            }
        }
        return { exists: true, shape: "toml", declares, serverPath, carrierDb, parseError: null };
    }
    // JSON 载体：尝试解析，识别 mcpServers / mcp.servers / servers 三种形状
    let cfg = null, parseError = null;
    try {
        cfg = JSON.parse(txt);
    }
    catch (e) {
        parseError = String(e?.message ?? e);
    }
    if (!cfg) {
        // 解析失败仍可给指纹级事实（declares 按文本指纹）——这就是「写坏了的载体」被识别的入口
        return { exists: true, shape: "invalid", declares: /memoryos|memoryhub/i.test(txt), serverPath: null, carrierDb: null, parseError };
    }
    const servers = cfg?.mcpServers ?? cfg?.mcp?.servers ?? cfg?.servers ?? null;
    const shape = cfg?.mcpServers ? "mcpServers" : cfg?.mcp?.servers ? "mcp.servers" : cfg?.servers ? "servers" : "flat";
    const memEntry = servers ? (servers.memoryos ?? servers.memoryhub ?? null) : null;
    let serverPath = null, carrierDb = null;
    if (memEntry && typeof memEntry === "object") {
        const args = Array.isArray(memEntry.args) ? memEntry.args : [];
        const cmd = typeof memEntry.command === "string" ? memEntry.command : null;
        const firstArg = args.find((x) => typeof x === "string" && /server\.js$/i.test(x)) || args.find((x) => typeof x === "string") || null;
        serverPath = (cmd === "node" && firstArg) ? firstArg : (firstArg || cmd);
        carrierDb = (memEntry.env && typeof memEntry.env === "object" && typeof memEntry.env.MEMORY_DB === "string") ? memEntry.env.MEMORY_DB
            : (memEntry.environment && typeof memEntry.environment === "object" && typeof memEntry.environment.MEMORY_DB === "string") ? memEntry.environment.MEMORY_DB : null;
    }
    return { exists: true, shape, declares: !!memEntry, serverPath, carrierDb, parseError: null, raw: cfg };
}
/** 生产库路径（供库比对）：与 scan.js 顶部 MEMORYOS_DB 同源，导出供路由层回填 dbPath 字段 */
export const MEMORYOS_DB_PATH = MEMORYOS_DB;
const HOME = os.homedir();
/** 为单个 agent 生成接入向导（纯函数，可单测）。
 *  ★20261005 增补前端等待的字段：carrierShape/needsDbFix/carrierDb/targetDb/serverPath/staleServer/resolvedDb/dbMatches/importSnippet/fileSnippet/fileSnippetLabel —— 数据链补全（此前后端从不返回，前端恒空态）。 */
export function connectGuideFor(a, fileSvc = { read: (p) => fs.readFileSync(p, "utf8") }) {
    const enrich = (g) => {
        // 向导级库比对：以载体文件实际解析结果为准（解析失败/缺字段不谎报，dbMatches 置 null = 无法判定）
        if (g.autoWriteFile) {
            const facts = readCarrierFacts(g.autoWriteFile, fileSvc);
            g.carrierShape = facts.shape;
            g.carrierDb = facts.carrierDb;
            g.serverPath = facts.serverPath;
            g.needsDbFix = facts.declares && facts.carrierDb != null && path.resolve(facts.carrierDb) !== path.resolve(MEMORYOS_DB);
            g.staleServer = facts.declares && facts.serverPath != null && !fs.existsSync(facts.serverPath);
            g.resolvedDb = facts.carrierDb;
            g.dbMatches = facts.declares ? (facts.carrierDb != null ? g.needsDbFix === false : null) : null;
            g.importSnippet = JSON.stringify({ memoryos: { command: "node", args: [MEMORYOS_SERVER], env: mcpEnv(a.id) } }, null, 2);
            g.fileSnippet = g.attachSnippet;
            g.fileSnippetLabel = "写进 " + g.autoWriteFile;
        }
        return g;
    };
    switch (a.id) {
        case "codex": {
            const f = path.join(HOME, ".codex", "config.toml");
            const existing = fileSvc.read(f);
            const done = existing !== "" && /memoryos|memoryhub/i.test(existing);
            return enrich({
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: true, autoWriteFile: f,
                attachSnippet: buildMcpServers(a.id).codex,
            });
        }
        case "claude": {
            const f = path.join(HOME, ".claude.json");
            const existing = fileSvc.read(f);
            const done = existing !== "" && /"memoryos"|"memoryhub"/.test(existing);
            return enrich({
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: true, autoWriteFile: f,
                attachSnippet: buildMcpServers(a.id).claude,
            });
        }
        case "workbuddy": {
            const f = path.join(HOME, ".workbuddy", "mcp.json");
            const existing = fileSvc.read(f);
            const done = existing !== "" && /memoryos|memoryhub/i.test(existing);
            return enrich({
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: true, autoWriteFile: f,
                attachSnippet: buildMcpServers(a.id).workbuddy,
            });
        }
        case "traecode":
        case "traework": {
            const done = ideMemoryhubConnected(a.id);
            return {
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: false, // 载体需项目上下文，手动更安全
                manualSteps: ["在您的 Trae 客户端打开「管理 MCP 服务器」", "新增 stdio 类型 server，Name=memoryos", `Command 填 node，Args 填 ${MEMORYOS_SERVER}`, "保存后重启会话使其生效"],
                manualSnippet: buildMcpServers(a.id).trae,
            };
        }
        default: {
            // 未实证载体（zcode/zhipu/minimax/codexpp/workbuddy-ai 等）：绝不猜写，但给出可直接复制粘贴的通用 stdio 配置（绝对路径）
            // ★20261005 手动登记条目填了 configDir 且探到载体 → 升级为可自动写（与原生发现同权，修复「手动登记永远只能手贴」）
            const cfgDir = a.configFile ? path.dirname(a.configFile) : (a.configDir || null);
            const hit = cfgDir ? probeCarrier(cfgDir) : null;
            if (hit) {
                const isToml = /\.toml$/i.test(hit.file);
                return enrich({
                    agentId: a.id, name: a.name, connected: hit.connected,
                    canAutoWrite: true, autoWriteFile: hit.file,
                    attachSnippet: isToml ? buildMcpServers(a.id).codex : buildMcpServers(a.id).claude,
                });
            }
            return {
                agentId: a.id, name: a.name, connected: false,
                canAutoWrite: false,
                manualSteps: [
                    `尚未实证 ${a.name} 的 MCP 配置载体，无法安全自动写入。`,
                    `请在您的客户端「MCP 服务器」设置中，新增一个 stdio 类型 server 并填入以下信息（可直接复制右侧 JSON）：`,
                    `Command: node`,
                    `Args: ${MEMORYOS_SERVER}`,
                    `保存后重启会话使其生效。`,
                ],
                manualSnippet: buildMcpServers(a.id).generic,
            };
        }
    }
}
/** 执行自动写（仅当 canAutoWrite）：JSON 载体解析合并、TOML 载体键表化追加，写前备份、原子替换。
 *  ★20261005 重写：旧实现对 JSON/TOML 同走「尾拼+整文件覆写」，非空 JSON 必产出非法配置（用户实证踩坑）。
 *  现策略：
 *   - JSON 载体：JSON.parse → 合并 mcpServers.memoryos（保留其它键与其它 server 原样）→ 序列化；
 *     解析失败（shape=invalid）→ 拒绝自动写并给出手工指引（绝不覆盖坏文件，防二次破坏）；
 *   - TOML 载体：已有 memoryos 段 → 就地替换该段；无 → 文件末尾追加键表段；
 *   - 已连接且库已对齐 → 拒绝重复写；已连接但库不一致/ server 失效 → 允许修复性重写（「改库」后端支撑）；
 *   - 写入 = 备份 → 临时文件 → rename 原子替换。
 *  dryRun=true 只返回预览（target/dbPath/preview/mode），不落盘。fsx 可注入以便单测。 */
export function applyConnectWrite(a, opts = {}, fsx = {
    read: (p) => fs.readFileSync(p, "utf8"),
    exists: (p) => fs.existsSync(p),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    copy: (p, d) => fs.copyFileSync(p, d),
    write: (p, c) => fs.writeFileSync(p, c, "utf8"),
    rename: (p, d) => fs.renameSync(p, d),
    unlink: (p) => fs.unlinkSync(p),
}) {
    const g = connectGuideFor(a, { read: (p) => (fsx.exists(p) ? fsx.read(p) : "") });
    if (!g.canAutoWrite || !g.autoWriteFile || !g.attachSnippet) {
        return { ok: false, error: `${a.name} 载体未实证，不支持自动写，请走手动指引` };
    }
    const target = g.autoWriteFile;
    const isToml = /\.toml$/i.test(target);
    const existing = fsx.exists(target) ? fsx.read(target) : "";
    if (g.connected && !g.needsDbFix && !g.staleServer) {
        return { ok: false, error: `${a.name} 已连接且库已对齐，无需重复接入` };
    }
    let next, mode;
    if (isToml) {
        mode = /\[\[?mcp_servers[^\]]*\]\][^\[]*memoryos|memoryhub/i.test(existing) ? "replace" : "append";
        const envInline = toTomlInlineEnv({ ...mcpEnv(a.id), MEMORY_DB: String(MEMORYOS_DB).split(path.sep).join("/") });
        const block = `[mcp_servers.memoryos]\ncommand = "node"\nargs = [${JSON.stringify(MEMORYOS_SERVER)}]\nenv = { ${envInline} }\n`;
        if (mode === "replace") {
            const re = /\[\[?mcp_servers[^\]]*\]\][^\[]*?(?=\n\[|\n\[\[|$)/gi;
            let replaced = false;
            next = existing.replace(re, (seg) => {
                if (replaced || !/memoryos|memoryhub/i.test(seg))
                    return seg;
                replaced = true;
                return block.trimEnd() + "\n";
            });
            if (!replaced)
                next = existing.trimEnd() + "\n\n" + block;
        }
        else {
            next = existing.trimEnd() ? existing.trimEnd() + "\n\n" + block : block;
        }
    }
    else {
        // JSON 载体：解析 → 合并 memoryos 条目 → 序列化（保留其它键与其它 server）
        let cfg = null;
        if (existing.trim()) {
            try {
                cfg = JSON.parse(existing);
            }
            catch (e) {
                return { ok: false, error: `${a.name} 的配置文件不是合法 JSON（${String(e?.message ?? e).slice(0, 120)}），拒绝自动写以免覆盖坏文件；请先手工修复或从 _pending-delete/connect-backup 恢复`, carrierInvalid: true };
            }
        }
        if (cfg == null || typeof cfg !== "object" || Array.isArray(cfg))
            cfg = {};
        const entry = { command: "node", args: [MEMORYOS_SERVER], env: mcpEnv(a.id) };
        let serversKey = null, parentObj = null;
        if (cfg.mcpServers && typeof cfg.mcpServers === "object" && !Array.isArray(cfg.mcpServers)) {
            serversKey = "mcpServers"; parentObj = cfg;
        }
        else if (cfg.mcp && typeof cfg.mcp === "object" && cfg.mcp.servers && typeof cfg.mcp.servers === "object" && !Array.isArray(cfg.mcp.servers)) {
            serversKey = "servers"; parentObj = cfg.mcp;
        }
        else if (cfg.servers && typeof cfg.servers === "object" && !Array.isArray(cfg.servers)) {
            serversKey = "servers"; parentObj = cfg;
        }
        if (serversKey) {
            parentObj[serversKey] = parentObj[serversKey] ?? {};
            parentObj[serversKey].memoryos = entry;
        }
        else {
            cfg.mcpServers = { memoryos: entry };
        }
        mode = existing.trim() ? "merge" : "create";
        next = JSON.stringify(cfg, null, 2) + "\n";
    }
    if (opts.dryRun) {
        return { ok: true, mode, target, dbPath: MEMORYOS_DB, preview: next, needsDbFix: g.needsDbFix, staleServer: g.staleServer };
    }
    const bakDir = path.join(os.homedir(), "_pending-delete", "connect-backup");
    if (!fsx.exists(bakDir))
        fsx.mkdir(bakDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(bakDir, `${a.id}-${stamp}.bak`);
    if (fsx.exists(target))
        fsx.copy(target, backupPath);
    const tmp = target + ".mos-tmp";
    fsx.write(tmp, next);
    fsx.rename(tmp, target);
    return { ok: true, mode, backupPath, target, dbPath: MEMORYOS_DB };
}
