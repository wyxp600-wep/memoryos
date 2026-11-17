#!/usr/bin/env node
/** ★ 2026-10-02 手机版配对：打印手机 App 配对所需完整 URL（局域网 IP + 端口 + 令牌）。
 *  ★ 2026-11-16（M-1 安全加固）：默认改为**一次性配对码**（60 秒、用后即焚）——
 *    二维码/聊天记录里不再出现长期令牌；同时保留 `?token=` 兼容旧客户端（显式标注"勿转发"）。
 *  口径与 dashboard.js CLI 一致：库 = MEMORY_DB ?? %APPDATA%\MemoryOS\data\memory.db，
 *    令牌在其同目录 token 文件；端口优先 argv → MEMORY_PORT → data/core.json。
 *  用法：node dist/pair-url.mjs [端口，默认取 core.json 或 8787] */
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";

const dbPath = process.env.MEMORY_DB ?? path.join(process.env.APPDATA ?? "", "MemoryOS", "data", "memory.db");
const dataDir = process.env.MEMORYOS_DATA_DIR || path.dirname(path.dirname(dbPath));
let token = process.env.MEMORY_TOKEN ?? "";
if (!token) {
    try { token = readFileSync(path.join(path.dirname(dbPath), "token"), "utf8").trim(); } catch { /* 首启尚未生成 */ }
}
let port = String(process.argv[2] ?? process.env.MEMORY_PORT ?? "");
if (!port) {
    try { port = String(JSON.parse(readFileSync(path.join(dataDir, "core.json"), "utf8")).port ?? ""); } catch { /* 未启动过内核 */ }
}
port = port || "8787";

const ips = [];
for (const list of Object.values(networkInterfaces()))
    for (const ni of list ?? [])
        if (ni.family === "IPv4" && !ni.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address))
            ips.push(ni.address);

/** 向本机内核申请一次性配对码（需令牌；失败返回 null → 回退旧口径） */
async function makePairCode() {
    if (!token)
        return null;
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/pair/code`, {
            method: "POST",
            headers: { "x-memory-token": token },
            signal: AbortSignal.timeout(3000),
        });
        if (!r.ok)
            return null;
        const j = await r.json();
        return j?.code ? { code: String(j.code), expiresIn: Number(j.expiresIn) || 60 } : null;
    }
    catch {
        return null;
    }
}

console.log("── MemoryOS 手机配对 ──");
if (!ips.length) {
    console.log("⚠ 未发现局域网 IPv4（WiFi/网线未连？）");
} else if (!token) {
    console.log(`⚠ 未找到令牌（${path.join(path.dirname(dbPath), "token")}）——先启动一次内核生成后再跑本脚本`);
} else {
    const pair = await makePairCode();
    if (pair) {
        console.log(`推荐（**手机浏览器**打开，一次性码 ${pair.expiresIn} 秒内有效、打开即失效）：`);
        for (const ip of ips)
            console.log(`  配对地址：http://${ip}:${port}/?pair=${pair.code}`);
        console.log("兼容旧客户端（App 内直接填这个长期令牌地址；含明文令牌，仅本机展示，勿转发）：");
        for (const ip of ips)
            console.log(`  http://${ip}:${port}/?token=${token}`);
    }
    else {
        console.log("⚠ 未能向本机内核申请一次性配对码（内核未运行？），回退为长期令牌地址：");
        for (const ip of ips)
            console.log(`  配对地址：http://${ip}:${port}/?token=${token}`);
    }
    console.log("说明：一次性码只接受浏览器导航（Accept: text/html）；原生 App 请用上方兼容地址。PC 防火墙放行 node.exe（专用网络）。");
}
