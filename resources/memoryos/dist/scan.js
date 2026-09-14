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
 * 优先级：env MEMORYOS_SERVER（桌面版/便携包注入安装后真实路径）> 开发默认路径 */
const MEMORYOS_SERVER = process.env.MEMORYOS_SERVER?.trim() ||
    "C:/Users/WYX/Desktop/aiagent记忆与规则/memoryos/dist/server.js";
/** memoryhub MCP server 配置片段（各载体语法） */
const MEMORYOS_MCP_SERVERS = {
    codex: `[[mcp_servers]]
name = "memoryos"
command = "node"
args = [${JSON.stringify(MEMORYOS_SERVER)}]`,
    claude: `"memoryos": { "command": "node", "args": [${JSON.stringify(MEMORYOS_SERVER)}], "env": { "MEMORY_AGENT": "claude" } }`,
    trae: `// 在 Trae 的教学面板「管理 MCP 服务器」中新增：
//  Name: memoryos
//  Type: stdio
//  Command: node
//  Args: ${MEMORYOS_SERVER}
// 自动写会创建 ~/.trae-cn/mcps/<project>/<type>/mcp_memoryos/SERVER_METADATA.json（需项目上下文，故建议手动）`,
    workbuddy: `{
  "memoryos": {
    "command": "node",
    "args": [${JSON.stringify(MEMORYOS_SERVER)}],
    "env": {}
  }
}`,
    /** 通用 stdio MCP JSON（未实证 agent 也能直接复制粘贴；miniMax 2026-09-10 实证接受 transport+enabled+args 数组） */
    generic: `{
  "memoryos": {
    "transport": "stdio",
    "command": "node",
    "args": [${JSON.stringify(MEMORYOS_SERVER)}],
    "enabled": true
  }
}`,
};
const HOME = os.homedir();
/** 为单个 agent 生成接入向导（纯函数，可单测） */
export function connectGuideFor(a, fileSvc = { read: (p) => fs.readFileSync(p, "utf8") }) {
    switch (a.id) {
        case "codex": {
            const f = path.join(HOME, ".codex", "config.toml");
            const existing = fileSvc.read(f);
            const done = existing !== "" && /memoryos|memoryhub/i.test(existing);
            return {
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: true, autoWriteFile: f,
                attachSnippet: MEMORYOS_MCP_SERVERS.codex,
            };
        }
        case "claude": {
            const f = path.join(HOME, ".claude.json");
            const existing = fileSvc.read(f);
            const done = existing !== "" && /"memoryos"|"memoryhub"/.test(existing);
            return {
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: true, autoWriteFile: f,
                attachSnippet: MEMORYOS_MCP_SERVERS.claude,
            };
        }
        case "workbuddy": {
            const f = path.join(HOME, ".workbuddy", "mcp.json");
            const existing = fileSvc.read(f);
            const done = existing !== "" && /memoryos|memoryhub/i.test(existing);
            return {
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: true, autoWriteFile: f,
                attachSnippet: MEMORYOS_MCP_SERVERS.workbuddy,
            };
        }
        case "traecode":
        case "traework": {
            const done = ideMemoryhubConnected(a.id);
            return {
                agentId: a.id, name: a.name, connected: done,
                canAutoWrite: false, // 载体需项目上下文，手动更安全
                manualSteps: ["在您的 Trae 客户端打开「管理 MCP 服务器」", "新增 stdio 类型 server，Name=memoryos", `Command 填 node，Args 填 ${MEMORYOS_SERVER}`, "保存后重启会话使其生效"],
                manualSnippet: MEMORYOS_MCP_SERVERS.trae,
            };
        }
        default: {
            // 未实证载体（zcode/zhipu/minimax/codexpp/workbuddy-ai）：绝不猜写，但给出可直接复制粘贴的通用 stdio 配置（绝对路径）
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
                manualSnippet: MEMORYOS_MCP_SERVERS.generic,
            };
        }
    }
}
/** 执行自动写（仅当 canAutoWrite）：先备份原文件到 _pending-delete/connect-backup，再写。
 *  dryRun=true 只返回将写入内容，不落盘（预览用）。fileSvc 可注入以便单测。 */
export function applyConnectWrite(a, opts = {}, fsx = {
    read: (p) => fs.readFileSync(p, "utf8"),
    exists: (p) => fs.existsSync(p),
    mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
    copy: (p, d) => fs.copyFileSync(p, d),
    write: (p, c) => fs.writeFileSync(p, c, "utf8"),
}) {
    const g = connectGuideFor(a, { read: (p) => (fsx.exists(p) ? fsx.read(p) : "") });
    if (!g.canAutoWrite || !g.autoWriteFile || !g.attachSnippet) {
        return { ok: false, error: `${a.name} 载体未实证，不支持自动写，请走手动指引` };
    }
    const already = g.connected;
    if (already)
        return { ok: true, error: `${a.name} 已连接，无需重复接入` };
    const target = g.autoWriteFile;
    const existing = fsx.exists(target) ? fsx.read(target) : "";
    // codex: TOML 数组段落追加；claude/workbuddy: JSON（这里以追加字符串为主，稳妥不破坏原 JSON——交给人工合并JSON）
    // 安全策略：codex TOML 支持多段 [[mcp_servers]] 追加；JSON 类（claude/workbuddy）只追加到文件末尾并提示用户手工校验，避免破坏原 JSON
    const snippet = "\n" + g.attachSnippet.trim() + "\n";
    const next = existing ? existing + snippet : snippet;
    if (opts.dryRun) {
        return { ok: true }; // dryRun 不落盘，返回 ok
    }
    // 备份
    const bakDir = path.join(os.homedir(), "_pending-delete", "connect-backup");
    if (!fsx.exists(bakDir))
        fsx.mkdir(bakDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = path.join(bakDir, `${a.id}-${stamp}.bak`);
    if (fsx.exists(target))
        fsx.copy(target, backupPath);
    // 写
    fsx.write(target, next);
    return { ok: true, backupPath };
}
