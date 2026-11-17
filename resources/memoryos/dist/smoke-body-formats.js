/** 共享解析器、严格写入门禁、摘要、旧SQLite连接的Markdown一致性。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDb} from './db.js';import {StorageConnection} from './storage.js';
import {bodyFixture} from './memory-body-fixture.js';import {memoryBodyErrors} from './memory-body.js';
import {memoryFields} from './memory-fields.js';import {memoryPreview} from './format.js';import {bodyFields} from './proposition.js';
delete process.env.MEMORYOS_BODY_GUARD;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'body-format-')),file=path.join(root,'memory.db'),db=openDb(file),old=new StorageConnection(file);
const base=bodyFixture('格式兼容校验：解析摘要与写入门禁必须保留相同条件和完整依据。');
const variations=[base,base.replace(/^(结论|关键词|适用范围|依据|行动|状态)：/gm,'## $1'),base.replace(/^(结论|关键词|适用范围|依据|行动|状态)：/gm,'### **$1**：'),base.replace('依据：\n','依据：\n```js\n状态：不是字段\n关键词：不是字段\n```\n')];
try{for(const [i,content]of variations.entries()){
 assert.deepEqual(memoryBodyErrors(content),[],`JS校验变体${i}`);
 assert.equal(memoryFields(content).length,6);assert.ok(bodyFields(content).structured);
 old.prepare("INSERT INTO memories(content,type,source,agent,project) VALUES(?,'experience','agent','format-test','fixture')").run(content);
 assert.equal(db.prepare('SELECT content FROM memories ORDER BY id DESC LIMIT 1').get().content,content);
 assert.ok(memoryPreview(content,220).includes('格式兼容校验'));
}console.log('PASS 4种正文格式的JS/SQLite旧连接写入、原文逐字保留、摘要与命题解析一致');}finally{old.close();db.close();}
