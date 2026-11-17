/**
 * MemoryOS — 工具错误文案（★ 2026-11-07 #700055）
 *
 * 单一事实源：fastmcp 协议层（parameters['~standard'].validate）与核心 /ops 派发层（safeParse）
 * 都调用本模块，保证「同一个错误，stdio 与 HTTP 两种口气一致」，且错误文案不夹带堆栈/内部文件路径。
 */

/** 把 zod / standard-schema 的 issue 转成中文「参数 X 取值不合法/缺失…」 + 合法取值 + 下一步。 */
export function friendlyParamError(toolName, issues, hint) {
    const list = Array.isArray(issues) ? issues : [];
    const lines = list.length ? list.map(describeIssue) : ["参数校验未通过，未执行"];
    const next = hint ?? `下一步：按工具说明修正以上参数后重试；不确定时调用 tool_guide(name=${toolName}) 查看参数示例。`;
    return lines.join("\n") + "\n" + next;
}

/** 中文描述单条 issue；覆盖枚举、类型、必填、范围、数组长度等常见 code，未知 code 回退到中文通名。
 *  例外：业务自定义校验（如六字段模板）给出的中文提示逐字保留 —— 那批文案已验收，不得改写。 */
function describeIssue(issue) {
    if (issue?.code === "custom" && typeof issue.message === "string" && /[一-龥]/.test(issue.message))
        return sanitizeMessage(issue.message);
    const path = Array.isArray(issue?.path) ? issue.path.map(String).join(".") : "";
    const field = path || "参数";
    const val = issue?.received ?? issue?.input; // ★ 2026-11-16（R02-06）：zod 4 用 input，zod 3 用 received
    const quoted = val === undefined ? "未传" : `你传的是 ${formatValue(val)}`;
    // ★ 2026-11-16（R02-06）：zod 4 把枚举错误码改为 invalid_value，合法取值放 values（zod 3 是 invalid_enum_value/options）
    const enumOpts = issue?.options ?? issue?.values;
    if (issue?.code === "invalid_enum_value" || issue?.code === "invalid_value" || (Array.isArray(enumOpts) && enumOpts.length)) {
        const opts = (enumOpts ?? []).map(String).join(" / ");
        return opts
            ? `参数 ${field} 取值不合法：只接受 ${opts}，${quoted}`
            : `参数 ${field} 取值不合法：${quoted}`;
    }
    if (issue?.code === "invalid_type" && val === undefined) {
        const expected = issue.expected;
        return expected
            ? `参数 ${field} 必填，${quoted}（需要 ${String(expected)}）`
            : `参数 ${field} 必填，${quoted}`;
    }
    if (issue?.code === "invalid_type") {
        return `参数 ${field} 类型不对：需要 ${String(issue.expected ?? "正确类型")}，${quoted}`;
    }
    const codeText = {
        too_small: "取值太小或长度不足",
        too_big: "取值太大或长度超限",
        invalid_string: "字符串格式不符合要求",
        unrecognized_keys: "出现了工具不支持的参数",
        invalid_union: "取值不符合任何允许的形态",
        custom: "取值不符合工具约束",
    }[issue?.code] ?? "取值不符合工具约束";
    return `参数 ${field} ${codeText}：${quoted}`;
}

function formatValue(v) {
    if (v === null) return "null";
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
    if (Array.isArray(v)) return "数组 " + JSON.stringify(v).slice(0, 120);
    if (typeof v === "object") return "对象 " + JSON.stringify(v).slice(0, 120);
    return String(v);
}

/** 工具执行期异常 → 结构化中文文本；只有真锁竞争才建议重试。
 *  中文业务错误（含已验收的六字段提示）逐字保留正文，只补一行下一步，不套「执行失败」模板。 */
export function friendlyExecutionError(toolName, err) {
    const raw = err instanceof Error ? err.message : String(err ?? "");
    const msg = sanitizeMessage(raw);
    const busy = /SQLITE_BUSY|database is locked|database table is locked/i.test(msg);
    const hint = busy
        ? "下一步：这是 SQLite 锁竞争，稍等片刻用相同参数重试一次；仍失败再检查是否有其他内核进程在写库。"
        : "下一步：按提示修正后重试；不要盲目重复调用。仍失败请调用 tool_guide(name=工具名) 查看用法。";
    if (/[一-龥]/.test(msg))
        return `${msg}\n${hint}`;
    return `⚠ ${toolName} 执行失败：${msg}\n（异常已捕获，会话未中断。）\n${hint}`;
}

/** 依赖任务号的工具缺 task_id —— 只给相关的下一步，不夹带锁竞争或泛化建议。 */
export function missingTaskIdError(toolName) {
    const next = toolName === "task_claim"
        ? "下一步：先用 task_next 查可做集拿到任务编号，再带 task_id 调 task_claim。"
        : `下一步：带 task_id（地图上的任务号）重新调用 ${toolName}；编号由 task_next 或认领回执取得。`;
    return `缺少 task_id：${toolName} 必须指定任务编号才能工作。\n${next}`;
}

/** 保留多行业务文案（如六字段校验提示），只剔除堆栈帧并脱敏本机路径。 */
function sanitizeMessage(raw) {
    const lines = String(raw ?? "").split(/\r?\n/)
        .filter((line) => !/^\s*at\s+\S/.test(line)) // V8 堆栈帧
        .map((line) => line
            .replace(/^(?:MCP error -?\d+:\s*|[A-Za-z]+Error:\s*)/, "")
            .replace(/file:\/\/\/[^\s"')]+/g, "[路径]")
            .replace(/[A-Za-z]:\\[^\s"')]+/g, "[路径]")
            // ★ #700055 第 6 条：相对的内部实现路径（代码文件名 + 行号，如 resources/.../foo.js:12）同样脱敏；
            //   判据是「代码扩展名 + :行号」，故 business 路径（outputs/2026-11-07/...、含 .mjs 但无行号）逐字保留。
            .replace(/(?:\.{0,2}\/)?(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts):\d+(?::\d+)?/g, "[内部位置]")
            // 只脱敏绝对路径；六字段模板里的相对路径（outputs/...）逐字保留
            .replace(/(?:\/(?:Users|home|tmp|var|private|etc|opt)\/[^\s"')]+)+/g, "[路径]"));
    const s = lines.join("\n").trim();
    return s || "工具执行时发生未知错误";
}
