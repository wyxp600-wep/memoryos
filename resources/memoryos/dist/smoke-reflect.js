/**
 * MemoryOS 批次⑧ — 每日规则反思冒烟（方案 A 生产线）
 * 全程注入假 LLM（不发网络）、sync=false（不写真实注入目标文件）、临时库。
 * 覆盖：① parseRules 容错（围栏/短条目/前缀/非数组）
 *   ② 主链路：水位后候选选中 → 提炼写规则（type=rule + agent=memoryos:reflection + inject=1）+ 精确去重
 *   ③ 水位推进后二次调用无候选、不重复产
 *   ④ LLM 失败：向上抛、水位不推进（次日补跑）、审计 reflect-failed、无半截规则
 * 用法：node dist/smoke-reflect.js（smoke-all 自动收录）
 */
import { openDb, writeMemory, writeConfig, readConfig, queryByType } from "./db.js";
import { maybeRunRuleReflection, parseRules } from "./rule-reflection.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.join(os.tmpdir(), `memoryos-smoke-reflect-${Date.now()}.db`);
let failed = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
};
const reflectRules = (db) => queryByType(db, "rule", { status: "active" }).filter((r) => r.agent === "memoryos:reflection");

try {
    const db = openDb(dbPath);
    // 预置：老水位（force 场景直接可用）+ 1 条现有规则（去重靶）+ 2 条候选记忆
    writeConfig(db, "reflect", { watermark: "2020-01-01T00:00:00.000Z" });
    writeMemory(db, { content: "- **旧规则**：已存在的规则用于去重", type: "rule", agent: "codex", agent_fpath: null, project: "global" });
    writeMemory(db, { content: "回调容差 5 分钟需按东八区折算", type: "experience", agent: "codex", agent_fpath: null, project: "global" });
    writeMemory(db, { content: "含中文路径的工作区禁用 powershell -File", type: "convention", agent: "codex", agent_fpath: null, project: "global" });

    // ① parseRules 单元
    const parsed = parseRules("```json\n[{\"content\":\"- **A**：合格的规则句abcdefgh\"},{\"content\":\"短\"},{\"content\":\"无前缀的合格规则句abcdefgh\"}]\n```");
    check("P1.parseRules：合格 2 条（短条目丢弃 + 前缀补齐）", parsed.length === 2, JSON.stringify(parsed));
    check("P2.parseRules：非数组文本 → []（绝不回落成记忆）", parseRules("抱歉我无法完成").length === 0);

    // ② 主链路：假 LLM 返回 [重复旧规则, 新规则] → 只该落 1 条
    const fakeLlm = async (candidates) => {
        check("C1.水位后新增候选被选中", candidates.length >= 2, `n=${candidates.length}`);
        return ["- **旧规则**：已存在的规则用于去重", "- **反射新规则**：每日反思产线断言用规则句"];
    };
    const r1 = await maybeRunRuleReflection(db, { force: true, llm: fakeLlm, sync: false });
    check("R1.产规则 1 条（程序侧精确去重生效）", r1.produced === 1, JSON.stringify(r1));
    const nr = reflectRules(db);
    check("R2.落库 type=rule 且 agent=memoryos:reflection", nr.length === 1 && nr[0].type === "rule", `n=${nr.length}`);
    check("R3.inject=1（自动入注入段开关）", nr[0]?.inject === 1, `inject=${nr[0]?.inject}`);
    const st1 = readConfig(db, "reflect", {});
    check("R4.水位推进到本批之后 + 当日认领", st1.watermark > "2020-01-01T00:00:00.000Z" && !!st1.lastAttemptDay, `wm=${String(st1.watermark).slice(0, 19)}`);
    const a1 = db.prepare(`SELECT COUNT(*) n FROM daemon_log WHERE task='reflect' AND op='reflect-rules'`).get().n;
    check("R5.审计留痕 reflect-rules", a1 >= 1, `n=${a1}`);

    // ③ 二次调用（force）：水位已过 → 无候选 → 不重复产
    const r2 = await maybeRunRuleReflection(db, { force: true, llm: fakeLlm, sync: false });
    check("R6.水位推进后无候选跳过", r2.skipped === "no-candidates", JSON.stringify(r2));
    check("R7.规则数仍为 1（不重复产）", reflectRules(db).length === 1, `n=${reflectRules(db).length}`);

    // ④ 失败路径：回拨水位 + 抛错假 LLM → 水位不推进、认领保留、审计失败、无半截规则
    writeConfig(db, "reflect", { watermark: "2020-01-01T00:00:00.000Z" });
    let threw = false;
    try {
        await maybeRunRuleReflection(db, { force: true, llm: async () => { throw new Error("boom(模拟 LLM 不可用)"); }, sync: false });
    }
    catch { threw = true; }
    const st2 = readConfig(db, "reflect", {});
    check("E1.LLM 失败向上抛出", threw);
    check("E2.失败不推进水位（次日补跑）", st2.watermark === "2020-01-01T00:00:00.000Z", `wm=${st2.watermark}`);
    check("E3.当日认领保留（同日不重试风暴）", !!st2.lastAttemptDay, `day=${st2.lastAttemptDay}`);
    const a2 = db.prepare(`SELECT COUNT(*) n FROM daemon_log WHERE task='reflect' AND op='reflect-failed'`).get().n;
    check("E4.失败审计留痕 reflect-failed", a2 >= 1, `n=${a2}`);
    check("E5.失败未产生半截规则", reflectRules(db).length === 1, `n=${reflectRules(db).length}`);
}
finally {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    for (const s of ["-wal", "-shm"]) {
        try { fs.unlinkSync(dbPath + s); } catch { /* ignore */ }
    }
}
console.log(failed ? `\n== smoke-reflect: ${failed} FAIL ==` : `\n== smoke-reflect 全过 ==`);
process.exit(failed ? 1 : 0);
