/**
 * P2-④（2026-09-22，A 分区接管 B 分区）：server.js MCP 工具面按域拆分 —— Obsidian 域（3 个工具）。
 *
 * 搬移口径：自 server.js 原 L806–L891 逐字搬移；注册顺序/工具名/描述/schema/响应文案不变。
 * 缩进说明：代码行统一加 4 空格；多行模板字面量内部行逐字保留。
 * 共享顶层名经 ctx 注入：db / AGENT / AGENT_FPATH。
 */
import { z } from "zod";
import { importVault, exportMemories, writeNoteToVault } from "./obsidian-sync.js";
import { getEmbedder } from "./embed.js";

export function registerObsidianTools(server, ctx) {
    const { db, AGENT, AGENT_FPATH } = ctx;
    server.addTool({
        name: "obsidian_import",
        description: "把 Obsidian vault 的 .md 笔记增量导入共享记忆库（幂等：按内容哈希，不变跳过/变更更新/新增入库，agent=obsidian，project 默认取 vault 目录名）。适合把本地笔记/知识库沉淀为可检索记忆。",
        parameters: z.object({
            vault: z.string().describe("Obsidian vault 绝对路径（含 .md 笔记的根目录）"),
            project: z.string().optional().describe("project scope，默认取 vault 目录名"),
            dry_run: z.boolean().default(false).describe("预演：只统计不落库"),
        }),
        async execute(args) {
            try {
                const embedder = await getEmbedder();
                const stats = await importVault(db, embedder, {
                    vaultPath: args.vault,
                    project: args.project,
                    dryRun: args.dry_run,
                    agent: "obsidian",
                });
                return `扫描 ${stats.scanned} 个笔记 → 新增 ${stats.added} / 更新 ${stats.updated} / 去重合并 ${stats.merged} / 跳过 ${stats.skipped} / 失败 ${stats.failed}（project=${stats.project}${stats.dryRun ? "，dry-run 未落库" : ""}）`;
            }
            catch (e) {
                return `obsidian_import 失败：${e instanceof Error ? e.message : String(e)}`;
            }
        },
    });
    server.addTool({
        name: "obsidian_export",
        description: "把记忆库中 active 记忆导出为 Markdown 笔记（带溯源 frontmatter），写入 vault/MemoryOS 导出/，幂等不覆盖。适合把高价值记忆沉淀回 Obsidian 复盘。",
        parameters: z.object({
            vault: z.string().describe("Obsidian vault 绝对路径（导出目录 = vault/MemoryOS 导出）"),
            project: z.string().optional().describe("project scope 过滤，缺省=全部"),
            type: z.string().optional().describe("类型过滤（decision/experience/pitfall/convention）"),
            limit: z.number().int().min(1).max(500).optional().describe("导出条数上限（按 id 升序）"),
        }),
        async execute(args) {
            try {
                const stats = exportMemories(db, {
                    vaultPath: args.vault,
                    project: args.project,
                    type: args.type,
                    limit: args.limit,
                });
                return `导出到 ${stats.dir}：写入 ${stats.written} / 跳过(已存在) ${stats.skipped} / 失败 ${stats.failed}`;
            }
            catch (e) {
                return `obsidian_export 失败：${e instanceof Error ? e.message : String(e)}`;
            }
        },
    });
    server.addTool({
        name: "obsidian_write_note",
        description: "往 Obsidian vault 写单条笔记（带溯源 frontmatter），同时同步写入共享记忆库（去重预检 + 埋点），并记录 obsidian_sync 元表映射。文件已存在时加时间戳后缀，绝不覆盖。适用：Agent 把修复结论/技术决策/隐藏约定沉淀回 Obsidian 笔记库。",
        parameters: z.object({
            vault: z.string().describe("Obsidian vault 绝对路径"),
            title: z.string().describe("笔记标题（同时用作文件名）"),
            content: z.string().describe("笔记正文（结构化，含结论 + 依据）"),
            type: z
                .enum(["decision", "experience", "pitfall", "convention"])
                .default("experience")
                .describe("记忆类型"),
            project: z.string().default("global").describe("记忆库 project scope（默认 global，所有 Agent 可检索）"),
            folder: z
                .string()
                .optional()
                .describe("vault 内子文件夹（默认 MemoryOS 写入；相对目录名，禁止 .. 穿越/绝对路径/盘符/UNC）")
                .refine((f) => !/\.\./.test(String(f)) && !/^[A-Za-z]:[\\/]/.test(String(f)) && !/^\\\\/.test(String(f)), { message: "folder 非法：禁止路径穿越（..）、绝对路径、盘符或 UNC" }),
        }),
        async execute(args) {
            try {
                const embedder = await getEmbedder();
                const result = await writeNoteToVault(db, embedder, {
                    vaultPath: args.vault,
                    title: args.title,
                    content: args.content,
                    type: args.type,
                    project: args.project,
                    folder: args.folder,
                    agent: AGENT,
                    agent_fpath: AGENT_FPATH,
                });
                return `已写入笔记 → ${result.notePath}（记忆 #${result.memoryId}，${result.created ? "新建" : "已存在→加时间戳后缀"}，project=${args.project}）`;
            }
            catch (e) {
                return `obsidian_write_note 失败：${e instanceof Error ? e.message : String(e)}`;
            }
        },
    });
}

