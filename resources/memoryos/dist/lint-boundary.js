/**
 * ★ 2026-11-17（B7-04 · Node 回退版）：跨库边界扫描器。
 *
 * 目的：在没有 Rust 工具链（cargo/rustc 均 MISSING）时，用 Node 提供与
 * `tools/boundary-lint`（Rust 版，见主计划 B7-04）**同规则**的静态检查，
 * 让「任务库 / 记忆库 / 关联层」三条边界在 CI 里可验证。
 *
 * 规则（只读静态扫描，不连接数据库、不执行业务代码）：
 *   R1 记忆侧模块禁止直连任务库（`task_store.`）—— 必须经 task-links / 标准接口。
 *   R2 任务侧模块禁止直连记忆表（`main.knowledge_records`）。
 *   R3 所有生产模块禁止**写**跨库 UNION 视图（`INSERT/UPDATE/DELETE ... memories`），
 *      写入必须走 createMemoryRow / createTaskRow。
 *   R4 读裸视图（`FROM memories`）仅告警：B8 尚未清零，属已知债务。
 *
 * 豁免：task-links.js（唯一关联层）、task-store.js / memory-store.js（各自物理层）、
 *      db.js（记录寻址与索引原语）、storage.js（视图定义本身）。
 *
 * 用法：
 *   node dist/lint-boundary.js                # warn 模式：只报告，退出码 0
 *   node dist/lint-boundary.js --mode=error   # 存在 error 级违规时退出码 1
 *   node dist/lint-boundary.js --json         # 机器可读
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = dirname(fileURLToPath(import.meta.url));

/** 豁免文件：每一条都要有「为什么可以同时认识两侧」的理由，不要随意加。 */
const EXEMPT = new Map([
    ["task-links.js", "唯一关联层：显式持有 taskStore + memoryStore 两侧句柄"],
    ["task-store.js", "任务物理层：只应触碰 task_store.*"],
    ["memory-store.js", "记忆物理层：只应触碰 main.knowledge_records"],
    ["db.js", "记录寻址/索引原语层：FTS、gram、向量、归属判定的单一实现点"],
    ["storage.js", "视图与触发器定义本身（B8 待删目标）"],
    ["merge-db.js", "跨库/旧单库迁移工具，源库结构可能不存在 knowledge_records"],
    ["record-source.js", "显式跨库查询接口的唯一实现点（替代 temp.memories 视图）"],
    ["record-tables.js", "两库物理表名的唯一常量来源，本就必须同时声明两侧"],
]);

const TASK_SIDE = (f) => f.startsWith("task-");

/** 收集生产模块（排除冒烟测试与自身）。 */
function productionFiles() {
    return readdirSync(DIST)
        .filter((f) => f.endsWith(".js"))
        .filter((f) => !f.startsWith("smoke"))
        .filter((f) => f !== "lint-boundary.js");
}

const RULES = [
    {
        id: "R1",
        severity: "warn",
        re: /\btask_store\.\w+/g,
        applies: (f) => !TASK_SIDE(f),
        msg: "记忆侧模块直连任务库（只读聚合可接受，需逐步收敛到 task-links）",
        how: "写侧必须走 task-links；读侧若确属跨库聚合，在文件头注明理由",
    },
    {
        id: "R2",
        severity: "error",
        re: /\bmain\.knowledge_records\b/g,
        applies: (f) => TASK_SIDE(f),
        msg: "任务侧模块直连记忆表",
        how: "改走 memory-writer / memory-store，任务域不应认识记忆表名",
    },
    {
        id: "R3",
        severity: "error",
        re: /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+memories\b/gi,
        applies: () => true,
        msg: "写跨库 UNION 视图（应走 createMemoryRow / createTaskRow）",
        how: "换成 createMemoryRow(db, {...})；type=task 会自动路由到任务库",
    },
    {
        id: "R4",
        severity: "warn",
        re: /\b(?:FROM|JOIN)\s+memories\b/gi,
        applies: () => true,
        msg: "读裸视图 memories（B8 未清零，已知债务）",
        how: "纯记忆语义改 main.knowledge_records；需跨库时显式两查询或 UNION",
    },
];

/** 逐行扫描；注释行不计入（避免把历史说明当违规）。 */
function scan() {
    const findings = [];
    for (const file of productionFiles()) {
        if (EXEMPT.has(file)) continue;
        const lines = readFileSync(join(DIST, file), "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))
                return;
            for (const rule of RULES) {
                if (!rule.applies(file)) continue;
                rule.re.lastIndex = 0;
                if (!rule.re.test(line)) continue;
                findings.push({
                    rule: rule.id,
                    severity: rule.severity,
                    file,
                    line: i + 1,
                    message: rule.msg,
                    remedy: rule.how,
                    text: trimmed.slice(0, 160),
                });
            }
        });
    }
    return findings;
}

const findings = scan();
const errors = findings.filter((f) => f.severity === "error");
const warns = findings.filter((f) => f.severity === "warn");

/**
 * ★ 2026-11-17（B8 修正）：豁免文件不计错，但**必须可见**。
 * 曾因 db.js 整体豁免，导致「WARN 0」掩盖了 56 处裸视图引用（删视图预演 45 项测试失败才暴露）。
 * 这里单独统计豁免文件的裸视图引用数，只展示、不影响退出码 —— 避免"假清零"。
 */
function exemptViewRefs() {
    const re = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+memories\b/gi;
    const out = [];
    for (const [file, why] of EXEMPT) {
        let n = 0;
        try {
            const lines = readFileSync(join(DIST, file), "utf8").split(/\r?\n/);
            for (const line of lines) {
                const t = line.trim();
                if (!t || t.startsWith("//") || t.startsWith("*")) continue;
                re.lastIndex = 0;
                if (re.test(line)) n++;
            }
        }
        catch { n = -1; }
        if (n !== 0) out.push({ file, refs: n, why });
    }
    return out.sort((a, b) => b.refs - a.refs);
}
const exemptRefs = exemptViewRefs();

if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ total: findings.length, error: errors.length, warn: warns.length, findings }, null, 2));
} else {
    const group = (rows) => {
        const m = new Map();
        for (const r of rows) m.set(r.file, (m.get(r.file) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    console.log("lint-boundary（Node 回退版 · Rust 缺失时同规则兜底）");
    console.log(`扫描 ${productionFiles().length} 个生产模块，豁免 ${EXEMPT.size} 个`);
    console.log("");
    console.log(`ERROR ${errors.length} 处 / WARN ${warns.length} 处`);
    for (const [label, rows] of [["ERROR", errors], ["WARN", warns]]) {
        if (!rows.length) continue;
        console.log("");
        console.log(`— ${label} 分布 —`);
        for (const [f, n] of group(rows)) console.log(`  ${f}  ${n}`);
    }
    if (errors.length) {
        console.log("");
        console.log("— ERROR 明细（前 30 条）—");
        for (const r of errors.slice(0, 30))
            console.log(`  [${r.rule}] ${r.file}:${r.line} ${r.message}\n         → ${r.remedy}\n         ${r.text}`);
    }
    if (exemptRefs.length) {
        console.log("");
        console.log("— 豁免文件内的裸视图引用（不算错，但删视图前必须归零）—");
        for (const e of exemptRefs) console.log(`  ${e.file}  ${e.refs} 处  （${e.why}）`);
        console.log(`  合计 ${exemptRefs.reduce((s, e) => s + e.refs, 0)} 处`);
    }
}

const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=warn").split("=")[1];
const failed = mode === "error" && errors.length > 0;
console.log("");
console.log(failed ? `lint-boundary: FAILED（${errors.length} 处 error）` : `lint-boundary: PASS（mode=${mode}）`);
process.exit(failed ? 1 : 0);
