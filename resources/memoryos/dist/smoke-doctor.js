import { openDb } from "./db.js";
import { MEMORY_BODY_TEMPLATE } from "./memory-body.js";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

let PASS = 0,
    FAIL = 0;
const ok = (n, cond, extra = "") => {
    if (cond) {
        PASS++;
        console.log(`  ✅ ${n}${extra ? "  " + extra : ""}`);
    } else {
        FAIL++;
        console.error(`  ❌ ${n}${extra ? "  " + extra : ""}`);
    }
};

const tmp = path.join(os.tmpdir(), `memdoctor-${process.pid}.db`);
const script = fileURLToPath(new URL("./doctor.js", import.meta.url));
const runDoctor = (extraArgs = []) =>
    spawnSync(process.execPath, [script, ...extraArgs], {
        env: { ...process.env, MEMORY_DB: tmp },
        encoding: "utf8",
    });

fs.rmSync(tmp, { force: true });
const db = openDb(tmp);
// 造一条记忆（最小列集）；随后 doctor 的 checkProvenance 应读到 0 条向量或已就位列结构。
// 注：正文必须过主库六字段兜底触发器（memory_body_v3_insert，WHEN source='agent' AND type!='task'），
// 旧写法 content='t' 会被判 MEMORY_BODY_FORMAT 直接 ABORT，故直接绑现行模板样例（也顺带证明模板可落库）。
db.prepare(
    `INSERT INTO memories(id, content, project, status, agent, created_at) VALUES (1, ?, 'global', 'active', 'test', '2026-10-15T00:00:00Z')`
).run(MEMORY_BODY_TEMPLATE);
db.close();

// D1：--json 输出可解析 + 6 项体检全在
const j1 = runDoctor(["--json"]);
let parsed = null;
try {
    parsed = JSON.parse(j1.stdout);
} catch (e) {
    /* 空 stdout 也容忍 */
}
ok("D1.1 doctor --json 可解析", j1.status === 0 && parsed && Array.isArray(parsed.checks), `status=${j1.status}`);
ok("D1.2 原六项加业务数据库隔离与三库残留基线共八项", parsed?.checks?.length === 8 && parsed.checks.some(c=>c.label==='业务数据库隔离' && c.ok===true), `(${parsed?.checks?.length})`);
const labels = parsed?.checks?.map((c) => c.label) ?? [];
ok(
    "D1.3 六项标签齐全",
    ["嵌入模式", "库实例 ID", "向量出处", "对账滞后", "daemon/采集最近活动", "内核重启次数"].every((l) =>
        labels.includes(l)
    ),
    `(${labels.join("/")})`
);

// D2：--fix 写入实例 ID 后，重跑应消除「库实例 ID」WARN
runDoctor(["--fix"]);
const j2 = runDoctor(["--json"]);
let parsed2 = null;
try {
    parsed2 = JSON.parse(j2.stdout);
} catch (e) {}
const inst = parsed2?.checks?.find((c) => c.label === "库实例 ID");
ok("D2.1 --fix 后实例 ID 项转 PASS", inst?.level === "pass", `(${inst?.level})`);

// D3：人类可读模式退出码 0（非交互体检不判 FAIL 时应可干净退出）
const human = runDoctor([]);
ok("D3.1 人类可读模式运行成功", human.status === 0 && /MemoryOS doctor/.test(human.stdout), `(status=${human.status})`);

// ── D4/D5/D6：三库分离残留基线（#700035）────────────────────────────────
// 取残留体检项
const residueOf = (parsedJson) => parsedJson?.checks?.find((c) => c.label === "三库分离残留基线") ?? null;

// D4 干净库（本冒烟的 tmp 库，无任何任务行）→ 前 5 项必须为 0 且判 PASS
const r4 = residueOf(parsed);
ok("D4.1 体检项「三库分离残留基线」存在", !!r4, `(${r4?.level})`);
ok("D4.2 输出 6 项残留计数", Array.isArray(r4?.items) && r4.items.length === 6, `(${r4?.items?.length})`);
ok(
    "D4.3 干净库前 5 项全为 0 且判 PASS",
    r4?.level === "pass" && r4.items.slice(0, 5).every((x) => x.count === 0),
    `(${r4?.items?.map((x) => x.count).join("/")})`
);
ok(
    "D4.4 第 6 项 memory_events 标记 KNOWN（不参与判失败）",
    r4?.items?.[5]?.known === true && /memory_events/.test(r4.items[5].name),
    `(${r4?.items?.[5]?.name})`
);

// 造脏库的公共工具：临时库去掉主库触发器（模拟"守卫上线前就已在库里的历史脏行"，
// 守卫本身只挡新写入，残留体检要抓的正是已经漏进去的那些）。
function makeDirtyDb(tag, inject) {
    const file = path.join(os.tmpdir(), `memdoctor-${process.pid}-${tag}.db`);
    for (const suffix of ["", ".tasks.db", ".runtime.db", ".db-wal", ".db-shm", ".tasks.db-wal", ".tasks.db-shm"])
        fs.rmSync(file + suffix, { force: true });
    const d = openDb(file);
    // 走 storage.raw：冒烟要模拟"守卫上线前就躺在库里的历史脏行"，必须绕开写侧兜底触发器与编号闸门；
    // 生产写路径仍受守卫保护，本函数只在临时库里造数据，不碰任何真实库。
    const raw = d.storage.raw;
    const trg = raw
        .prepare(`SELECT name FROM main.sqlite_master WHERE type='trigger'`)
        .all()
        .map((r) => r.name);
    for (const n of trg) raw.exec(`DROP TRIGGER main."${n}"`);
    raw.exec(`DROP INDEX IF EXISTS main.idx_memories_gram`);
    const dropped = trg.length;
    inject(raw);
    d.close();
    const j = JSON.parse(runOn(file, ["--json"]).stdout);
    for (const suffix of ["", ".tasks.db", ".runtime.db", ".db-wal", ".db-shm", ".tasks.db-wal", ".tasks.db-shm"])
        fs.rmSync(file + suffix, { force: true });
    return { residue: residueOf(j), dropped };
}
const runOn = (file, extraArgs) =>
    spawnSync(process.execPath, [script, ...extraArgs], { env: { ...process.env, MEMORY_DB: file }, encoding: "utf8" });

// D5 只脏 memory_events（任务事件行，已知项 K1）→ 必须仍判 PASS，不得误报
const TASK_OID = 900001;
// task_records 有 CHECK 约束「任务库只接收任务记录」，type 必须显式为 'task'
const seedTask = (d) =>
    d
        .prepare(`INSERT INTO task_store.task_records(id, content, type, agent) VALUES (?, '冒烟脏任务', 'task', 'smoke')`)
        .run(TASK_OID);
const d5 = makeDirtyDb("known", (d) => {
    seedTask(d);
    d.prepare(`INSERT INTO main.memory_events(memory_id, op) VALUES (?, 'merge')`).run(TASK_OID);
    d.prepare(`INSERT INTO main.memory_events(memory_id, op) VALUES (?, 'keep_new')`).run(TASK_OID);
});
ok(
    "D5.1 仅 memory_events 有任务行时不误报（判 PASS）",
    d5.residue?.level === "pass" && d5.residue?.items?.[5]?.count === 2,
    `(events=${d5.residue?.items?.[5]?.count}, level=${d5.residue?.level})`
);

// D6 前 5 项中可造的 4 项同时脏 → 必须判 FAIL 且逐项点名
const d6 = makeDirtyDb("dirty", (d) => {
    seedTask(d);
    d.prepare(`INSERT INTO main.memories_fts(rowid, content, project) VALUES (?, '冒烟残留', 'global')`).run(TASK_OID);
    d.prepare(`INSERT INTO main.memories_gram(gram, memory_id) VALUES ('冒烟', ?)`).run(TASK_OID);
    d.prepare(`INSERT INTO main.memory_vectors(memory_id, embedding, embed_model, dim) VALUES (?, X'00', 'bge-m3', 1024)`).run(
        TASK_OID
    );
    d.prepare(`INSERT INTO main.knowledge_records(id, content, type, agent) VALUES (?, '冒烟脏知识', 'task', 'smoke')`).run(
        TASK_OID
    );
    d.prepare(`INSERT INTO main.memory_events(memory_id, op) VALUES (?, 'merge')`).run(TASK_OID);
});
const offenders6 = (d6.residue?.items ?? []).filter((x) => !x.known && x.count !== 0).map((x) => x.name);
ok("D6.1 残留非 0 时判 FAIL", d6.residue?.level === "fail" && d6.residue?.ok === false, `(${d6.residue?.level})`);
ok(
    "D6.2 逐项点名四类可造残留",
    ["memories_fts", "memories_gram", "memory_vectors", "knowledge_records"].every((k) =>
        offenders6.some((n) => n.includes(k))
    ),
    `(${offenders6.join(" / ")})`
);
ok(
    "D6.3 FAIL 时仍不把 KNOWN 项算作失败依据",
    d6.residue?.items?.[5]?.known === true && !offenders6.some((n) => /memory_events/.test(n)),
    `(events=${d6.residue?.items?.[5]?.count}, offenders=${offenders6.length})`
);
// 第 5 项 task_sequence 表存在：openDb 里 storage.js 的 A5 迁移会在开库瞬间自愈删除主库旧表，
// 子进程冒烟无法造出非零态（这是迁移在起作用，不是体检失效）。此处只锁它的结构性归属：
// 必须属于"前 5 项须为 0"的判失败集合（known=false），一旦迁移回退/被绕过即触发 FAIL。
ok(
    "D6.4 第 5 项 task_sequence 归入判失败集合（绊线保留）",
    d6.residue?.items?.[4]?.known === false && /task_sequence/.test(d6.residue.items[4].name),
    `(${d6.residue?.items?.[4]?.name}=${d6.residue?.items?.[4]?.count}, note=${d6.residue.items[4].note || "-"})`
);
ok("D6.5 脏库构造已去除主库触发器（模拟守卫上线前的历史脏行）", d6.dropped > 0, `(dropped=${d6.dropped})`);

for (const suffix of ["", ".tasks.db", ".runtime.db", ".db-wal", ".db-shm", ".tasks.db-wal", ".tasks.db-shm"])
    fs.rmSync(tmp + suffix, { force: true });
console.log(`\n[smoke-doctor] PASS=${PASS} FAIL=${FAIL}`);
process.exit(FAIL ? 1 : 0);
