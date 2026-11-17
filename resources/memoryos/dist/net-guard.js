/**
 * MemoryOS — 出站请求守卫（SSRF 收敛）
 *
 * 背景（2026-11-16 安全审计 M-7）：`/api/config/test-llm` 与 `/api/agent-models`
 * 会把**请求方给的 URL** 交给服务端 fetch。持令牌者因此可借服务端探测内网/云元数据
 * （169.254.169.254 等）。本模块只做"目标地址分类"，不改任何请求内容。
 *
 * 口径：
 *  - 只允许 http/https（其他协议一律拒）；
 *  - 环回地址放行（本地 LLM/Ollama 是核心用例：127.0.0.1/localhost/::1）；
 *  - 链路本地与云元数据 IP 一律拒；
 *  - RFC1918 私网地址默认拒；确需访问内网模型服务时显式 MEMORYOS_ALLOW_PRIVATE_EGRESS=1；
 *  - 其余公网地址放行。
 *
 * 边界如实声明：本守卫做**字面地址**判定，不做 DNS 解析后的二次校验（DNS rebinding 场景
 * 仍可能绕过）。彻底防 rebinding 需在连接层固定解析结果，属后续批次。
 */

const META_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "169.254.169.254",
  "100.100.100.200",
]);

const LOOPBACK_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;
const PRIVATE_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/i;
const LINK_LOCAL_RE = /^(169\.254\.\d{1,3}\.\d{1,3}|fe80:|\[fe80:)/i;
/** ★ 2026-11-16（复审）：IPv6 唯一本地地址 fc00::/7（fc/fd 开头）同样属于私网，必须与 RFC1918 同口径。 */
const ULA_RE = /^(fc|fd)[0-9a-f]{2}:/i;

function allowPrivate() {
  return process.env.MEMORYOS_ALLOW_PRIVATE_EGRESS === "1";
}

/**
 * 校验出站 URL。通过返回 { ok:true, url }；不通过返回 { ok:false, error }。
 * @param {string} raw 用户提供的 URL
 */
export function checkEgressUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, error: "URL 无法解析" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { ok: false, error: `不支持的协议 ${u.protocol}（仅 http/https）` };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host)
    return { ok: false, error: "URL 缺少主机名" };
  if (META_HOSTS.has(host.toLowerCase()))
    return { ok: false, error: "目标地址属于云元数据端点，已拒绝" };
  if (LINK_LOCAL_RE.test(host))
    return { ok: false, error: "目标地址属于链路本地地址，已拒绝" };
  if (LOOPBACK_RE.test(host))
    return { ok: true, url: u.href };
  if (PRIVATE_RE.test(host) && !allowPrivate())
    return { ok: false, error: `目标地址属于内网地址（${host}），已拒绝；确需访问请设 MEMORYOS_ALLOW_PRIVATE_EGRESS=1` };
  if (ULA_RE.test(host) && !allowPrivate())
    return { ok: false, error: `目标地址属于 IPv6 唯一本地地址（${host}），已拒绝；确需访问请设 MEMORYOS_ALLOW_PRIVATE_EGRESS=1` };
  return { ok: true, url: u.href };
}
