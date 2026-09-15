"use strict";
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const { portOpen } = require("./port");

/**
 * 内核进程生命周期服务。
 * deps: { nodeExe, getKernel, dataDir, readConfig, getPort, getToken, isQuitting, log, dialog }
 *       可选注入（仅为可测性，生产不传）：spawnImpl、timers { setTimeout, clearTimeout }
 * 内部持有 coreChildren，暴露 startCore / restartCore / killAll（+ stats 供自愈观测/测试断言）。
 *
 * ★ P2-1（T12）内核自愈：原实现子进程意外退出**只弹框、不重启**（`exit` 回调里仅 dialog），
 *   内核一旦崩就静默变砖，用户必须手动退出应用再启动。本实现补自动重启：
 *   ① 指数退避（base × 2^(n-1)，封顶 maxDelayMs）避免崩溃风暴把 CPU 打满；
 *   ② 每个脚本独立计数 + 独立待重启定时器（同一脚本同一时刻只排一次）；
 *   ③ 健康度过阈值（默认存活 ≥60s）后计数归零——偶发崩溃不累积成"用光重启额度"；
 *   ④ 用尽额度仍失败则弹框告知（保留原有人工介入路径，不无限重启）；
 *   ⑤ 退出流程（isQuitting）不重启；restartCore/killAll 会清掉待重启定时器。
 * 关闭自愈：CORE_SELFHEAL=0（调试期避免反复拉起）。
 */
function createCore(deps) {
  const {
    nodeExe, getKernel, dataDir, readConfig, getPort, getToken, isQuitting, log, dialog,
    spawnImpl = spawn,
    timers = { setTimeout, clearTimeout },
  } = deps;

  const envInt = (k, d) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  const SELFHEAL = process.env.CORE_SELFHEAL !== "0";
  const MAX_RESTARTS = envInt("CORE_MAX_RESTARTS", 5);         // 每个脚本的最大自动重启次数
  const BASE_DELAY_MS = envInt("CORE_RESTART_BASE_MS", 3000);  // 首次退避
  const MAX_DELAY_MS = envInt("CORE_RESTART_MAX_MS", 60000);   // 退避封顶
  const HEALTHY_MS = envInt("CORE_HEALTHY_MS", 60000);         // 存活超过此时长视为健康 → 计数归零

  let coreChildren = [];
  /** script → { count, timer, startedAt, stopped } */
  const book = new Map();
  const entryOf = (script) => {
    if (!book.has(script)) book.set(script, { count: 0, timer: null, startedAt: 0 });
    return book.get(script);
  };
  const backoffOf = (n) => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.max(0, n - 1)));

  function spawnCore(script, extraEnv) {
    const KERNEL = getKernel();
    const child = spawnImpl(nodeExe(), [path.join(KERNEL, "dist", script)], {
      cwd: KERNEL,
      env: {
        ...process.env,
        MEMORY_DB: path.join(dataDir(), "data", "memory.db"),
        MEMORY_PORT: String(getPort()),
        EMBED_MODE: "local",
        EMBED_CACHE_DIR: path.join(KERNEL, "models"),
        MEMORYOS_SERVER: path.join(KERNEL, "dist", "server.js"),
        MEMORY_TOKEN: getToken(),
        ...(extraEnv || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const e = entryOf(script);
    e.startedAt = Date.now();
    e.stopped = false;
    child.stdout.on("data", (d) => log(`[${script}]`, String(d).trimEnd()));
    child.stderr.on("data", (d) => log(`[${script}][err]`, String(d).trimEnd()));
    child.on("exit", (code) => {
      const uptime = Date.now() - e.startedAt;
      log(`${script} 退出（code=${code}，存活 ${Math.round(uptime / 1000)}s）`);
      coreChildren = coreChildren.filter((c) => c !== child);
      if (isQuitting()) return;                       // 正常退出流程：不重启、不弹框
      if (uptime >= HEALTHY_MS) e.count = 0;          // 健康存活过 → 额度重置
      if (!SELFHEAL || !isRestorable(script)) {
        dialog.showMessageBox({
          type: "error", title: "MemoryOS",
          message: `核心服务（${script}）意外退出（code=${code}）。`,
          detail: SELFHEAL ? "该服务不参与自动拉起，请重启应用。" : "自动重启已关闭（CORE_SELFHEAL=0），请手动重启应用。",
        });
        return;
      }
      if (e.count >= MAX_RESTARTS) {
        dialog.showMessageBox({
          type: "error", title: "MemoryOS",
          message: `核心服务（${script}）连续失败 ${e.count} 次，已停止自动重启。`,
          detail: "请查看日志定位原因后重启应用（避免无限重启刷屏）。",
        });
        return;
      }
      e.count += 1;
      const delay = backoffOf(e.count);
      log(`${script} 将在 ${delay}ms 后自动重启（第 ${e.count}/${MAX_RESTARTS} 次）`);
      if (e.timer) timers.clearTimeout(e.timer);       // 同脚本只排一次
      e.timer = timers.setTimeout(() => {
        e.timer = null;
        if (isQuitting()) return;
        log(`${script} 自动重启中…`);
        try { startCore(); } catch (err) { log(`${script} 自动重启失败: ${err.message || err}`); }
      }, delay);
    });
    coreChildren.push(child);
    return child;
  }

  /** 参与自愈的脚本：dashboard 是 HTTP 服务面（崩了必须拉）；daemon 是治理任务（崩了也拉）。 */
  function isRestorable(script) {
    return script === "dashboard.js" || script === "daemon.js";
  }

  function clearTimers() {
    for (const e of book.values()) {
      if (e.timer) { timers.clearTimeout(e.timer); e.timer = null; }
    }
  }

  async function startCore() {
    const cfg = readConfig() || {};
    log(`启动内核（端口 ${getPort()}）…`);
    const llmEnv = {};
    if (cfg.llmUrl) {
      llmEnv.MIMOS_URL = cfg.llmUrl;
      if (cfg.llmModel) llmEnv.INGEST_MODEL = cfg.llmModel;
      if (cfg.llmKey) llmEnv.INGEST_KEY = cfg.llmKey;
    }
    // 受限模式：桌面版默认关闭（MEMORY_RESTRICTED=0）——用户可在「笔记」页自建笔记、
    // 在任务看板建卡。若 config.json 显式写 "restricted": true，则恢复「仅系统采集」。
    llmEnv.MEMORY_RESTRICTED = cfg.restricted === true ? "1" : "0";
    spawnCore("dashboard.js", llmEnv);
    spawnCore("daemon.js", llmEnv);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await new Promise((r) => setTimeout(r, 400));
      if (await portOpen(getPort())) return;          // ← 注意：portOpen(port)，先取值再传（曾误传函数导致 ERR_INVALID_ARG_TYPE）
      if (isQuitting()) throw new Error("启动过程中应用已退出");
    }
    throw new Error("内核 60s 未就绪，请查看日志");
  }

  function restartCore() {
    clearTimers();                                  // 主动重启时作废待执行的自愈
    for (const c of coreChildren) {
      try {
        if (process.platform === "win32") execSync(`taskkill /PID ${c.pid} /T /F`, { stdio: "ignore" });
        else c.kill("SIGTERM");
      } catch { /* 已退出 */ }
    }
    coreChildren = [];
    for (const e of book.values()) e.count = 0;      // 主动重启视为人工复位
    return startCore().then(() => log("内核已重启（热更新生效）"));
  }

  function killAll() {
    clearTimers();
    for (const c of coreChildren) {
      try {
        if (process.platform === "win32") execSync(`taskkill /PID ${c.pid} /T /F`, { stdio: "ignore" });
        else c.kill("SIGTERM");
      } catch { /* 已退出 */ }
    }
    coreChildren = [];
  }

  /** 观测/测试用：当前各脚本的重启计数与是否有待重启定时器 */
  function stats() {
    const out = {};
    for (const [k, v] of book.entries()) out[k] = { restarts: v.count, pending: !!v.timer };
    return { selfHeal: SELFHEAL, maxRestarts: MAX_RESTARTS, baseDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS, scripts: out };
  }

  return { startCore, restartCore, killAll, stats };
}

module.exports = { createCore };
