// 一次性实证探针（2026-10-07 P0①）：临时库 buildApp + inject，验证
//   ① POST /api/cards 不传 status → 默认 todo（改进批）
//   ② 显式传 status:'triage' 仍可落 triage（采集链路不受影响）
//   ③ aux 卡显式 triage 落位正确（前端调用方保持原态）
import { openDb } from "./dist/db.js";
import { buildApp } from "./dist/dashboard.js";
import os from "node:os";
import path from "node:path";

const dbPath = path.join(os.tmpdir(), `memoryos-p0probe-${Date.now()}.db`);
const db = openDb(dbPath);
const TOKEN = "probe-token";
const app = buildApp(db, { token: TOKEN });
const inj = (o) => app.inject({ ...o, headers: { "x-memory-token": TOKEN } });

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failed++;
};

// 需要先有 card_types 注册表（openDb 应已建默认类型；task 类型须存在）
const r1 = await inj({ method: "POST", url: "/api/cards", payload: { title: "不传状态的卡", kind: "task" } });
const j1 = r1.json();
check("①不传 status 默认落 todo", r1.statusCode === 200 && j1.status === "todo", `status=${j1.status}`);

const r2 = await inj({ method: "POST", url: "/api/cards", payload: { title: "显式 triage 卡", kind: "task", status: "triage" } });
const j2 = r2.json();
check("②显式 triage 仍落 triage", r2.statusCode === 200 && j2.status === "triage", `status=${j2.status}`);

const r3 = await inj({ method: "POST", url: "/api/cards", payload: { title: "辅助卡", kind: "aux", status: "triage" } });
const j3 = r3.json();
// ★ 辅助卡缺陷已修（2026-10-07）：'aux' 注册为 builtin 类型（db.js 种子），「挂辅助卡」入口恢复。
//   原缺陷：'aux' 不在注册表 → 前端挂辅助卡恒 400「未知卡片类型」（探针此前固化过该缺陷）。
check("③「挂辅助卡」kind:'aux' 建卡恢复（缺陷已修）", r3.statusCode === 200 && j3.ok === true, `code=${r3.statusCode} status=${j3.status}`);
// 挂载线：CARD_LINK_KINDS 补入 aux_* 五种后，任务卡→辅助卡的 aux_project 线应放行
const r3b = await inj({ method: "POST", url: `/api/cards/${j1.id}/links`, payload: { dst_card_id: j3.id, kind: "aux_project" } });
check("③b aux_project 挂载线放行", r3b.statusCode === 200 && r3b.json().ok === true, `code=${r3b.statusCode} body=${r3b.body.slice(0, 60)}`);

// ④ 状态机白名单仍生效：triage 不能直接跳 done
const r4 = await inj({ method: "POST", url: `/api/cards/${j2.id}/status`, payload: { status: "done" } });
check("④迁移白名单不松动（triage→done 被拒）", r4.statusCode === 409 || r4.statusCode === 400, `code=${r4.statusCode}`);

// —— P1⑤（2026-10-07）：智能体卡不能当依赖方 ——
// 直插一张真实 agent 卡（绕开 agent_profiles 向导，本探针只关心 links 校验）
const agIns = db.prepare(`INSERT INTO cards(board,kind,title,status,meta) VALUES ('default','agent','探针智能体','todo','{}')`).run();
const agId = Number(agIns.lastInsertRowid);
const r5 = await inj({ method: "POST", url: `/api/cards/${agId}/links`, payload: { dst_card_id: j1.id, kind: "depends" } });
check("⑤a 智能体卡→任务卡 depends 被拒（噪音边治理）", r5.statusCode === 400, `code=${r5.statusCode} body=${r5.body.slice(0, 70)}`);
const r6 = await inj({ method: "POST", url: `/api/cards/${j1.id}/links`, payload: { dst_card_id: agId, kind: "depends" } });
check("⑤b 任务卡→智能体卡 depends 仍被拒（前置校验）", r6.statusCode === 400, `code=${r6.statusCode}`);
const r7 = await inj({ method: "POST", url: `/api/cards/${j1.id}/links`, payload: { dst_card_id: j2.id, kind: "depends" } });
check("⑤c 任务卡→任务卡 depends 正常放行", r7.statusCode === 200 && r7.json().ok === true, `code=${r7.statusCode}`);

// —— P2⑦（2026-10-07）：类型模板 ——
const r8 = await inj({ method: "POST", url: "/api/card-types", payload: { type_key: "probe_tpl", label: "探针模板", meta: { template: { title_prefix: "【探针】", body_skeleton: "目标：\n验收标准：" } } } });
check("⑦a 自定义类型带 meta.template 创建成功", r8.statusCode === 200, `code=${r8.statusCode} body=${r8.body.slice(0, 60)}`);
const r9 = await inj({ method: "POST", url: "/api/cards", payload: { title: "登录页改造", kind: "probe_tpl" } });
const j9 = r9.json();
check("⑦b 建卡自动套模板（标题前缀+正文骨架）", r9.statusCode === 200 && j9.status === "todo" , `title 应为「【探针】登录页改造」`);
const r10 = await inj({ method: "GET", url: `/api/cards/${j9.id}` });
const c10 = r10.json().card || {};
check("⑦c 模板落库：标题前缀生效", c10.title === "【探针】登录页改造", `title=${c10.title}`);
check("⑦d 模板落库：正文骨架生效", (c10.body || "").startsWith("目标："), `body=${JSON.stringify(c10.body).slice(0, 50)}`);

// —— P2⑨（2026-10-07）：done 自动归档（调度器） ——
const old = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 19).replace("T", " ");
const doneIns = db.prepare(`INSERT INTO cards(board,kind,title,body,status,updated_at) VALUES ('default','task','老完成的卡',NULL,'done',?)`).run(old);
const doneId = Number(doneIns.lastInsertRowid);
const freshIns = db.prepare(`INSERT INTO cards(board,kind,title,body,status,updated_at) VALUES ('default','task','刚完成的卡',NULL,'done',?)`).run(new Date().toISOString().slice(0, 19).replace("T", " "));
const freshId = Number(freshIns.lastInsertRowid);
const rd = await inj({ method: "POST", url: "/api/dispatch", payload: {} });
const jd = rd.json();
const stOld = (await inj({ method: "GET", url: `/api/cards/${doneId}` })).json().card?.status;
const stFresh = (await inj({ method: "GET", url: `/api/cards/${freshId}` })).json().card?.status;
check("⑨a done 满 7 天自动 archived", stOld === "archived" && (jd.auto_archived || []).includes(doneId), `status=${stOld} auto_archived=${JSON.stringify(jd.auto_archived)}`);
check("⑨b 未满 7 天的 done 不动", stFresh === "done", `status=${stFresh}`);

db.close();
try { const fs = await import("node:fs"); fs.unlinkSync(dbPath); } catch {}
process.exit(failed ? 1 : 0);
