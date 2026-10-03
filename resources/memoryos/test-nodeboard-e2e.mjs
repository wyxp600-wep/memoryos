/* 节点画布 P0 后端端到端验证（隔离库：MEMORY_DB 指向临时目录，不碰生产库） */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nc-e2e-"));
const PORT = "8790";
const TOKEN = "e2e-test-token";
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let passed = 0, failed = 0;

const ok = (name, cond, detail = "") => {
    if (cond) { passed++; console.log(`  通过  ${name}`); }
    else { failed++; console.log(`  失败  ${name}  ${detail}`); }
};
const j = (data, method = "GET", path2 = "") =>
    fetch(`${BASE}${path2}`, {
        method,
        headers: { "content-type": "application/json", "x-memory-token": TOKEN },
        body: method === "GET" ? undefined : JSON.stringify(data),
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
    child = spawn(process.execPath, ["dist/dashboard.js"], {
        cwd: HERE,
        env: { ...process.env, MEMORY_DB: path.join(TMP, "memory.db"), MEMORY_TOKEN: TOKEN, MEMORY_PORT: PORT, EMBED_MODE: "fake" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", d => process.stderr.write(`[srv] ${d}`));
    // 就绪轮询
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
        await new Promise(r => setTimeout(r, 500));
        try { up = (await fetch(`${BASE}/api/card-types?token=${TOKEN}`)).status === 200; } catch { /* 未就绪 */ }
    }
    if (!up) throw new Error("服务 20 秒内未就绪");
    console.log("服务已就绪（隔离库 " + TMP + "）");

    // 1. 类型注册表种子
    let r = await j(null, "GET", "/api/card-types");
    const types = Object.fromEntries((r.body.types || []).map(t => [t.type_key, t]));
    ok("内置四类型齐全", ["task", "agent", "handoff", "doc"].every(k => types[k]), JSON.stringify(Object.keys(types)));
    ok("task 档位=可派发出/可注入入", types.task?.can_dispatch_out === 1 && types.task?.can_inject_in === 1);

    // 2. 建卡缺省 = 文档卡
    r = await j({ title: "无类型卡" }, "POST", "/api/cards");
    ok("POST /api/cards 缺省 kind=doc", r.body.kind === "doc", JSON.stringify(r.body));
    const docId = r.body.id;

    // 3. 智能体档案 + 投影卡
    r = await j({ name: "测试智能体", channel: "queue", agent_key: "codex" }, "POST", "/api/agent-profiles");
    ok("建档案返回 profile_id+card_id", r.body.ok && r.body.profile_id > 0 && r.body.card_id > 0, JSON.stringify(r.body));
    const agentCardId = r.body.card_id;
    r = await j(null, "GET", "/api/agent-profiles");
    const prof1 = (r.body.profiles || [])[0];
    ok("档案列表含投影卡与载体标记", prof1?.card?.card_id === agentCardId && "carrier_missing" in prof1);

    // 4. 改型：doc→task→agent（切入建档案）→doc（切出删档案）
    r = await j({ title: "任务甲", kind: "task" }, "POST", "/api/cards");
    const taskA = r.body.id;
    r = await j({ kind: "task" }, "POST", `/api/cards/${docId}/retype`);
    ok("doc→task 改型", r.body.ok && r.body.kind === "task", JSON.stringify(r.body));
    r = await j({ kind: "agent", profile: { name: "切换档案", channel: "cli", workspace: "D:\\x" } }, "POST", `/api/cards/${docId}/retype`);
    ok("切入 agent 自动建档案", r.body.ok && r.body.profile_id > 0, JSON.stringify(r.body));
    const switchProfileId = r.body.profile_id;
    r = await j({ kind: "doc" }, "POST", `/api/cards/${docId}/retype`);
    ok("切出 agent 删除档案（不留孤儿）", r.body.ok);
    r = await j(null, "GET", "/api/agent-profiles");
    ok("切出后档案数回落", (r.body.profiles || []).length === 1, `数量=${(r.body.profiles || []).length}`);

    // 5. 注入边：handoff→task 通；重复 409；dispatch 类拒绝；task→task 档位拒绝
    r = await j({ title: "交接一", kind: "handoff" }, "POST", "/api/cards");
    const handoffId = r.body.id;
    r = await j({ title: "任务乙", kind: "task" }, "POST", "/api/cards");
    const taskB = r.body.id;
    r = await j({ source_id: handoffId, target_id: taskB, kind: "inject" }, "POST", "/api/card-edges");
    ok("handoff→task 注入边创建", r.body.ok && r.body.id > 0, JSON.stringify(r.body));
    const edgeId = r.body.id;
    r = await j({ source_id: handoffId, target_id: taskB, kind: "inject" }, "POST", "/api/card-edges");
    ok("重复注入 409", r.status === 409, `status=${r.status}`);
    r = await j({ source_id: handoffId, target_id: taskB, kind: "dispatch" }, "POST", "/api/card-edges");
    ok("此端点拒绝 dispatch 边", r.status === 400, `status=${r.status}`);
    r = await j({ source_id: taskA, target_id: taskB, kind: "inject" }, "POST", "/api/card-edges");
    ok("task 类型不可发起注入（档位校验）", r.status === 409, `status=${r.status}`);
    r = await j(null, "DELETE", `/api/card-edges/${edgeId}`);
    ok("注入边可删", r.body.ok);
    r = await j(null, "DELETE", "/api/card-edges/99999");
    ok("删不存在边 404", r.status === 404);

    // 6. 自定义类型：创建/应用/占用守卫/删除
    r = await j({ type_key: "milestone", label: "里程碑", can_dispatch_in: 1 }, "POST", "/api/card-types");
    ok("自定义类型创建", r.body.ok, JSON.stringify(r.body));
    r = await j({ type_key: "task", label: "仿冒" }, "POST", "/api/card-types");
    ok("保留标识拒绝", r.status === 409, `status=${r.status}`);
    r = await j({ kind: "milestone" }, "POST", `/api/cards/${taskA}/retype`);
    ok("卡片改型为自定义类型", r.body.ok, JSON.stringify(r.body));
    r = await j(null, "DELETE", "/api/card-types/milestone");
    ok("类型被占用时删除 409", r.status === 409, `status=${r.status}`);
    r = await j({ kind: "doc" }, "POST", `/api/cards/${taskA}/retype`);
    r = await j(null, "DELETE", "/api/card-types/milestone");
    ok("闲置后可删除", r.body.ok, JSON.stringify(r.body));

    // 7. 智能体卡状态端点
    r = await j(null, "GET", `/api/agent-cards/${agentCardId}/state`);
    ok("状态端点：通道/队列/载体标记", r.body.ok && r.body.channel === "queue" && r.body.queue_depth === 0 && "carrier_missing" in r.body, JSON.stringify(r.body));
    r = await j(null, "GET", "/api/agent-cards/99999/state");
    ok("不存在智能体卡 404", r.status === 404);

    // 8. 派发状态机（乙为 triage → 409，不触 run 域）
    r = await j({ agent_card_id: agentCardId }, "POST", `/api/cards/${taskB}/dispatch-agent`);
    ok("非 ready 卡派发被拒（409 状态机守卫）", r.status === 409, `status=${r.status} body=${JSON.stringify(r.body)}`);

    // 9. 图返回 edges
    r = await j(null, "GET", "/api/cards/graph");
    ok("graph 返回 edges 数组", Array.isArray(r.body.edges), `edges=${JSON.stringify(r.body.edges).slice(0, 120)}`);
    ok("graph 智能体节点带 profileMissing 标记", (r.body.nodes || []).some(n => n.kind === "agent" && "profileMissing" in n));

    // 10. 档案删除连带投影卡
    r = await j(null, "GET", "/api/agent-profiles");
    const pid2 = r.body.profiles[0].id;
    r = await j(null, "DELETE", `/api/agent-profiles/${pid2}`);
    ok("删除档案成功", r.body.ok);
    r = await j(null, "GET", "/api/cards/graph");
    ok("投影卡随之消失", !(r.body.nodes || []).some(n => n.kind === "agent"));

    // ═══ 11. P2 CLI 直控执行器（launch_overrides 全覆盖 → fake CLI，无需真实智能体）═══
    // fake 脚本落盘为文件（避免 -e 内嵌引号与 cmd 引号规则互相纠缠）
    const fakePath = path.join(TMP, "fake-cli.js");
    fs.writeFileSync(fakePath, 'console.log("步骤1：开始执行");\nconsole.log("中间输出");\nconsole.log("<<<HANDOFF>>>");\nconsole.log("交接内容甲：测试任务已完成");\nconsole.log("<</HANDOFF>>>");\n');
    r = await j({
        name: "直控测试智能体", channel: "cli", agent_key: "codex", workspace: TMP, concurrency: 1,
        launch_overrides: { cmd: process.execPath, args: [fakePath], useStdin: true, timeoutMinutes: 1 },
    }, "POST", "/api/agent-profiles");
    ok("建 CLI 通道档案", r.body.ok && r.body.profile_id > 0, JSON.stringify(r.body));
    const cliCardId = r.body.card_id;
    r = await j({ title: "直控任务", kind: "task" }, "POST", "/api/cards");
    const cliTaskId = r.body.id;
    await j({ status: "todo" }, "POST", `/api/cards/${cliTaskId}/status`);
    r = await j({ agent_card_id: cliCardId }, "POST", `/api/cards/${cliTaskId}/dispatch-agent`);
    ok("CLI 派发返回 executor 标记", r.status === 202 && r.body.executor === true && !!r.body.runId, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 150)}`);
    await new Promise(res => setTimeout(res, 3500));
    r = await j(null, "GET", `/api/cards/${cliTaskId}`);
    ok("CLI 执行收口：任务卡 → review", r.body.card?.status === "review", JSON.stringify(r.body).slice(0, 120));
    r = await j(null, "GET", `/api/cards/graph`);
    const cliEdge = (r.body.edges || []).find(e => String(e.source_id) === String(cliTaskId));
    ok("派发边随收口翻 completed", cliEdge?.status === "completed", JSON.stringify(cliEdge));
    const cliHandoff = (r.body.nodes || []).find(n => n.kind === "handoff" && String(n.body || "").includes("交接内容甲"));
    ok("分隔符协议解析出交接内容", !!cliHandoff, "未找到含交接内容的 handoff 卡");
    r = await j(null, "GET", `/api/agent-cards/${cliCardId}/exec`);
    ok("执行记录可查（done）", r.body.runs?.[0]?.status === "done", JSON.stringify(r.body).slice(0, 150));
    r = await j(null, "POST", `/api/agent-cards/${cliCardId}/exec/stop`);
    ok("无执行中任务时停止 404", r.status === 404, `status=${r.status}`);
    // ═══ 12. P3 CDP 驾驶执行器（fake App：node 秒退 → CDP 端点未就绪 → 诚实失败收口）═══
    r = await j({
        name: "驾驶卡", channel: "cdp", agent_key: "codex",
        launch_overrides: { exe: process.execPath, args: ["-e", "process.exit(0)"], cdpTimeoutMs: 2000 },
    }, "POST", "/api/agent-profiles");
    ok("建 CDP 通道档案", r.body.ok && r.body.profile_id > 0, JSON.stringify(r.body));
    const cdpCard = r.body.card_id;
    r = await j({ title: "驾驶任务", kind: "task" }, "POST", "/api/cards");
    const cdpTaskId = r.body.id;
    await j({ status: "todo" }, "POST", `/api/cards/${cdpTaskId}/status`);
    r = await j({ agent_card_id: cdpCard }, "POST", `/api/cards/${cdpTaskId}/dispatch-agent`);
    ok("CDP 派发受理（202 + runId）", r.status === 202 && !!r.body.runId, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 120)}`);
    await new Promise(res => setTimeout(res, 5000));
    r = await j(null, "GET", `/api/cards/${cdpTaskId}`);
    ok("CDP 端点未就绪 → 诚实失败收口", r.body.card?.status === "failed", JSON.stringify(r.body).slice(0, 100));
    r = await j(null, "GET", `/api/agent-cards/${cdpCard}/live/status`);
    ok("驾驶会话记录可查（failed）", r.body.runs?.[0]?.status === "failed", JSON.stringify(r.body).slice(0, 120));
} catch (e) {
    failed++;
    console.error("测试执行异常:", e.message);
} finally {
    try { child?.kill(); } catch { /* 忽略 */ }
    setTimeout(() => {
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
        console.log(`\n结果：通过 ${passed} · 失败 ${failed}`);
        process.exit(failed ? 1 : 0);
    }, 500);
}
