import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PREFERENCES = Object.freeze({
  ingestEnabled:true, ingestInterval:5, ingestPaused:false, disabledSources:[], excludePaths:[], allowRemoteIngest:true,
  hygieneEnabled:true, backupEnabled:true, backupKeep:7, closeAction:'tray', startHidden:false,
  updateMode:'auto', notifications:true, desktopNotifications:false, notifyDone:true, notifyFailed:true,
  notifyApproval:true, notifyBackup:true, quietEnabled:false, quietStart:'22:00', quietEnd:'08:00',
});
export function settingsDir(){return process.env.MEMORYOS_DATA_DIR || (process.env.MEMORY_DB ? path.dirname(path.dirname(process.env.MEMORY_DB)) : (process.env.APPDATA ? path.join(process.env.APPDATA,'MemoryOS') : ''));}
export function diskSettings(){const dir=settingsDir();if(!dir)return {};try{return JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}}
export function preferences(cfg=diskSettings()){return {...DEFAULT_PREFERENCES,...cfg.preferences};}
export function validatePreferences(input){
  if(!input || typeof input!=='object'||Array.isArray(input))throw new Error('设置内容须为对象');
  const out={};
  for(const [key,value] of Object.entries(input)){
    if(!(key in DEFAULT_PREFERENCES))throw new Error('未知设置：'+key);
    const def=DEFAULT_PREFERENCES[key];
    if(typeof def==='boolean'){if(typeof value!=='boolean')throw new Error(key+' 须为开关');}
    else if(Array.isArray(def)){if(!Array.isArray(value)||value.length>200||value.some(x=>typeof x!=='string'||x.length>1000))throw new Error(key+' 列表格式不正确');}
    else if(key==='ingestInterval'){if(!Number.isInteger(value)||value<1||value>60)throw new Error('采集间隔须为 1–60 分钟');}
    else if(key==='backupKeep'){if(!Number.isInteger(value)||value<1||value>90)throw new Error('备份保留份数须为 1–90');}
    else if(key==='closeAction'){if(!['tray','quit'].includes(value))throw new Error('关闭行为无效');}
    else if(key==='updateMode'){if(!['auto','notify','off'].includes(value))throw new Error('更新方式无效');}
    else if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw new Error('免打扰时间无效');
    out[key]=value;
  }
  return out;
}
export function sourceAllowed(file,id,p=preferences()){
  if(p.disabledSources.includes(id))return false;
  const normalize=s=>String(s).replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
  const f=normalize(file);
  return !p.excludePaths.some(rule=>{
    const r=normalize(rule.trim());if(!r)return false;
    if(!r.includes('*'))return f===r||f.startsWith(r+'/');
    const pattern=r.split(/(\*\*|\*)/).map(x=>x==='**'?'.*':x==='*'?'[^/]*':x.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('');
    return new RegExp('^'+pattern+'(?:/.*)?$','i').test(f);
  });
}
export function assertIngestEndpoint(url,p=preferences()){
  if(p.allowRemoteIngest)return;
  const u=new URL(url);
  if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname.toLowerCase()))throw new Error('隐私设置已禁止将采集内容发送到远程模型；请使用本机模型或调整采集与隐私设置');
}
export function withModelProfile(cfg,role='chat'){
  const id=cfg.modelRoles?.[role], profile=cfg.modelProfiles?.find(x=>x.id===id);
  return profile?{...cfg,llmUrl:profile.url,llmModel:profile.model,llmKeyEnc:profile.keyEnc}:cfg;
}
export function portableConfig(value){
  if(Array.isArray(value))return value.map(portableConfig);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(key|token|password|credential|secret)/i.test(k)).map(([k,v])=>[k,portableConfig(v)]));
  return value;
}
export function inQuietHours(p,now=new Date()){
  if(!p.quietEnabled)return false;
  const n=now.getHours()*60+now.getMinutes(),minutes=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
  const a=minutes(p.quietStart),b=minutes(p.quietEnd);
  return a===b || (a<b ? n>=a&&n<b : n>=a||n<b);
}
export function recordNotice(kind,message,dir=settingsDir()){
  if(!dir)return;
  const file=path.join(dir,'notifications.json');let items=[];
  try{items=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')console.error('[notification] '+e.message);}
  items.push({id:Date.now()+'-'+Math.random().toString(16).slice(2,8),kind,message,at:new Date().toISOString()});
  fs.mkdirSync(dir,{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(items.slice(-100)));fs.renameSync(tmp,file);
}
