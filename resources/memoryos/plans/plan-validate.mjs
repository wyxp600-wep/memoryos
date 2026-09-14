#!/usr/bin/env node
/**
 * MemoryOS plan 校验器 — 零依赖 JSON Schema 子集实现（v1.1.0）
 * 用法：
 *   node plan-validate.mjs <plan.json> [--strict]
 *   node plan-validate.mjs --schema            仅自检 schema 可加载
 * 支持的 schema 关键字：type / required / properties / items / $ref / enum /
 *   const / minimum / maximum / minLength / maxLength / minItems / additionalProperties
 * 职责范围：JSON 结构合法性 + 计划级/任务级一致性 + 状态机 + 自检清单。
 * 说明：完整 jsonschema.json 由外部工具做；本脚本保证「机器可读性」底线，零依赖。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "plan.schema.json");

// ---------- 极简 jsonschema 子集校验 ----------
const F64 = new Set(["$schema", "$id", "title", "description"]);
function errAt(path, msg) { return `${path}: ${msg}`; }

function checkSchema(value, schema, path, r, defs) {
  if (!schema || typeof schema !== "object") return r;
  // $ref
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//, "");
    const def = defs[name];
    if (def) checkSchema(value, def, path, r, defs);
    else r.push(errAt(path, `未知 $ref: ${schema.$ref}`));
    return r;
  }
  // type
  const t = schema.type;
  if (t) {
    const ok = Array.isArray(t)
      ? t.some(tt => (typeof value === tt)
        || (tt === "null" && value === null) // null 显式允许
        || (tt === "array" && Array.isArray(value))
        || (tt === "object" && typeof value === "object" && value !== null && !Array.isArray(value))
        || (tt === "integer" && Number.isInteger(value)))
      : (t === "integer" ? Number.isInteger(value)
        : (t === "number" ? typeof value === "number"
          : (t === "array" ? Array.isArray(value)
            : (t === "object" ? (typeof value === "object" && value !== null && !Array.isArray(value))
              : (t === "string" ? typeof value === "string"
                : (t === "boolean" ? typeof value === "boolean"
                  : t === "null" ? value === null : true))))));
    if (!ok) { r.push(errAt(path, `应为 ${JSON.stringify(t)}，实为 ${typeof value}`)); return r; }
  }
  if (value === null || value === undefined) return r; // nullable 由 type 数组容错
  // enum/const
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value)))
    r.push(errAt(path, `不在枚举内: ${JSON.stringify(value)}`));
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value))
    r.push(errAt(path, `须等于 ${JSON.stringify(schema.const)}`));
  // number 边界
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) r.push(errAt(path, `< minimum ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) r.push(errAt(path, `> maximum ${schema.maximum}`));
  }
  // string 长度
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) r.push(errAt(path, `< minLength ${schema.minLength}`));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) r.push(errAt(path, `> maxLength ${schema.maxLength}`));
  }
  // array items
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) r.push(errAt(path, `< minItems ${schema.minItems}`));
    if (schema.items) {
      // 单个 items schema 或 $ref
      value.forEach((item, i) => checkSchema(item, schema.items, `${path}[${i}]`, r, defs));
    }
  }
  // object properties / required
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (schema.required) {
      for (const k of schema.required) if (!(k in value)) r.push(errAt(path, `缺必填字段 ${k}`));
    }
    if (schema.properties) {
      const allowed = new Set([...Object.keys(schema.properties), ...(schema.required || [])]);
      for (const k of Object.keys(schema.properties)) {
        if (k in value) checkSchema(value[k], schema.properties[k], path ? `${path}.${k}` : k, r, defs);
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) if (!allowed.has(k)) r.push(errAt(path, `多余字段 ${k}`));
      }
    }
  }
  return r;
}

// ---------- 一致性 & 状态机语义校验（schema 之外的硬规则） ----------
function semanticCheck(plan, r) {
  const p = (msg) => r.push(`[rule] ${msg}`);
  const tasks = plan.tasks || [];
  const byId = {}; tasks.forEach(t => byId[t.id] = t);

  // 0. 状态机迁移白名单（来自 schema 顶层 status_transitions）——audit_log 的 from→to 必须合法
  let transitions = {};
  try {
    const sch = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    transitions = sch.properties?.status_transitions?.const ?? {};
  } catch { /* 读不到则跳过迁移校验 */ }
  if (Object.keys(transitions).length && Array.isArray(plan.audit_log)) {
    for (const ev of plan.audit_log) {
      if (ev.action !== "task.status_changed") continue;
      if (ev.from === undefined || ev.to === undefined) continue;
      if (ev.target && !byId[ev.target] && !ev.target.startsWith("plan")) {
        p(`audit ${ev.action} 指向未知任务 ${ev.target}`);
        continue;
      }
      const allowed = transitions[ev.from];
      if (allowed && !allowed.includes(ev.to)) {
        p(`非法状态迁移: ${ev.target} ${ev.from} → ${ev.to}（白名单: ${(allowed.join(", ") || "终态无迁移")}）`);
      }
    }
  }

  // 1. 依赖无环、无悬空
  const seen = new Set();
  const visit = (id, stack) => {
    if (stack.has(id)) { p(`依赖成环: ${[...stack, id].join(" -> ")}`); return; }
    if (seen.has(id)) return; seen.add(id);
    const deps = plan.dependencies?.[id] || [];
    for (const d of deps) { if (!byId[d]) { p(`任务 ${id} 依赖悬空 → ${d}`); continue; } visit(d, new Set(stack).add(id)); }
  };
  Object.keys(plan.dependencies || {}).forEach(id => visit(id, new Set()));

  // 2. done 前置条件
  for (const t of tasks) {
    if (t.status === "done") {
      if (t.progress?.percent !== 100) p(`任务 ${t.id} done 但 progress≠100`);
      if (t.acceptance_criteria?.some(a => !a.verified)) p(`任务 ${t.id} done 但存在未 verified 的 criteria`);
      if (t.blockers?.some(b => b.status === "open")) p(`任务 ${t.id} done 但存在 open blocker`);
      if (t.review?.required === true && t.review?.status !== "approved") p(`任务 ${t.id} done 但 review 未 approved`);
      if (!(t.attempts?.length || t.acceptance_criteria?.some(a => a.evidence_refs?.length))) p(`任务 ${t.id} done 但无验收证据`);
    }
    if (t.status === "cancelled" && !t.cancel_reason) p(`任务 ${t.id} cancelled 但缺 cancel_reason`);
    if (t.status === "blocked" && !(t.blockers || []).some(b => b.status === "open")) p(`任务 ${t.id} blocked 但无 open blocker`);
  }

  // 3. 计划状态一致性
  if (plan.plan_status === "completed") {
    const notTerminal = tasks.filter(t => !["done", "cancelled"].includes(t.status));
    if (notTerminal.length) p(`plan completed 但存在非终态任务: ${notTerminal.map(t => t.id).join(",")}`);
    if (tasks.some(t => t.blockers?.some(b => b.status === "open"))) p("plan completed 但存在 open blocker");
  }
  if (plan.plan_status === "paused") {
    const valid = ["wait_user", "replan", "wait_dependency", "review"];
    if (!valid.includes(plan.handoff?.next_action)) p(`plan paused 但 handoff.next_action=${plan.handoff?.next_action} 非法`);
  }

  // 4. next_checkpoint 可机读性
  if (plan.next_checkpoint?.triggers && !plan.next_checkpoint.triggers.length) p("next_checkpoint.triggers 为空数组");

  // 5. progress 一致性（有 steps 时）
  for (const t of tasks) {
    if (Array.isArray(t.steps) && t.steps.length) {
      const done = t.steps.filter(s => s.status === "done").length;
      if (t.progress?.done_steps !== done) p(`任务 ${t.id} progress.done_steps(${t.progress?.done_steps}) ≠ 实际 done steps(${done})`);
    }
  }

  // 6. handoff resume_hint ≤2 句
  if (plan.handoff?.resume_hint) {
    const sentences = plan.handoff.resume_hint.split(/[。；;.!?]/).filter(s => s.trim()).length;
    if (sentences > 2) p("handoff.resume_hint 超过 2 句");
  }

  // 7. 任务数
  if (tasks.length > 15) p(`单计划任务数 ${tasks.length} > 15，应拆子计划`);
}

// ---------- 入口 ----------
function main() {
  const args = process.argv.slice(2);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

  if (args.includes("--schema")) {
    // 自检：schema 应能被 JSON.parse 且 {const:"1.1.0"} / required 数组存在；结构深度错误会在此抛异常
    const v = schema.schema_version;
    if (v !== "1.1.0") { console.error("schema version 异常:", v); process.exit(1); }
    if (!schema.$defs?.task || !schema.$defs?.artifact) { console.error("schema 缺 $defs.task/artifact"); process.exit(1); }
    if (!Array.isArray(schema.required)) { console.error("schema.required 非数组"); process.exit(1); }
    console.log("schema ok: plan.schema.json (v" + v + "), required=" + schema.required.join(","));
    process.exit(0);
  }

  const target = args.find(a => !a.startsWith("--"));
  if (!target) { console.error("用法: node plan-validate.mjs <plan.json> [--strict]"); process.exit(2); }
  if (!existsSync(target)) { console.error("文件不存在:", target); process.exit(2); }

  const plan = JSON.parse(readFileSync(target, "utf8")); // 解析失败直接抛（UTF-8 无 BOM 前提）
  const errors = [];
  checkSchema(plan, schema, "$", errors, schema.$defs);
  semanticCheck(plan, errors);

  if (errors.length) {
    console.error(`${target}\n  校验失败 ${errors.length} 项:`);
    errors.forEach(e => console.error("  -", e));
    process.exit(1);
  }
  console.log(`✓ ${target} 校验通过 (${plan.plan_id}, schema ${plan.schema_version}, status=${plan.plan_status}, tasks=${plan.tasks.length})`);
}

main();