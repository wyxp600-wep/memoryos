"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createHash } = require("node:crypto");

/* ---------- HTTP 封装 ---------- */
async function fetchJson(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
async function fetchBuffer(url, timeout = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

/* ---------- sha256 ---------- */
function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function sha256File(p) {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 内核自研增量热更新。依赖经 deps 注入，避免模块间循环 require。
 * deps: { readConfig, readReleaseSettings, readVersion, getKernel, dataDir, restartCore, log }
 * 返回纯结果（{status,current,latest,applied,error?}），UI 弹窗由调用方处理。
 */
function makeUpdater(deps) {
  const { readConfig, readReleaseSettings, readVersion, getKernel, dataDir, restartCore, log } = deps;

  /** 更新内核 version.json 为 latest */
  function updateLocalVersion(latest) {
    try {
      const p = path.join(getKernel(), "version.json");
      const v = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
      v.version = latest;
      v.updated = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
    } catch { /* ignore */ }
  }

  /** 执行一次内核热更新。status ∈ done / none / error / disabled */
  async function applyKernelUpdate() {
    const cfg = readConfig() || {};
    const updateUrl = cfg.updateUrl || readReleaseSettings().updateUrl;
    if (!updateUrl) return { status: "disabled" };
    const current = readVersion();
    try {
      const meta = await fetchJson(updateUrl);
      const latest = String(meta.version || "");
      if (!latest || latest === current) return { status: "none", current };
      const base = new URL(".", updateUrl).toString();
      const manifest = await fetchJson(new URL(meta.manifest || "new/filelist.json", base).toString());
      if (!manifest.files || !manifest.files.length) throw new Error("清单为空");
      log(`热更新 ${current} → ${latest}（${manifest.files.length} 个文件）`);
      const todo = [];
      for (const f of manifest.files) {
        const local = path.join(getKernel(), f.path);
        if (sha256File(local) !== f.hash) todo.push({ rel: f.path, hash: f.hash });
      }
      if (!todo.length) {
        updateLocalVersion(latest);
        log("热更新：无文件差异，仅版本号更新");
        return { status: "applied", current, latest, applied: 0 };
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-hotup-"));
      const downloaded = [];
      for (const f of todo) {
        const buf = await fetchBuffer(new URL(f.rel, new URL("new/", base).toString()).toString());
        if (sha256Buf(buf) !== f.hash) throw new Error(`hash 不匹配: ${f.rel}`);
        const target = path.join(tmp, ...f.rel.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        downloaded.push(f);
      }
      const bakRoot = path.join(dataDir(), "data", "backup", "hotupdate-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
      for (const f of downloaded) {
        const dst = path.join(getKernel(), f.rel);
        if (fs.existsSync(dst)) {
          fs.mkdirSync(path.dirname(path.join(bakRoot, f.rel)), { recursive: true });
          fs.copyFileSync(dst, path.join(bakRoot, f.rel));
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(tmp, ...f.rel.split("/")), dst);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      updateLocalVersion(latest);
      log(`热更新完成：${todo.length} 个文件覆盖，旧版备份 → ${bakRoot}`);
      return { status: "applied", current, latest, applied: todo.length };
    } catch (e) {
      return { status: "error", current, error: String(e.message || e) };
    }
  }

  /** 自动热更新（后台静默）：发现新版→应用→有文件变更则重启内核 */
  async function runAutoHotUpdate() {
    if (global.__hotupdating) return;
    global.__hotupdating = true;
    try {
      const r = await applyKernelUpdate();
      if (r.status === "applied") {
        log(`自动热更新：${r.current} → ${r.latest}（${r.applied} 文件）`);
        if (r.applied > 0) {
          try { await restartCore(); } catch { /* 重启失败不影响 */ }
        }
      } else if (r.status === "error") {
        log(`自动热更新失败：${r.error}`);
      }
    } finally {
      global.__hotupdating = false;
    }
  }

  /** 启动自调度：启动 delay 后首查 + interval 周期。默认 20s / 30min */
  function auto({ delayMs = 20 * 1000, intervalMs = 30 * 60 * 1000 } = {}) {
    setTimeout(runAutoHotUpdate, delayMs);
    setInterval(runAutoHotUpdate, intervalMs);
  }

  return { applyKernelUpdate, runAutoHotUpdate, auto };
}

module.exports = { makeUpdater, sha256File, sha256Buf };