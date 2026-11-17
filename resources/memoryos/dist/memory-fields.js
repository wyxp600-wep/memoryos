/** 正文保持原样；解析时兼容历史行内格式与六字段换行格式。 */
export const BODY_FIELDS = ['结论','关键词','适用范围','依据','行动','状态'];
/**
 * ★ 2026-11-12（检索方案 C）：全项目哨兵。传它 = 跳过 scope 硬过滤（project 不过滤）。
 *   仅用于「默认 scope 无有效命中 → 扩全项目重搜」的兜底路径；显式传 project 的行为不变。
 *   放在叶子模块里，避免 db.js ↔ memory-keywords.js 的循环依赖。
 */
export const ALL_PROJECTS = '*';
const FIELD_HEAD = /^(?:#{1,6}\s+)?(?:\*\*|__)?(结论|关键词|适用范围|依据|行动|状态)(?:\*\*|__)?\s*[:：](?:\*\*|__)?[\t ]*(.*)$/;
const FIELD_TITLE = /^#{1,6}\s+(?:\*\*|__)?(结论|关键词|适用范围|依据|行动|状态)(?:\*\*|__)?\s*$/;
/** 仅解释字段标题；正文、缩进、空行、加粗及代码围栏保持原样。 */
export function parseMemoryBody(content) {
    const text=String(content ?? '').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
    const heads=[];let offset=0,fence=null;
    for(const line of text.split('\n')) {
        const trimmed=line.trim(), mark=trimmed.match(/^(`{3,}|~{3,})/);
        if(mark) {if(!fence)fence={char:mark[1][0],length:mark[1].length};else if(mark[1][0]===fence.char&&mark[1].length>=fence.length)fence=null;}
        else if(!fence) {
            const m=FIELD_HEAD.exec(trimmed)||FIELD_TITLE.exec(trimmed);
            if(m) {
                const inline=m[2]??'';
                heads.push({name:m[1],inline,index:offset,valueStart:offset+line.length-inline.length});
            }
        }
        offset+=line.length+1;
    }
    return {text,fields:heads.map((h,i)=>({...h,value:text.slice(h.valueStart,heads[i+1]?.index??text.length).trim()}))};
}
export function canonicalBody(content) {
    const {text,fields}=parseMemoryBody(content),byIndex=new Map(fields.map(f=>[f.index,f]));let offset=0;
    return text.split('\n').map(line=>{const f=byIndex.get(offset);offset+=line.length+1;return f?`${f.name}:${f.inline}`:line.trim();}).filter(Boolean).join('\n');
}
export function normalizedBody(content) {
    return canonicalBody(content).replace(/^(结论|关键词|适用范围|依据|行动|状态):\n/gm,'$1:');
}
export function memoryFields(content) {
    return parseMemoryBody(content).fields;
}
/** SQLite 旧连接也能执行；不依赖连接内 JS 函数。与 canonicalBody/normalizedBody 同口径。 */
export function bodyCTE(expr) {
    let normalized='s';
    for(const f of BODY_FIELDS) normalized=`replace(${normalized},'${f}:'||char(10),'${f}:')`;
    const whitespace=[9,10,11,12,13,32,160,5760,...Array.from({length:11},(_,i)=>8192+i),8232,8233,8239,8287,12288,65279].map(n=>`char(${n})`).join('||');
    const line=`trim(substr(rest,1,instr(rest,char(10))-1),${whitespace})`;
    const stripped=`ltrim(${line},'# ')`;
    const header=`CASE WHEN ${line} GLOB '#*' THEN CASE WHEN ${stripped} IN (${BODY_FIELDS.map(f=>`'${f}'`).join(',')}) THEN ${stripped}||':' ELSE ${stripped} END ELSE ${line} END`;
    const marker=`substr(${line},1,length(${line})-length(ltrim(${line},substr(${line},1,1))))`;
    return `WITH RECURSIVE body_raw(s) AS (SELECT trim(replace(replace(replace(replace(replace(replace(${expr},char(13)||char(10),char(10)),char(13),char(10)),'**',''),'__',''),'：',':'),char(9),' '),${whitespace})),
      body_lines(rest,line,n,fence) AS (SELECT s||char(10),'',0,'' FROM body_raw UNION ALL SELECT substr(rest,instr(rest,char(10))+1),CASE WHEN fence!='' THEN ' '||${line} ELSE ${header} END,n+1,
        CASE WHEN substr(${line},1,3) IN (char(96)||char(96)||char(96),'~~~') THEN CASE WHEN fence='' THEN ${marker} WHEN substr(fence,1,1)=substr(${line},1,1) AND length(${marker})>=length(fence) THEN '' ELSE fence END ELSE fence END
        FROM body_lines WHERE length(rest)>0),
      body_clean(s) AS (SELECT coalesce(group_concat(line,char(10)),'') FROM (SELECT line FROM body_lines WHERE line!='' ORDER BY n)),
      body_norm(s) AS (SELECT ${normalized} FROM body_clean)`;
}
