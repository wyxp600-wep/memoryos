// E2E test: exercise the exact schema-conversion + MCP stdio flow the pi extension uses
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
// 可移植化（20261005）：typebox 优先从项目内 node_modules 解析，回退 pi-coding-agent 全局安装；server.js 按 import.meta.url 相对定位，换机器不再断
import { fileURLToPath } from "node:url";
import path from "node:path";
import { statSync } from "node:fs";
const SERVER_PATH = fileURLToPath(new URL("./resources/memoryos/dist/server.js", import.meta.url));
function resolveTypebox() {
	const candidates = [
		fileURLToPath(new URL("./resources/memoryos/node_modules/@sinclair/typebox/build/index.mjs", import.meta.url)),
		fileURLToPath(new URL("./node_modules/@sinclair/typebox/build/index.mjs", import.meta.url)),
		"C:/Users/WYX/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs",
	];
	for (const c of candidates) { try { statSync(c); return c; } catch { /* 下一个 */ } }
	throw new Error("typebox 不可达：请先在 resources/memoryos 下 npm install，或安装 pi-coding-agent");
}
const TypeMod = await import(pathToFileURL(resolveTypebox()).href);
const Type = TypeMod.Type;

// --- copy of jsonSchemaToTypeBox from mcp.ts (must stay in sync) ---
function jsonSchemaToTypeBox(schema) {
	if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return Type.Any();
	if (Array.isArray(schema.anyOf)) {
		const mapped = schema.anyOf.map(jsonSchemaToTypeBox);
		if (mapped.length === 0) return Type.Any();
		return Type.Union(mapped);
	}
	if (Array.isArray(schema.oneOf)) {
		const mapped = schema.oneOf.map(jsonSchemaToTypeBox);
		if (mapped.length === 0) return Type.Any();
		return Type.Union(mapped);
	}
	if (Array.isArray(schema.allOf)) {
		const mapped = schema.allOf.map(jsonSchemaToTypeBox);
		if (mapped.length <= 1) return mapped[0] ?? Type.Any();
		return Type.Intersect(mapped);
	}
	if (Array.isArray(schema.enum)) {
		const lits = schema.enum.map((v) =>
			typeof v === "string" ? Type.Literal(v) : typeof v === "number" ? Type.Literal(v) : Type.Literal(String(v)),
		);
		return lits.length === 1 ? lits[0] : Type.Union(lits);
	}
	const type = schema.type;
	switch (type) {
		case "object": {
			const props = {};
			for (const [k, v] of Object.entries(schema.properties ?? {})) {
				let t = jsonSchemaToTypeBox(v);
				if (!Array.isArray(schema.required) || !schema.required.includes(k)) t = Type.Optional(t);
				props[k] = t;
			}
			return Type.Object(props, {
				description: schema.description,
				additionalProperties: schema.additionalProperties === false ? false : undefined,
			});
		}
		case "string":
			return Type.String({ description: schema.description, minLength: schema.minLength, maxLength: schema.maxLength, pattern: schema.pattern });
		case "integer":
			return Type.Integer({ description: schema.description, minimum: schema.minimum, maximum: schema.maximum });
		case "number":
			return Type.Number({ description: schema.description, minimum: schema.minimum, maximum: schema.maximum });
		case "boolean":
			return Type.Boolean({ description: schema.description });
		case "array":
			return Type.Array(jsonSchemaToTypeBox(schema.items), { description: schema.description, minItems: schema.minItems, maxItems: schema.maxItems });
		default:
			return Type.Any();
	}
}
// --- end copy ---

const proc = spawn("node", [SERVER_PATH], {
	env: { ...process.env, EMBED_MODE: "local" },
	stdio: ["pipe", "pipe", "inherit"],
});
let buf = "";
const pending = new Map();
let nextId = 1;
proc.stdout.on("data", (d) => {
	buf += d.toString();
	let idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (!line.startsWith("{")) continue;
		try {
			const msg = JSON.parse(line);
			if (msg.id && pending.has(msg.id)) {
				const { resolve, reject } = pending.get(msg.id);
				pending.delete(msg.id);
				msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
			}
		} catch {
			/* notification */
		}
	}
});
function rpc(method, params, timeoutMs = 30000) {
	const id = nextId++;
	const p = new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`timeout ${method}`));
			}
		}, timeoutMs);
	});
	proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	return p;
}

const t0 = Date.now();
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-test", version: "1.0.0" } });
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const listed = await rpc("tools/list", {});
console.log(`tools/list ok: ${listed.tools.length} tools`);

let converted = 0;
for (const tool of listed.tools) {
	jsonSchemaToTypeBox(tool.inputSchema ?? {});
	converted++;
}
console.log(`schema conversion ok: ${converted}/${listed.tools.length}`);
console.log("tool names:", listed.tools.map((t) => t.name).join(", "));

// call a light tool to verify tools/call round-trip
const pick = listed.tools.find((t) => /status|stats|health/i.test(t.name)) ?? listed.tools[0];
console.log("calling:", pick.name, JSON.stringify(pick.inputSchema?.properties ?? {}).slice(0, 200));
const called = await rpc("tools/call", { name: pick.name, arguments: {} }, 60000);
console.log("tools/call ok:", JSON.stringify(called.content ?? called).slice(0, 400), "isError:", called.isError);
console.log(`total ${Date.now() - t0}ms`);
proc.kill();
process.exit(0);
