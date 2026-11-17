import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {backupStorage,validateBundle,restoreBundle} from './storage.js';
import {readConfig,writeConfig} from './db.js';
import {protectSecret,unprotectSecret} from './secret-store.js';
import {probeEndpoint,normalizeLlmEndpoint} from './llm.js';
import {checkEgressUrl} from './net-guard.js';
import {preferences,validatePreferences,portableConfig,recordNotice} from './personal-settings.js';
import {sourceCatalog,customSourcesPath,getSources,loadCustomSpecs,saveCustomSpecs} from './ingest.js';

export function registerSettings(app,ctx){
  const {db,readDiskConfig,writeDiskConfig,dataDirOf,RESTRICTED}=ctx;
  const dbPath=process.env.MEMORY_DB||db.storage?.files.main;
  const backupRoot=()=>path.join(path.dirname(dbPath),'backup');
  const safeId=id=>{if(typeof id!=='string'||!/^storage-\d{4}-\d{2}-\d{2}(?:-[\da-fT-]+)?$/.test(id))throw new Error('备份编号无效');return path.join(backupRoot(),id);};
  const writeGuard=reply=>{if(RESTRICTED){reply.code(403).send({ok:false,error:'受限模式无法修改设置'});return false;}return true;};
  const fail=(reply,e)=>reply.code(400).send({ok:false,error:e.message});
  const list=()=>!dbPath||!fs.existsSync(backupRoot())?[]:fs.readdirSync(backupRoot(),{withFileTypes:true}).filter(d=>d.isDirectory()&&/^storage-\d{4}-\d{2}-\d{2}(?:-[\da-fT-]+)?$/.test(d.name)).map(d=>{
    try{const m=JSON.parse(fs.readFileSync(path.join(backupRoot(),d.name,'manifest.json'),'utf8'));return {id:d.name,createdAt:m.created_at,bytes:m.members.reduce((s,x)=>s+x.bytes,0),hasSettings:fs.existsSync(path.join(backupRoot(),d.name,'settings.json'))};}
    catch{return {id:d.name,error:'清单不完整，不能恢复'};}
  }).sort((a,b)=>String(b.createdAt||b.id).localeCompare(String(a.createdAt||a.id)));
  app.get('/api/settings',async()=>{
    const cfg=readDiskConfig();let version='未知';try{version=JSON.parse(fs.readFileSync(new URL('../version.json',import.meta.url),'utf8')).version;}catch{/* 缺少版本文件 */}
    let ingest=null;try{ingest=JSON.parse(fs.readFileSync(path.join(dataDirOf(),'ingest-status.json'),'utf8'));}catch{/* 尚未采集 */}
    const prefs=preferences(cfg);prefs.disabledSources=[...new Set([...prefs.disabledSources,...loadCustomSpecs().filter(s=>s.enabled===false).map(s=>s.id)])];
    return {ok:true,preferences:prefs,profiles:(cfg.modelProfiles||[]).map(({keyEnc,...p})=>({...p,keySet:!!keyEnc})),roles:cfg.modelRoles||{},sources:sourceCatalog(),sourceFiles:getSources().length,reflect:readConfig(db,'reflect',{}),backups:list(),dataDir:dataDirOf(),backupDir:dbPath?backupRoot():null,version,ingest,environmentOverride:!!(process.env.LLM_BASE_URL||process.env.LLM_MODEL||process.env.LLM_API_KEY),restricted:RESTRICTED};
  });
  app.post('/api/settings',async(req,reply)=>{
    if(!writeGuard(reply))return;
    try{
      const b=req.body||{},cfg=readDiskConfig();
      if(b.preferences!==undefined)cfg.preferences={...preferences(cfg),...validatePreferences(b.preferences)};
      if(b.reflect!==undefined){const r=b.reflect;if(typeof r.enabled!=='boolean'||!Number.isInteger(r.hour)||r.hour<0||r.hour>23)throw new Error('规则提炼时间或开关无效');}
      if(b.preferences?.disabledSources){const specs=loadCustomSpecs();if(specs.length){const saved=saveCustomSpecs(specs.map(s=>({...s,enabled:!cfg.preferences.disabledSources.includes(s.id)})));if(!saved.ok)throw new Error(saved.error);}}
      writeDiskConfig(cfg);
      if(b.reflect)writeConfig(db,'reflect',{...readConfig(db,'reflect',{}),enabled:b.reflect.enabled,hour:b.reflect.hour});
      return {ok:true,preferences:preferences(cfg)};
    }catch(e){return fail(reply,e);}
  });
  app.post('/api/settings/profiles',async(req,reply)=>{
    if(!writeGuard(reply))return;
    try{
      const b=req.body||{},cfg=readDiskConfig();const profiles=[...(cfg.modelProfiles||[])];
      if(b.action==='delete'){
        if(!profiles.some(x=>x.id===b.id))throw new Error('模型档案不存在');
        if(Object.values(cfg.modelRoles||{}).includes(b.id))throw new Error('请先将正在使用该档案的用途改为其他模型');
        cfg.modelProfiles=profiles.filter(x=>x.id!==b.id);
      }else if(b.action==='roles'){
        if(!b.roles||typeof b.roles!=='object')throw new Error('请选择模型用途');
        for(const role of ['chat','ingest'])if(b.roles[role]!==''&&!profiles.some(x=>x.id===b.roles[role]))throw new Error('所选模型档案不存在');
        cfg.modelRoles={chat:b.roles.chat,ingest:b.roles.ingest};
      }else if(b.action==='save'){
        const name=String(b.name||'').trim(),url=String(b.url||'').trim(),model=String(b.model||'').trim();
        if(!name||name.length>80||!model||model.length>160)throw new Error('请填写档案名称和模型名称');
        const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('模型地址须为无凭据的 HTTP 或 HTTPS 地址');
        if(!b.id&&profiles.length>=20)throw new Error('最多保存 20 个模型档案');
        const old=profiles.find(x=>x.id===b.id),p={id:old?.id||randomUUID(),name,url,model};
        if(old?.keyEnc)p.keyEnc=old.keyEnc;
        if(b.clearKey)delete p.keyEnc;
        if(b.key){const enc=await protectSecret(String(b.key));if(!enc.ok)throw new Error('密钥加密失败：'+enc.error);p.keyEnc=enc.blob;}
        cfg.modelProfiles=profiles.filter(x=>x.id!==p.id).concat(p);
      }else throw new Error('未知的模型档案操作');
      writeDiskConfig(cfg);return {ok:true};
    }catch(e){return fail(reply,e);}
  });
  app.post('/api/settings/profiles/test',async(req,reply)=>{
    if(!writeGuard(reply))return;
    try{const b=req.body||{},p=readDiskConfig().modelProfiles?.find(x=>x.id===b.id),guard=checkEgressUrl(normalizeLlmEndpoint(String(b.url||'')));
      if(!guard.ok)throw new Error('模型地址被拒绝：'+guard.error);
      const key=String(b.key||'')||(b.clearKey?'':p?.keyEnc?await unprotectSecret(p.keyEnc):'');
      return await probeEndpoint({url:guard.url,model:String(b.model||''),key},15000);
    }catch(e){return fail(reply,e);}
  });
  app.post('/api/settings/backups',async(req,reply)=>{
    if(!writeGuard(reply))return;
    try{
      if(!db.storage)throw new Error('当前数据库尚未启用整组存储，无法生成完整备份');
      const cfg=readDiskConfig(),result=backupStorage(db,dbPath,{keep:preferences(cfg).backupKeep,manual:true});
      fs.writeFileSync(path.join(result.created,'settings.json'),JSON.stringify(portableConfig(cfg),null,2));
      if(fs.existsSync(customSourcesPath()))fs.copyFileSync(customSourcesPath(),path.join(result.created,'sources.json'));
      const ui=req.body?.interfacePreferences;if(ui&&typeof ui==='object')fs.writeFileSync(path.join(result.created,'interface.json'),JSON.stringify(ui));
      const manifestFile=path.join(result.created,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));manifest.extras=['settings.json','sources.json','interface.json'].filter(name=>fs.existsSync(path.join(result.created,name))).map(name=>({name,sha256:createHash('sha256').update(fs.readFileSync(path.join(result.created,name))).digest('hex')}));fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
      recordNotice('backup','完整备份已创建',dataDirOf());return {ok:true,id:path.basename(result.created),backups:list()};
    }catch(e){recordNotice('backup','备份失败：'+e.message,dataDirOf());return fail(reply,e);}
  });
  app.post('/api/settings/backups/verify',async(req,reply)=>{
    try{validateBundle(safeId(req.body?.id));return {ok:true,note:'数据库组完整性与 SHA256 校验通过'};}catch(e){return fail(reply,e);}
  });
  app.post('/api/settings/restore/prepare',async(req,reply)=>{
    if(!writeGuard(reply))return;
    try{
      const source=safeId(req.body?.id),id=randomUUID(),root=path.join(dataDirOf(),'restore-staging');fs.mkdirSync(root,{recursive:true});
      const target=path.join(root,id);restoreBundle(source,target);
      for(const f of ['settings.json','sources.json','interface.json'])if(fs.existsSync(path.join(source,f)))fs.copyFileSync(path.join(source,f),path.join(target,f));
      // 重新校验使用原清单，桌面端亦会校验成员指纹，不能传入任意恢复路径。
      fs.copyFileSync(path.join(source,'manifest.json'),path.join(target,'manifest.json'));
      return {ok:true,id,note:'已在独立目录还原并校验；尚未切换当前数据'};
    }catch(e){return fail(reply,e);}
  });
  app.get('/api/settings/diagnostics',async()=>{
    let logs=[];try{logs=db.prepare('SELECT action,created_at FROM daemon_log ORDER BY id DESC LIMIT 10').all();}catch{/* 旧表兼容 */}
    const p=preferences(readDiskConfig());p.excludePaths=p.excludePaths.map(()=>'<已隐藏路径>');
    return {ok:true,generatedAt:new Date().toISOString(),platform:process.platform,node:process.version,storageVersion:db.storage?.version||0,preferences:p,recentMaintenance:logs};
  });
  app.get('/api/settings/notifications',async()=>{
    let items=[];try{items=JSON.parse(fs.readFileSync(path.join(dataDirOf(),'notifications.json'),'utf8'));}catch{/* 尚无维护通知 */}
    const events=db.prepare("SELECT id,card_id,to_status,created_at FROM card_events WHERE to_status IN ('done','review','failed','blocked') AND coalesce(from_status,'')<>to_status ORDER BY id DESC LIMIT 50").all();
    items.push(...events.map(e=>({id:'card-'+e.id,kind:['done','review'].includes(e.to_status)?'done':'failed',message:`任务 #${e.card_id}${e.to_status==='done'?'已完成':e.to_status==='review'?'执行结束，等待验收':e.to_status==='blocked'?'受阻，请查看任务详情':'执行失败，请查看任务详情'}`,at:e.created_at})));
    return {ok:true,preferences:preferences(readDiskConfig()),items:items.sort((a,b)=>String(a.at).localeCompare(String(b.at))).slice(-100)};
  });
}
