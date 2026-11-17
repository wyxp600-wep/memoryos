const path=require('node:path');
const {pathToFileURL}=require('node:url');
module.exports=async function(root){
  const fastify=require('fastify');const server=fastify({logger:false});
  const {registerStatic}=await import(pathToFileURL(path.resolve(root,'../dist/dashboard-reg-static.js')));
  registerStatic(server,{UI_DIR:root,_staticCache:new Map()});
  const state={writes:[],rejectNext:false,nodes:[
    {id:101,kind:'task',title:'整理响应式布局',status:'todo',bucket:'open',body:'P2 隔离样例',meta:{}},
    {id:102,kind:'task',title:'验证触屏连线',status:'todo',bucket:'open',body:'另一张样例任务卡',meta:{}},
    {id:103,kind:'agent',title:'演示智能体',status:'ready',bucket:'open',meta:{}},
    {id:104,kind:'doc',title:'演示文档',status:'todo',bucket:'open',meta:{}}
  ],links:[]};
  server.get('/favicon.ico',async(req,reply)=>reply.code(204).send());
  server.get('/api/*',async req=>{
    const p=req.url.split('?')[0];
    if(p==='/api/cards/stream')return {ok:true};
    if(p==='/api/cards/graph')return {ok:true,nodes:state.nodes,links:state.links,edges:[]};
    if(p==='/api/cards')return {ok:true,cards:state.nodes,total:state.nodes.length,columns:{},rows:state.nodes};
    if(/^\/api\/cards\/\d+$/.test(p))return {ok:true,card:state.nodes.find(n=>n.id===Number(p.split('/').pop()))};
    if(p==='/api/card-types')return {ok:true,types:[{type_key:'task',label:'任务'},{type_key:'agent',label:'智能体'},{type_key:'doc',label:'文档'}]};
    if(p==='/api/agent-cards/103/state')return {ok:true,name:'演示智能体',channel:'queue',queue_depth:0,carrier_missing:false};
    if(p==='/api/all')return {total:1000,rows:Array.from({length:1000},(_,i)=>({id:i+1,content:'规范回归样例 '+String(i+1).padStart(4,'0'),type:'experience',status:'active',agent:'codex',project:'memoryos',sector:'semantic',created_at:'2026-10-16',eff:.8,hits:1,confidence:.8}))};
    if(p==='/api/unused-all')return {total:2,rows:[{id:1,content:'P2 样例：表格在手机上可横向滚动',type:'experience',status:'active',agent:'codex',project:'memoryos',sector:'semantic',created_at:'2026-10-16',eff:.8,hits:1,confidence:.8},{id:2,content:'P2 样例：保留全部数据列',type:'pitfall',status:'archived',agent:'claude',project:'memoryos',sector:'procedural',created_at:'2026-10-16',eff:.9,hits:2,confidence:.9}]};
    if(p==='/api/summary')return {total:2,statusRows:[{status:'active',n:1},{status:'archived',n:1}],typeRows:[],agentRows:[],projectRows:[],restricted:{enabled:false}};
    if(p==='/api/prospective/due')return {ok:true,due:[]};
    if(['/api/top','/api/zombies','/api/trend','/api/cross-tool','/api/audit','/api/tools','/api/rules'].includes(p))return [];
    if(p==='/api/usage-health')return {today:{search:0,write:0,returned:0,cited:0},days30:{search:0,write:0,returned:0,cited:0}};
    if(p==='/api/write-health')return {lastWrite:null,daysSince:null,writes30d:0};
    return {ok:true,rows:[],cards:[],links:[],list:[],runs:[],sessions:[],sources:[],approvals:[],pending:[],tools:[],types:[],projects:[],skills:[],roots:[],items:[],notes:[],vaults:[],events:[],stats:{},enabled:false};
  });
  server.post('/api/*',async(req,reply)=>{
    state.writes.push({url:req.url,body:req.body});
    if(req.url.endsWith('/links')){
      if(state.rejectNext){state.rejectNext=false;return reply.code(409).send({ok:false,error:'样例冲突：存在循环依赖'});}
      state.links.push({src_id:Number(req.url.split('/')[3]),dst_id:req.body.dst_card_id,kind:req.body.kind});
    }
    return {ok:true};
  });
  await server.listen({host:'127.0.0.1',port:0});
  return {server,state,url:'http://127.0.0.1:'+server.server.address().port};
};
