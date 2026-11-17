/** 智能体新写入统一六字段换行格式；历史正文不迁移。 */
import { z } from 'zod';
import { keywordErrors, keywordValidationSQL } from './memory-keywords.js';
import { BODY_FIELDS, memoryFields, bodyCTE } from './memory-fields.js';
/** ★ 2026-11-03（第一批① P0）：原模板用全角〔〕占位符，照抄必被校验拒绝；改为「填好真实内容的样例」——
 *  照抄可直接提交成功，使用者只需把每段内容替换成自己的结论。 */
export const MEMORY_BODY_TEMPLATE = '结论：\n在 Windows 桌面版 MemoryOS 中，把计划任务的启动方式从 powershell 改为 wscript 零窗口脚本，可以消除每 5 分钟一次的窗口闪烁。\n\n关键词：\nWindows 计划任务；wscript；窗口闪烁\n\n适用范围：\nWindows 桌面版 MemoryOS 的自启与保活任务；Linux、Termux 不适用。\n\n依据：\n任务动作原为 powershell.exe 调 check-proxy.bat，50ms 轮询抓到每 5 分钟新建 conhost.exe；改为 wscript.exe //B 后同一轮询 0 次新进程。复现脚本在 outputs/2026-11-03/mcp-tools-spec/work/ 下。\n\n行动：\n先检查任务动作是否为 powershell 或 cmd；是则改为 wscript 零窗口脚本；若改动后仍出现新窗口，立即回滚旧动作并停止上线。\n\n状态：\n已验证，最后核验日期：2026-10-30。';
export const MEMORY_BODY_GUIDE = '所有智能体新增及修订知识记忆统一六字段：结论、关键词、适用范围、依据、行动、状态。字段名单独一行，内容下一行，各字段空一行；关键词3～5个具体组件名、错误码或症状，分号分隔，总长≤160字，每词≤80字且不重复。每条一个可复用判断；明确项目、版本、环境、触发条件和例外，不把一次失败推广为永久不可用。依据须有可回查的日志或代码位置、复现步骤及预期与实际结果，不能只写已测试通过；行动须包含先检查什么、满足何条件再执行及异常停止条件。进度与下一步放任务检查点。状态为待验证/已验证/已替代，缺证据标待验证，最后核验日期只填实际检查日期，不编造。历史五字段仅兼容读取；新写入与正文修订不合格式会拒绝；任务卡、人工内容及原始笔记导入保留各自格式。';
const TASK_HEAD = /^\[task\]\[assignee:[^\]]*\]\[status:/;
/** ★ 2026-11-05（第6步③）：正文长度上限 —— 明确拒绝并报当前字数，不静默截断。
 *  单选 6000：现有六字段条目实测 P99 约 1200 字，6000 足以容纳长依据；再长应拆条（一条一个可复用判断）。 */
export const MEMORY_BODY_MAX_CHARS = 6000;
export function isStructuredMemoryBody(content) { return /^结论[：:]/.test(String(content).replace(/\*\*/g,'').trim()); }
export function memoryBodyErrors(content, { allowTask = false } = {}) {
    if(typeof content!=='string') return ['正文必须为字符串'];
    if(content.length>MEMORY_BODY_MAX_CHARS) return [`正文过长：当前 ${content.length} 字，上限 ${MEMORY_BODY_MAX_CHARS} 字（未写入，也未截断）。请拆成多条，每条约一个可复用判断。`];
    if(allowTask&&TASK_HEAD.test(content))return [];
    const fields=memoryFields(content), errors=[];
    // ★ 2026-11-03（第一批①）：报错点名「第几个字段 + 什么问题」，不再笼统一句「不能为空或占位符」。
    const pos=(name)=>{const i=BODY_FIELDS.indexOf(name);return i>=0?`第${i+1}个字段「${name}」`:`字段「${name}」`;};
    const names=fields.map(f=>f.name);
    if(names.join('|')!==BODY_FIELDS.join('|')){
        let i=0;while(i<BODY_FIELDS.length&&names[i]===BODY_FIELDS[i])i++;
        const want=BODY_FIELDS[i]??BODY_FIELDS[BODY_FIELDS.length-1];
        const got=names[i]?`「${names[i]}」`:'（该字段缺失）';
        return [`第${Math.min(i+1,BODY_FIELDS.length)}个字段应为「${want}」，实际是${got}；六个字段须按此顺序各出现一次`];
    }
    if(fields[0].index!==0)errors.push(`${pos('结论')}：正文须从它开始，前面不能加其他内容`);
    for(const f of fields){
        if(f.inline.trim())errors.push(`${pos(f.name)}：字段名须单独一行，内容写在下一行`);
        if(!f.value)errors.push(`${pos(f.name)}：内容为空，须填写实际内容`);
        else if(/^(?:待填|TODO|TBD|\.\.\.|…|[—-]+)$/i.test(f.value)||/〔|〕/.test(f.value))errors.push(`${pos(f.name)}：仍是占位符（待填/TODO/〔〕等），须换成实际内容`);
    }
    errors.push(...keywordErrors(content,{strict:true}).map(s=>`第2个字段「关键词」：${String(s).replace(/^关键词/,'')}`));
    // ★ 2026-11-05（第6步②）：状态字段严格整值 —— 只认三值之一，且只能出现一个值。
    //   收紧点：① 不允许前置词（「⚠ 待验证」「当前待验证」等，旧口径本也拒，这次把提示写清）；
    //   ② 不允许「待验证/已验证」这种混写（旧口径因分隔符集含 / 而放行）；
    //   ③ 值后只允许空白与标点分隔，不允许用 / 连接。
    //   存量影响已实测（knowledge_records 4397 行）：命中 ② / ③ 的 0 条，故不会误伤历史数据。
    const state=fields.at(-1).value.trim();
    const sm=state.match(/^(已验证|待验证|已替代)/);
    if(!sm)errors.push(`${pos('状态')}：必须以「已验证」「待验证」或「已替代」开头（不接受前置词或说明，如「⚠ 待验证」「当前待验证」）`);
    else{
        const after=state.slice(sm[1].length);
        if(after&&!/^[/／]/.test(after)&&!/^[\s;；,，。:：(（]/.test(after))errors.push(`${pos('状态')}：值后须紧接分隔标点或空白（当前紧跟「${after[0]}」）`);
        else if(/^[/／]\s*(已验证|待验证|已替代)/.test(after))errors.push(`${pos('状态')}：只写一个状态值，检测到「${sm[1]}${after.replace(/\s+/g,' ').slice(0,8)}」混写；请改为单一值`);
        else if(/^[/／]/.test(after))errors.push(`${pos('状态')}：值后不能用「/」连接（当前「${sm[1]}${after.replace(/\s+/g,' ').slice(0,8)}」）；请用逗号或换行分隔`);
    }
    const dates=[...state.matchAll(/最后核验日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})(?!\d)/g)];
    if(dates.length!==1)errors.push(`${pos('状态')}：须包含且仅包含一次「最后核验日期：YYYY-MM-DD」（当前 ${dates.length} 次）`);
    else {
        const day=dates[0][1],parsed=new Date(day+'T00:00:00Z'),now=new Date();
        const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==day||day>today)errors.push(`${pos('状态')}：最后核验日期「${day}」无效或晚于今天（${today}）`);
    }
    return errors;
}
export function memoryBodySchema(options={}) {
    return z.string().superRefine((content,ctx)=>{const errors=memoryBodyErrors(content,options);if(errors.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:`MEMORY_BODY_FORMAT：${errors.join('；')}。未写入，请按模板修正：\n${MEMORY_BODY_TEMPLATE}`});}).describe(MEMORY_BODY_GUIDE+'\n'+MEMORY_BODY_TEMPLATE);
}
export function installMemoryBodyGuard(db, table = 'memories') {
    const fields=BODY_FIELDS;
    const positions=fields.map((f,i)=>`instr(char(10)||s,char(10)||'${f}:') p${i}`).join(',');
    const values=fields.map((f,i)=>`trim(substr(s,p${i}+${f.length+1},${i<5?`p${i+1}-p${i}-${f.length+1}`:'length(s)'}),char(10)||' ') v${i}`).join(',');
    const unique=fields.map(f=>`length(char(10)||s)-length(replace(char(10)||s,char(10)||'${f}:',''))=length(char(10)||'${f}:')`).join(' AND ');
    const standalone=fields.map(f=>`instr(char(10)||(SELECT s FROM body_clean)||char(10),char(10)||'${f}:'||char(10))>0`).join(' AND ');
    const nonempty=fields.map((_,i)=>`length(v${i})>0 AND upper(v${i}) NOT IN ('待填','TODO','TBD','...','…','-','—') AND instr(v${i},'〔')=0 AND instr(v${i},'〕')=0`).join(' AND ');
    const check=`${bodyCTE('NEW.content')}, pos AS (SELECT s,${positions} FROM body_norm), vals AS (SELECT *,${values} FROM pos), dated AS (SELECT *,substr(trim(substr(v5,instr(v5,'最后核验日期:')+7)),1,10) d FROM vals)
      SELECT CASE WHEN coalesce((SELECT p0=1 AND p1>p0 AND p2>p1 AND p3>p2 AND p4>p3 AND p5>p4 AND ${unique} AND ${standalone} AND ${nonempty}
        AND substr(v5,1,3) IN ('已验证','待验证','已替代') AND (length(v5)=3 OR instr(' ;；,，。:：(（'||char(10),substr(v5,4,1))>0)
        AND instr(v5,'最后核验日期:')>0 AND length(v5)-length(replace(v5,'最后核验日期:',''))=7
        AND d GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND substr(trim(substr(v5,instr(v5,'最后核验日期:')+7)),11,1) NOT GLOB '[0-9]' AND date(d,'+0 days')=d AND d<=date('now','localtime') FROM dated),0)=0
      THEN RAISE(ABORT,'MEMORY_BODY_FORMAT: 六字段名各占一行，内容另起一行；结论、关键词、适用范围、依据、行动、状态及实际核验日期') END;`;
    db.exec('SAVEPOINT body_guard_v3');
    try {
        removeMemoryBodyGuard(db);
        for(const [suffix,event,extra] of [['insert','INSERT',''],['update','UPDATE OF content',' AND NEW.content IS NOT OLD.content']]){
            db.exec(`CREATE TRIGGER memory_body_v3_${suffix} BEFORE ${event} ON ${table} WHEN NEW.source='agent' AND NEW.type!='task'${extra} BEGIN ${check}
              SELECT CASE WHEN (${keywordValidationSQL('NEW.content',true)})!=1 THEN RAISE(ABORT,'MEMORY_BODY_FORMAT: 关键词须为3～5个非空不重复词，每词≤80字，总长≤160字') END; END;`);
        }
        db.exec('RELEASE body_guard_v3');
    }catch(e){db.exec('ROLLBACK TO body_guard_v3; RELEASE body_guard_v3');throw e;}
}
export function removeMemoryBodyGuard(db) {
    for(const v of [1,2,3]) for(const suffix of ['insert','update'])db.exec(`DROP TRIGGER IF EXISTS memory_body_v${v}_${suffix}`);
}
