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
 * 路径安全性守卫（T1）：rel 必须来自清单，拒绝任何越出 root 的取值。
 * 三种弃：含 /.. 段、绝对路径（盘符/UNC/根斜杠）、空串。
 * 返回规范化后的 subpath；不合法则抛错，由调用方 catch 转 error。
 */
function assertSafeRel(rel, root) {
  if (typeof rel !== "string" || rel.length === 0) throw new Error("清单含空 rel");
  if (rel.includes("\\") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) throw new Error("清单 rel 非相对路径: " + rel);
  const norm = path.normalize(rel);
  if (norm === ".." || norm.startsWith(".." + path.sep) || path.isAbsolute(norm)) throw new Error("清单 rel 越界: " + rel);
  const joined = path.resolve(root, norm);
  const rootRes = path.resolve(root) + path.sep;
  if (!joined.startsWith(rootRes)) throw new Error("清单 rel 落点越出内核目录: " + rel);
  return norm;
}

/** 更新源信任（T1）：仅接受 https + 受信主机白名单。建立传输层信任链基线。 */
const TRUSTED_UPDATE_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "mirror.ghproxy.com",
]);
function assertTrustedOrigin(updateUrl) {
  let u;
  try { u = new URL(updateUrl); } catch { throw new Error("更新源不是合法 URL: " + updateUrl); }
  if (u.protocol !== "https:") throw new Error("更新源必须 https: " + updateUrl);
  if (!TRUSTED_UPDATE_HOSTS.has(u.hostname)) throw new Error("更新源不在受信白名单: " + u.hostname);
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
    try { assertTrustedOrigin(updateUrl); }
    catch (e) { log("热更新源未通过信任校验:", e.message); return { status: "disabled", current: readVersion(), error: e.message }; }
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
        const relNorm = assertSafeRel(f.path, getKernel());
        const local = path.join(getKernel(), relNorm);
        if (sha256File(local) !== f.hash) todo.push({ rel: relNorm, hash: f.hash });
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
        const target = path.join(tmp, assertSafeRel(f.rel, tmp));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        downloaded.push({ f, relNorm: assertSafeRel(f.rel, tmp) });
      }
      const bakRoot = path.join(dataDir(), "data", "backup", "hotupdate-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
      const shaLines = [];
      for (const dl of downloaded) {
        const relNorm = assertSafeRel(dl.relNorm, getKernel());
        const dst = path.join(getKernel(), relNorm);
        if (fs.existsSync(dst)) {
          fs.mkdirSync(path.dirname(path.join(bakRoot, relNorm)), { recursive: true });
          fs.copyFileSync(dst, path.join(bakRoot, relNorm));
        }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(tmp, assertSafeRel(dl.relNorm, tmp)), dst);
        const oldSha = sha256File(dst);
        if (oldSha) shaLines.push(oldSha + "  " + relNorm.replace(/\\/g, "/"));
      }
      if (shaLines.length) {
        fs.mkdirSync(bakRoot, { recursive: true });
        fs.writeFileSync(path.join(bakRoot, "manifest.sha256"), shaLines.join("\n") + "\n", "utf8");
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