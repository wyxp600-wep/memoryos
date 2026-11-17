const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),checks=[],errors=[];
async function check(name,fn){try{await fn();checks.push({name,pass:true});console.log('通过：'+name);}catch(e){checks.push({name,pass:false,error:e.message});console.error('失败：'+name+'：'+e.message);}}
async function main(){
  const {server,state,url}=await require('./p2-fixture.cjs')(root);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    const page=await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>{errors.push(e.message);console.error('页面异常：'+e.message);});
    await page.addInitScript(()=>{localStorage.setItem('memoryos-link-hint-shown','1');});
    await page.goto(url+'/#memory');await page.waitForTimeout(800);
    await check('全部 CSS 与 JS 布局视口单位迁移为 dvh',async()=>{for(const f of ['index.html','app.js'])assert(!/100vh\b/.test(fs.readFileSync(path.join(root,f),'utf8')));});
    await check('1280px 笔记工作台保留多列，1100px 才收拢',async()=>{
      await page.evaluate(()=>location.hash='obsidian');await page.waitForTimeout(150);
      for(const [width,cols] of [[1280,3],[1100,1]]){await page.setViewportSize({width,height:900});const actual=await page.locator('.notes-workbench').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length);assert.equal(actual,cols);}
    });
    await check('1920px 超宽屏内容不超过1440且居中',async()=>{await page.setViewportSize({width:1920,height:1080});const b=await page.locator('.main-content').boundingBox();assert(b.width<=1441);assert(Math.abs(b.x-(1920-b.width)/2)<2);});
    const sizes=[[320,740],[375,812],[768,1024],[844,390],[1100,800],[1280,800],[1440,1000],[1920,1080]];
    for(const [width,height] of sizes){
      await check(`${width}×${height} 导航、记忆、智能体、任务地图无页面横向溢出`,async()=>{
        await page.setViewportSize({width,height});
        for(const route of ['memory','agent','tasks']){
          await page.evaluate(r=>location.hash=r,route);await page.waitForTimeout(160);
          assert.equal(await page.locator('#page-'+route+'.active').count(),1);
          const layout=await page.evaluate(()=>({width:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
          assert(layout.doc<=width+1&&layout.body<=width+1,JSON.stringify(layout));
          const main=await page.locator('.main-content').boundingBox();assert(main.x>=-1&&main.x+main.width<=width+1);
          if(route==='memory'&&width<=768){const w=await page.locator('#allTable').evaluate(e=>({table:e.scrollWidth,wrap:e.parentElement.clientWidth,overflow:getComputedStyle(e.parentElement).overflowX}));assert(w.table>w.wrap);assert.equal(w.overflow,'auto');}
        }
      });
    }
    await check('窄屏操作菜单可打开、操作仍可达、Escape 关闭',async()=>{
      await page.setViewportSize({width:375,height:812});await page.evaluate(()=>location.hash='memory');await page.waitForTimeout(180);
      assert.equal(await page.locator('#globalTools').evaluate(e=>e.open),false);await page.locator('#globalTools>summary').click();
      assert(await page.locator('#globalSearch').isVisible());assert(await page.locator('#settingsBtn').isVisible());
      await page.keyboard.press('Escape');assert.equal(await page.locator('#globalTools').evaluate(e=>e.open),false);
    });
    await check('手机规则、技能、治理与笔记页面均可直达且不横向溢出',async()=>{
      for(const route of ['rules','skills','govern','obsidian']){await page.evaluate(r=>location.hash=r,route);await page.waitForTimeout(170);assert.equal(await page.locator('#page-'+route+'.active').count(),1);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
      await page.evaluate(()=>location.hash='memory');await page.waitForTimeout(170);
    });
    await check('手机筛选弹层与表格可以独立滚动',async()=>{
      await page.locator('#memoryFilters>summary').click();const b=await page.locator('.filter-popover-panel').boundingBox();assert(b.x>=0&&b.x+b.width<=376);await page.keyboard.press('Escape');
      assert(await page.locator('#allTable').evaluate(e=>{const w=e.parentElement;w.scrollLeft=100;return w.scrollLeft>0;}));
    });
    await check('手机筛选按钮及复选框实际命中区至少44px',async()=>{await page.locator('#memoryFilters>summary').click();for(const element of [page.locator('#statusFilter button').first(),page.locator('#allTableBody .row-checkbox').first()]){const b=await element.boundingBox();assert(Math.round(b.width)>=44&&Math.round(b.height)>=44,JSON.stringify(b));}await page.keyboard.press('Escape');});
    await check('手机设置弹窗改为单列，窗口内可滚动且关闭按钮可达',async()=>{
      await page.locator('#globalTools>summary').click();await page.locator('#settingsBtn').click();const modal=page.locator('#settingsModal .modal');assert(await modal.isVisible());const b=await modal.boundingBox();assert(b.x>=0&&b.x+b.width<=376);assert.equal(await page.locator('#settingsModal .modal-body').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),1);await page.locator('#settingsClose').click();
    });
    await page.screenshot({path:path.join(__dirname,'p2-memory-phone.png'),fullPage:true});
    await check('手机输入控件不小于16px，发送按钮至少44px',async()=>{
      await page.evaluate(()=>location.hash='agent');await page.waitForTimeout(180);
      assert(await page.locator('#agentInput').evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=16));
      const b=await page.locator('#agentSendBtn').boundingBox();assert(b.width>=44&&b.height>=44);await page.locator('#agentSendBtn').scrollIntoViewIfNeeded();const v=await page.locator('#agentSendBtn').boundingBox();assert(v.y>=0&&v.y+v.height<=813);
    });
    await page.screenshot({path:path.join(__dirname,'p2-agent-phone.png'),fullPage:true});
    await check('动态视口缩小后输入仍可滚动到可见位置',async()=>{
      await page.locator('#agentInput').focus();await page.setViewportSize({width:375,height:480});await page.waitForTimeout(160);await page.locator('#agentInput').scrollIntoViewIfNeeded();
      const b=await page.locator('#agentInput').boundingBox();assert(b.y>=0&&b.y+b.height<=481);assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--viewport-height').trim()),'480px');
    });
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>location.hash='tasks');await page.waitForTimeout(250);
    await page.screenshot({path:path.join(__dirname,'p2-map-desktop.png'),fullPage:true});
    const touchContext=await browser.newContext({viewport:{width:768,height:1024},hasTouch:true,isMobile:true,deviceScaleFactor:1});
    const touch=await touchContext.newPage();touch.setDefaultTimeout(5000);touch.on('pageerror',e=>errors.push(e.message));
    await touch.addInitScript(()=>{localStorage.setItem('memoryos-link-hint-shown','1');});await touch.goto(url+'/#tasks');await touch.waitForTimeout(600);
    const node=id=>touch.locator(`.task-map-node[data-card-id="${id}"]`);
    const tap=async id=>{await touch.locator('.toast-dismiss').evaluateAll(elements=>elements.forEach(x=>x.click()));await touch.waitForTimeout(200);await touch.locator('#taskMapCanvas').scrollIntoViewIfNeeded();const b=await node(id).boundingBox();assert(b);const point={x:b.x+b.width*.4,y:b.y+b.height*.5};const hit=await touch.evaluate(p=>({id:document.elementFromPoint(p.x,p.y)?.closest('.task-map-node')?.dataset.cardId,element:document.elementFromPoint(p.x,p.y)?.tagName}),point);assert.equal(hit.id,String(id),'触点应命中目标卡 #'+id+JSON.stringify({point,hit}));await touch.touchscreen.tap(point.x,point.y);await touch.waitForTimeout(70);};
    await check('真实触摸事件选卡，显示工具栏而非依赖悬停',async()=>{await tap(101);assert(await touch.locator('#taskMapSelection').isVisible());assert((await touch.locator('#taskMapSelectionText').innerText()).includes('#101'));});
    await check('缩放地图后的触屏连线手柄命中区仍至少44px',async()=>{const b=await node(101).locator('.task-map-node-link').boundingBox();assert(b.width>=43.5&&b.height>=43.5,JSON.stringify(b));});
    await check('点击连线实际提交依赖API，保留方向和种类',async()=>{const n=state.writes.length;await touch.locator('#taskMapSelectionLink').tap();await tap(102);await touch.waitForTimeout(180);const calls=state.writes.slice(n).filter(x=>x.url.endsWith('/links'));assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/cards/101/links');assert.deepEqual(calls[0].body,{dst_card_id:102,kind:'depends'});});
    await check('点击同卡不发请求，取消不留连线',async()=>{const n=state.writes.length;await tap(101);await touch.locator('#taskMapSelectionLink').tap();await tap(101);await touch.locator('#taskMapSelectionCancel').tap();assert.equal(state.writes.length,n);});
    await check('非法文档前置被拦截，失败后可以重新选目标',async()=>{const n=state.writes.length;await tap(101);await touch.locator('#taskMapSelectionLink').tap();await tap(104);assert.equal(state.writes.length,n);assert((await touch.locator('#taskMapSelectionText').innerText()).includes('请点击目标卡'));await touch.locator('#taskMapSelectionCancel').tap();});
    await check('服务端409冲突可见，保留选择允许重试',async()=>{await tap(101);await touch.locator('#taskMapSelectionLink').tap();state.rejectNext=true;await tap(102);await touch.waitForTimeout(120);assert((await touch.locator('.toast-message').allTextContents()).some(s=>s.includes('循环依赖')));assert(await touch.locator('#taskMapSelection').isVisible());await touch.locator('#taskMapSelectionCancel').tap();});
    await check('智能体源卡不能建立依赖',async()=>{const n=state.writes.length;await tap(103);await touch.locator('#taskMapSelectionLink').tap();assert.equal(state.writes.length,n);await touch.locator('#taskMapSelectionCancel').tap();});
    await check('连到智能体保留派发确认，取消不发送派发请求',async()=>{const n=state.writes.length;await tap(102);await touch.locator('#taskMapSelectionLink').tap();await tap(103);await touch.getByText('确认派发',{exact:true}).waitFor();assert.equal(state.writes.slice(n).filter(x=>x.url.includes('dispatch-agent')).length,0);await touch.locator('[data-act=cancel]').tap();assert.equal(state.writes.length,n);});
    await check('触摸拖动被系统取消时不保存位置或建立连线',async()=>{
      await touch.locator('#taskMapCanvas').scrollIntoViewIfNeeded();const b=await node(101).boundingBox(),n=state.writes.length,cdp=await touchContext.newCDPSession(touch);
      const p={x:b.x+b.width*.4,y:b.y+b.height*.5};await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+15,y:p.y+15,id:1}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await touch.waitForTimeout(120);assert.equal(state.writes.length,n);await cdp.detach();
    });
    await check('桌面鼠标拖线与触屏共用正确提交接口',async()=>{
      await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>location.hash='tasks');await page.waitForTimeout(170);await page.locator('#taskMapCanvas').scrollIntoViewIfNeeded();
      const source=page.locator('.task-map-node[data-card-id="102"]'),target=page.locator('.task-map-node[data-card-id="101"]');await source.hover();const h=await source.locator('.task-map-node-link').boundingBox(),t=await target.boundingBox(),n=state.writes.length;
      await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(t.x+t.width*.4,t.y+t.height/2,{steps:8});await page.mouse.up();await page.waitForTimeout(150);
      const calls=state.writes.slice(n).filter(x=>x.url.endsWith('/links'));assert.equal(calls.length,1);assert.equal(calls[0].body.dst_card_id,101);assert.equal(await page.locator('.task-map-node.link-target').count(),0);
    });
    await check('鼠标拖线按Escape取消，不留下临时线或请求',async()=>{
      await page.locator('.toast-dismiss').evaluateAll(es=>es.forEach(e=>e.click()));await page.waitForTimeout(200);const source=page.locator('.task-map-node[data-card-id="101"]');await source.hover();const h=await source.locator('.task-map-node-link').boundingBox(),n=state.writes.length;
      await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+80,h.y+50,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();assert.equal(state.writes.length,n);assert.equal(await page.locator('#taskMapEdges.task-map-linking').count(),0);
    });
    await touch.screenshot({path:path.join(__dirname,'p2-map-touch.png'),fullPage:true});
    await touch.evaluate(()=>document.documentElement.dataset.theme='dark');await touch.waitForTimeout(240);await touch.screenshot({path:path.join(__dirname,'p2-map-touch-dark.png'),fullPage:true});
    await check('触屏任务按钮均达到44px',async()=>{for(const id of ['taskMapTapModeBtn','taskMapZoomInBtn','taskMapZoomOutBtn','taskMapFitBtn']){const b=await touch.locator('#'+id).boundingBox();assert(b.width>=44&&b.height>=44,id+':'+JSON.stringify(b));}});
    await check('P2浏览器无未捕获异常',async()=>assert.deepEqual(errors,[]));
    await touchContext.close();await context.close();
  }finally{await browser.close();await server.close();}
  const result={checks,errors,productionWrites:0,touchEmulation:'Chrome hasTouch + touchscreen.tap',physicalDeviceTested:false};
  fs.writeFileSync(path.join(__dirname,'p2-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:checks.filter(x=>x.pass).length,failed:checks.filter(x=>!x.pass).length,errors}));if(checks.some(x=>!x.pass))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
