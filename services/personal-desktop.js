'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {ipcMain,Notification}=require('electron');
function registerPersonalDesktop(deps){
 const {readConfig,dataDir,getKernel,getPort,getToken,shell,core,updater,restartMcp,getMainWindow,log}=deps;
 let busy=false;
 const statusFile=()=>path.join(dataDir(),'update-status.json');
 function updateStatus(r){let previous={};try{previous=JSON.parse(fs.readFileSync(statusFile(),'utf8'));}catch{/* 初次检查 */}const note=r.status==='disabled'?'未配置可信更新源。':r.status==='none'?`当前版本 ${r.current}，已是最新。`:r.status==='available'?`发现版本 ${r.latest}，当前 ${r.current}。`:r.status==='applied'?`已安装 ${r.latest}。`:r.status==='error'?'更新失败：'+r.error:'尚未检查更新';const out={...r,note,checkedAt:new Date().toISOString()};fs.writeFileSync(statusFile(),JSON.stringify(out));if(r.status==='available'&&(previous.latest!==r.latest||previous.status!=='available')){const file=path.join(dataDir(),'notifications.json');let notices=[];try{notices=JSON.parse(fs.readFileSync(file,'utf8'));}catch{/* 首次通知 */}notices.push({id:'update-'+r.latest,kind:'update',message:`发现可用更新 ${r.latest}，可在设置中安装。`,at:new Date().toISOString()});fs.writeFileSync(file,JSON.stringify(notices.slice(-100)));}return out;}
 updater.onStatus=r=>updateStatus(r);
 async function stopClients(){
   // 拒绝在其他直连 MCP 客户端仍持有数据库时切换，避免旧会话继续写旧连接。
   const query="Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
   const result=await promisify(execFile)('pwsh.exe',['-NoProfile','-NonInteractive','-Command',query],{windowsHide:true,timeout:15000});
   const rows=JSON.parse(result.stdout||'[]'),normalize=s=>String(s).replace(/\\/g,'/').toLowerCase();
   const target=normalize(path.join(getKernel(),'dist','server.js'));
   const managedParents=new Set([rows].flat().filter(p=>normalize(p.CommandLine).includes(normalize(path.join(getKernel(),'dist','dashboard.js')))).map(p=>p.ProcessId));
   if([rows].flat().some(p=>normalize(p.CommandLine).includes(target)&&!managedParents.has(p.ParentProcessId)))throw Error('请先断开个人版的直连 MCP 会话，再恢复备份。当前数据未切换。');
   core.stopForRestore();
   const infoFile=path.join(dataDir(),'core.json');
   if(fs.existsSync(infoFile)){
     const info=JSON.parse(fs.readFileSync(infoFile,'utf8'));
     const owned=[rows].flat().filter(p=>['dashboard.js','daemon.js'].some(name=>normalize(p.CommandLine).includes(normalize(path.join(getKernel(),'dist',name)))));
     for(const p of owned)await promisify(execFile)('taskkill',['/PID',String(p.ProcessId),'/T','/F'],{windowsHide:true}).catch(()=>{});
   }
 }
 async function restore(id){
   if(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(id||''))throw Error('恢复编号无效');
   if(busy)throw Error('已有桌面维护操作正在进行');busy=true;
   const stage=path.join(dataDir(),'restore-staging',id),rollback=path.join(dataDir(),'before-restore-'+id),active=path.join(dataDir(),'data');
   let stopped=false,switched=[],configBacked=false,success=false;
   try{
     if(deps.isIngestRunning?.())throw Error('自动采集正在执行。请先暂停新一轮采集，等待本轮结束后再恢复；当前数据未切换。');
     const storage=await import(pathToFileURL(path.join(getKernel(),'dist/storage.js')).href);
     const manifest=storage.validateBundle(stage);
     const backupResponse=await fetch(`http://127.0.0.1:${getPort()}/api/settings/backups`,{method:'POST',headers:{'content-type':'application/json','x-memory-token':getToken()},body:'{}'});
     if(!backupResponse.ok)throw Error('当前状态备份失败，已停止恢复');
     fs.mkdirSync(rollback,{recursive:false});
     for(const file of ['config.json','sources.json'])if(fs.existsSync(path.join(dataDir(),file)))fs.copyFileSync(path.join(dataDir(),file),path.join(rollback,file));
     configBacked=true;
     await stopClients();stopped=true;
     // 先移动旧成员及日志到回滚目录，全部成功后才放入新成员。
     for(const m of manifest.members){for(const suffix of ['','-wal','-shm','-journal']){const name=m.name+suffix,old=path.join(active,name);if(fs.existsSync(old)){fs.renameSync(old,path.join(rollback,name));switched.push(name);}}}
     for(const m of manifest.members)fs.copyFileSync(path.join(stage,m.name),path.join(active,m.name));
     if(fs.existsSync(path.join(stage,'settings.json'))){const c=JSON.parse(fs.readFileSync(path.join(stage,'settings.json'),'utf8'));fs.writeFileSync(path.join(dataDir(),'config.json'),JSON.stringify(c,null,2));}
     if(fs.existsSync(path.join(stage,'sources.json')))fs.copyFileSync(path.join(stage,'sources.json'),path.join(dataDir(),'sources.json'));
     await core.resumeAfterRestore();await waitHealthy();success=true;
     let ui=null;try{ui=JSON.parse(fs.readFileSync(path.join(stage,'interface.json'),'utf8'));}catch{/* 旧备份没有界面偏好 */}
     return {ok:true,note:'备份已恢复，旧状态保留在独立回滚目录。',interfacePreferences:ui};
   }catch(e){
     if(stopped){core.stopForRestore();for(const m of JSON.parse(fs.readFileSync(path.join(stage,'manifest.json'),'utf8')).members){const f=path.join(active,m.name);if(fs.existsSync(f)&&!switched.includes(m.name))continue;if(fs.existsSync(f))fs.renameSync(f,path.join(stage,m.name+'.failed-'+Date.now()));}for(const name of switched){const old=path.join(rollback,name);if(fs.existsSync(old))fs.renameSync(old,path.join(active,name));}if(configBacked)for(const file of ['config.json','sources.json'])if(fs.existsSync(path.join(rollback,file)))fs.copyFileSync(path.join(rollback,file),path.join(dataDir(),file));await core.resumeAfterRestore();}
     throw e;
   }finally{busy=false;if(!success)log('恢复未完成；原状态已保留。');}
 }
 async function waitHealthy(){const until=Date.now()+30000;while(Date.now()<until){try{const r=await fetch(`http://127.0.0.1:${getPort()}/health`,{headers:{'x-memory-token':getToken()},signal:AbortSignal.timeout(1500)});if(r.ok)return;}catch{/* 等待核心 */}await new Promise(r=>setTimeout(r,300));}throw Error('恢复后内核未就绪');}
 ipcMain.handle('personal:action',async(event,request)=>{
   const main=getMainWindow();if(!main||main.isDestroyed()||event.sender.id!==main.webContents.id)return {ok:false,error:'调用来源无效'};
   try{
     const action=request?.action;
     if(action==='open-backup'||action==='open-logs'){const dir=action==='open-backup'?path.join(dataDir(),'data','backup'):path.join(dataDir(),'logs');fs.mkdirSync(dir,{recursive:true});const error=await shell.openPath(dir);if(error)throw Error(error);return {ok:true};}
     if(action==='update-status'){let r={note:'尚未检查更新'};try{r=JSON.parse(fs.readFileSync(statusFile(),'utf8'));}catch{/* 初次 */}return {ok:true,...r};}
     if(action==='check-update')return {ok:true,...updateStatus(await updater.applyKernelUpdate({checkOnly:true}))};
     if(action==='install-update'){if(busy)throw Error('已有维护操作正在执行');busy=true;try{const r=await updater.applyKernelUpdate();if(r.status==='applied'&&!await updater.restartAfterUpdate(r))throw Error('更新文件已保存，但内核重启失败');return {ok:true,...updateStatus(r)};}finally{busy=false;}}
     if(action==='restart-core'){if(busy)throw Error('已有维护操作正在执行');await core.restartCore();return {ok:true};}
     if(action==='restart-mcp'){await restartMcp();return {ok:true};}
     if(action==='restore')return await restore(request.id);
     if(action==='notify'){if(!readConfig()?.preferences?.desktopNotifications)return {ok:true};if(Notification.isSupported())new Notification({title:'MemoryOS',body:String(request.body||'').slice(0,240),silent:true}).show();return {ok:true};}
     throw Error('不支持的桌面操作');
   }catch(e){return {ok:false,error:e.message};}
 });
 return {isBusy:()=>busy};
}
module.exports={registerPersonalDesktop};
