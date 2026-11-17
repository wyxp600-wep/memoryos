import { renewCardLease } from './db.js';
export function executionOwned(db,job){
  if(!job.dispatchKey)return true;
  const c=db.prepare('SELECT status,claim_lock FROM cards WHERE id=?').get(job.cardId);
  if(!c || c.status!=='running' || c.claim_lock!==job.dispatchKey)return false;
  return !job.dispatchId || db.prepare('SELECT state FROM dispatches WHERE id=?').get(job.dispatchId)?.state==='active';
}
/** 排队也维护租约；已由MCP收口时释放执行位；失效凭证绝不启动或覆盖新任务。 */
export function watchExecution(db,job,finish){
  let renewed=Date.now();
  const timer=setInterval(()=>{
    if(['done','failed'].includes(job.status)){clearInterval(timer);return;}
    try{
      const c=db.prepare('SELECT status,claim_lock FROM cards WHERE id=?').get(job.cardId);
      if(c && ['done','review'].includes(c.status) && (!job.dispatchId || db.prepare('SELECT state FROM dispatches WHERE id=?').get(job.dispatchId)?.state==='settled')) { job.settledByTask=true; finish(job,true,'任务已通过MCP回写，释放执行通道'); return; }
      if(!executionOwned(db,job)){job.stale=true;finish(job,false,'派发凭证已失效，停止旧任务');return;}
      if(Date.now()-renewed>=60000){renewCardLease(db,job.cardId,job.dispatchId);renewed=Date.now();}
    }catch(error){job.leaseError=error.message;job.stale=true;finish(job,false,'无法核验执行凭证，已停止旧执行');}
  },250);
  timer.unref?.();return timer;
}
