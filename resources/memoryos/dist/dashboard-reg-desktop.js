/** T8（P2-3）：buildApp 路由域拆分 —— desktop 域。
 * handler 自 dashboard.js 原行 1243-1305 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { detectVaults, importVault, exportMemories, vaultStatus } from "./obsidian-sync.js";
import { getEmbedder } from "./embed.js";
import { computeStatus, syncSkills, detectSkillTargets } from "./skill-sync.js";
import path from "node:path";
export function registerDesktop(app, ctx) {
    const { db,  } = ctx;
    // —— Obsidian 同步：vault 探测 / 状态 / 导入 / 导出（复用 obsidian-sync.js，逻辑不重写）——
    app.get("/api/obsidian/vaults", async () => ({ vaults: detectVaults() }));
    app.get("/api/obsidian/status", async (req, reply) => {
        const vault = req.query.vault;
        if (!vault)
            return reply.code(400).send({ error: "vault 参数必填" });
        try {
            const s = vaultStatus(db, vault);
            const imported = db
                .prepare(`SELECT note_path, memory_id, substr(note_hash,1,8) AS note_hash, mtime_ms, created_at FROM obsidian_sync WHERE vault_root=? ORDER BY created_at DESC LIMIT 200`)
                .all(path.resolve(vault));
            return { ...s, imported };
        }
        catch (e) {
            return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/api/obsidian/import", async (req, reply) => {
        const vault = req.body.vault;
        if (!vault)
            return reply.code(400).send({ ok: false, error: "vault 必填" });
        try {
            const embedder = await getEmbedder();
            const stats = await importVault(db, embedder, {
                vaultPath: vault,
                project: req.body.project,
                dryRun: !!req.body.dry_run,
                agent: "obsidian",
            });
            return { ok: true, stats };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/api/obsidian/export", async (req, reply) => {
        const vault = req.body.vault;
        if (!vault)
            return reply.code(400).send({ ok: false, error: "vault 必填" });
        try {
            const stats = exportMemories(db, {
                vaultPath: vault,
                project: req.body.project,
                type: req.body.type,
                limit: req.body.limit,
            });
            return { ok: true, stats };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    // —— 技能同步：中央库状态 / 一键分发（复用 skill-sync.js，纯文件操作不依赖 db）——
    app.get("/api/skills/status", async () => ({ ...computeStatus(), detected: detectSkillTargets() }));
    app.post("/api/skills/sync", async (req, reply) => {
        try {
            const results = syncSkills(!!req.body.dry_run);
            return { ok: true, dry_run: !!req.body.dry_run, results };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
}
