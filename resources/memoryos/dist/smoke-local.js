import { openDb, writeMemory } from "./db.js";
import { hybridSearch } from "./search.js";
import { getEmbedder, embedMode } from "./embed.js";
let PASS = 0, FAIL = 0;
const ok = (n, cond, extra = "") => {
    if (cond) {
        PASS++;
        console.log(`  ✅ ${n}${extra ? "  " + extra : ""}`);
    }
    else {
        FAIL++;
        console.error(`  ❌ ${n}${extra ? "  " + extra : ""}`);
    }
};
if (embedMode() !== "local") {
    console.error("需要 EMBED_MODE=local（BGE-M3）才跑本冒烟，当前=" + embedMode());
    process.exit(1);
}
const emb = await getEmbedder();
ok("L1 加载本地模型", emb.mode === "local" && emb.dim > 0, `mode=${emb.mode} dim=${emb.dim}`);
const db = openDb(":memory:");
const w = async (content, type = "experience") => writeMemory(db, { content, type, agent: "local-smoke", agent_fpath: null, project: "global", embedding: (await emb.embedTexts([content]))[0] });
const S = [
    "数据库连接超时：检查连接池与网络防火墙配置",
    "时间戳容差设为 5 分钟以容忍时钟漂移",
    "端口 80 常被 IIS 占用，先查 W3SVC 服务状态",
];
for (const s of S)
    await w(s);
for (const [q, targetIdx, label] of [
    ["网络不通导致连接慢，怎么排查", 0, "数据库连接→网络排查"],
    ["时钟不同步引起的校验失败", 1, "时间戳容差→时钟漂移"],
    ["W3SVC 服务占用端口 80", 2, "占用80→W3SVC"],
]) {
    const hits = await hybridSearch(db, emb, { query: q, project: "global", limit: 5 });
    const topContent = hits[0]?.content ?? "";
    const hit = hits.some((h) => h.content === S[targetIdx]);
    ok(`L2 跨表述语义命中「${label}」`, hit, `topIdx=${S.indexOf(topContent)} score=${hits[0]?.score.toFixed(4)}`);
}
// 语义排序应优于随机：命中条出现在前 40%
const [q2, t2] = ["网络不通连接慢", 0];
const hits2 = await hybridSearch(db, emb, { query: q2, project: "global", limit: 5 });
const pos = hits2.findIndex((h) => h.content === S[t2]);
ok("L3 目标条在前40%（语义排序有效）", pos >= 0 && pos <= Math.ceil(hits2.length * 0.4) - 1, `pos=${pos}`);
db.close();
console.log(`\n[smoke-local] PASS=${PASS} FAIL=${FAIL}`);
process.exit(FAIL > 0 ? 1 : 0);
