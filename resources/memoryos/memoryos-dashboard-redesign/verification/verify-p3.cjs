const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright'),{PNG}=require('pngjs'),postcss=require('postcss');
const root=path.resolve(__dirname,'..'),checks=[],errors=[],visual=[];
const readSource=name=>fs.readFileSync(path.join(__dirname,name),'utf8');
const update=process.argv.includes('--update-baseline');
if(update&&process.env.CI)throw Error('CI 禁止更新视觉基准');
const actualDir=path.join(__dirname,'actual'),baselineDir=path.join(__dirname,'baseline');
fs.mkdirSync(actualDir,{recursive:true});if(update)fs.mkdirSync(baselineDir,{recursive:true});
async function check(name,fn){try{await fn();checks.push({name,pass:true});console.log('通过：'+name);}catch(e){checks.push({name,pass:false,error:e.message});console.error('失败：'+name+'：'+e.message);}}
function compare(expected,actual){
  const a=PNG.sync.read(expected),b=PNG.sync.read(actual);assert.equal(a.width,b.width,'截图宽度变化');assert.equal(a.height,b.height,'截图高度变化');
  let changed=0;const diff=new PNG({width:a.width,height:a.height});
  for(let i=0;i<a.data.length;i+=4){let max=0;for(let c=0;c<4;c++)max=Math.max(max,Math.abs(a.data[i+c]-b.data[i+c]));const bad=max>24;if(bad)changed++;diff.data[i]=bad?220:b.data[i];diff.data[i+1]=bad?30:b.data[i+1];diff.data[i+2]=bad?60:b.data[i+2];diff.data[i+3]=255;}
  return {changed,total:a.width*a.height,ratio:changed/(a.width*a.height),diff:PNG.sync.write(diff)};
}
async function main(){
  const {server,state,url}=await require('./p3-fixture.cjs')(root);
  const browser=await chromium.launch({headless:true});
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),app=fs.readFileSync(path.join(root,'app.js'),'utf8');
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai',deviceScaleFactor:1});
    const page=await context.newPage();page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{localStorage.setItem('memoryos-link-hint-shown','1');if(!localStorage.getItem('memoryos-settings'))localStorage.setItem('memoryos-settings',JSON.stringify({theme:'light',fontSize:'medium',reduceMotion:false,pageSize:500}));});
    await page.goto(url+'/styleguide');await page.locator('#page-styleguide.active').waitFor();await page.evaluate(()=>document.fonts.ready);
    await check('/styleguide HTTP 200、根路径资源与路由正确',async()=>{assert.equal((await context.request.get(url+'/styleguide')).status(),200);assert.equal(await page.locator('#page-styleguide.active').count(),1);assert.equal(await page.title(),'界面规范 - MemoryOS');assert.equal(await page.locator('base').getAttribute('href'),'/');});
    await check('规范页从系统菜单可发现，保留4个主入口',async()=>{assert.equal(await page.locator('.global-nav-scroll>a.nav-item').count(),4);await page.locator('#systemNav>summary').click();await page.locator('#systemNav [data-route=styleguide]').click();assert.equal(await page.locator('#page-styleguide.active').count(),1);assert.equal(await page.locator('#systemNav [data-route=styleguide]').getAttribute('aria-current'),'page');});
    await check('设计令牌、表单、状态、反馈、表格、空态、消息与弹窗均存在',async()=>{for(const s of ['[data-token]','.sg-input','.status-pill','.type-tag','.toast-entry','.data-table','.empty-state','.skeleton','.agent-message','#sgDialog'])assert(await page.locator('#page-styleguide '+s).count(),s);const values=await page.locator('[data-token]').allTextContents();assert(values.every(v=>v.trim()));});
    await check('规范页筛选交互同步 aria-pressed',async()=>{const button=page.locator('#page-styleguide [aria-pressed]').nth(1);await button.click();assert.equal(await button.getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#page-styleguide [aria-pressed=true]').count(),1);});
    await check('规范页通知进入真实队列，可关闭且不写数据',async()=>{await page.locator('#sgNotify').click();const notification=page.locator('#toast .toast-entry').filter({hasText:'示例操作已完成'});await notification.waitFor();await notification.locator('.toast-dismiss').click();assert.equal(state.writes.length,0);});
    await check('示例对话框焦点约束、Escape、焦点返回与确认均有效',async()=>{await page.locator('#sgOpenDialog').click();assert(await page.locator('#sgDialog').evaluate(e=>e.open));for(let i=0;i<7;i++){await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.querySelector('#sgDialog').contains(document.activeElement)));}await page.keyboard.press('Escape');assert.equal(await page.locator('#sgDialog').evaluate(e=>e.open),false);assert.equal(await page.locator('#sgOpenDialog').evaluate(e=>e===document.activeElement),true);await page.locator('#sgOpenDialog').click();await page.locator('#sgDialogConfirm').click();assert.equal(await page.locator('#sgDialog').evaluate(e=>e.open),false);assert.equal(state.writes.length,0);await page.locator('#toast .toast-dismiss').last().click();});
    await check('独立子锚点直达，离开规范页关闭示例对话框',async()=>{await page.goto(url+'/#styleguide/motion');await page.locator('#page-styleguide.active').waitFor();await page.locator('#sgOpenDialog').click();await page.evaluate(()=>location.hash='memory');await page.waitForTimeout(80);assert.equal(await page.locator('#sgDialog').evaluate(e=>e.open),false);await page.evaluate(()=>location.hash='styleguide');});
    const css=html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)[1],ast=postcss.parse(css);
    await check('减少动效媒体策略仅1处，旧规则已清除',async()=>{let n=0;ast.walkAtRules('media',r=>{if(/prefers-reduced-motion\s*:\s*reduce\b/.test(r.params))n++;});assert.equal(n,1);assert(!css.includes('rowIn'));assert(!/animation-delay:\s*(?:0\.[1-9]|[1-9])/.test(css));});
    await check('所有非零 CSS 动效时长来自 --dur-*，无 transition:all',async()=>{const bad=[];ast.walkDecls(d=>{if(/^(animation|transition)(?:-|$)/.test(d.prop)&&/(?<![\w.-])(?:\d*\.)?\d*[1-9]\d*(?:ms|s)\b/.test(d.value))bad.push(d.toString());if(d.prop==='transition'&&/\ball\b/.test(d.value))bad.push(d.toString());});assert.deepEqual(bad,[]);assert(!/--duration-(?:enter|exit|feedback)/.test(html+app));});
    await check('新增 CSS 不增加 !important 补丁数量',async()=>{const original=fs.existsSync(path.resolve(root,'../memoryos-ui-p2/index.html'))?fs.readFileSync(path.resolve(root,'../memoryos-ui-p2/index.html'),'utf8'):null;const count=(html.match(/!important/g)||[]).length;if(original)assert(count<=(original.match(/!important/g)||[]).length);assert(count<=355,'重要规则预算超限：'+count);assert(!readSource('p3-styleguide.css').includes('!important'));});
    await check('CSS 解析完整，style 内无提前结束标签',async()=>{assert(!/<\//.test(css));assert(await page.evaluate(()=>[...document.styleSheets].filter(s=>!s.href).every(s=>s.cssRules.length>0)));});
    await check('标准进入240ms，退出160ms，反馈120ms',async()=>{const values=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return ['--dur-enter','--dur-exit','--dur-fast'].map(t=>s.getPropertyValue(t).trim());});assert.deepEqual(values,['240ms','160ms','120ms']);await page.locator('#sgReplay').click();await page.waitForTimeout(35);assert.equal(await page.locator('#sgMotionDemo').evaluate(e=>getComputedStyle(e).animationDuration),'0.24s');});
    async function noMotion(){return page.evaluate(()=>{const bad=[];for(const e of [document.querySelector('#page-styleguide'),...document.querySelectorAll('#page-styleguide *')])for(const pseudo of [null,'::before','::after']){const s=getComputedStyle(e,pseudo);if(s.animationName!=='none'&&s.animationDuration.split(',').some(v=>parseFloat(v)>0))bad.push(e.tagName+':animation');if(s.transitionDuration.split(',').some(v=>parseFloat(v)>0))bad.push(e.tagName+':transition');}return bad;});}
    await check('系统减少动效实时切换，含伪元素无运行中动效',async()=>{await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(80);assert.equal(await page.locator('html').getAttribute('data-motion'),'reduced');assert.deepEqual(await noMotion(),[]);assert.equal(await page.locator('#page-styleguide').evaluate(e=>getComputedStyle(e).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForTimeout(50);assert.equal(await page.locator('html').getAttribute('data-motion'),'full');});
    await check('站内减少动画开关实际生效，持久化后重载仍有效',async()=>{await page.locator('#settingsBtn').click();await page.locator('label.toggle-switch').filter({has:page.locator('#reduceMotion')}).click();assert(await page.locator('#reduceMotion').isChecked());await page.waitForTimeout(50);assert.deepEqual(await noMotion(),[]);await page.reload();await page.locator('#page-styleguide.active').waitFor();assert.equal(await page.locator('html').getAttribute('data-motion'),'reduced');await page.locator('#settingsBtn').click();await page.locator('label.toggle-switch').filter({has:page.locator('#reduceMotion')}).click();await page.locator('#settingsClose').click();});
    await check('ECharts 懒加载后时长统一，减少动效与恢复保留主动禁用',async()=>{
      const result=await page.evaluate(async()=>{await EChartsLoaded.ensure();const node=document.createElement('div');node.style.cssText='width:300px;height:200px';document.body.append(node);const chart=echarts.init(node);chart.setOption({animation:false,xAxis:{data:['A','B']},yAxis:{},series:[{type:'bar',data:[1,2]}]});const before=chart.getOption();document.documentElement.dataset.reduceMotion='true';await new Promise(r=>setTimeout(r,40));const reduced=chart.getOption();delete document.documentElement.dataset.reduceMotion;await new Promise(r=>setTimeout(r,40));const full=chart.getOption();chart.dispose();node.remove();return {before:before.animationDuration,reduced:reduced.animationDuration,full:full.animationDuration,disabled:full.animation};});assert.deepEqual(result,{before:240,reduced:0,full:240,disabled:false});
    });
    await check('500行翻页真实渲染，无入场动画、延迟或遗留动画对象',async()=>{await page.goto(url+'/#memory');await page.locator('#allTableBody tr').nth(499).waitFor();assert.equal(await page.locator('#allTableBody tr').count(),500);await page.locator('#allNextBtn').click();await page.locator('#allTableBody tr').nth(499).waitFor();assert.match(await page.locator('#allTableBody').textContent(),/0501/);const bad=await page.locator('#allTableBody tr').evaluateAll(rows=>rows.filter(e=>{const s=getComputedStyle(e);return s.animationName!=='none'||s.animationDelay!=='0s'||e.getAnimations().length;}).length);assert.equal(bad,0);});
    await check('键盘焦点环可见',async()=>{await page.goto(url+'/#styleguide');await page.locator('#page-styleguide.active').waitFor();await page.locator('#sgNotify').focus();await page.keyboard.press('Tab');assert(await page.evaluate(()=>{const s=getComputedStyle(document.activeElement);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2;}));});
    const env={platform:process.platform,browser:browser.version(),playwright:require('playwright/package.json').version};
    const baselineMeta=path.join(baselineDir,'environment.json');
    if(update)fs.writeFileSync(baselineMeta,JSON.stringify(env,null,2));
    await check('视觉基准环境与固定浏览器版本一致',async()=>assert.deepEqual(JSON.parse(fs.readFileSync(baselineMeta,'utf8')),env));
    for(const theme of ['light','dark'])for(const width of [375,1440]){
      await check(`${theme} ${width}px 规范页、按钮状态及弹窗视觉基准`,async()=>{
        await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{localStorage.setItem('memoryos-settings',JSON.stringify({theme,fontSize:'medium',reduceMotion:true,pageSize:500}));},theme);await page.reload();await page.locator('#page-styleguide.active').waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(80);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        for(const s of ['#sgNotify','#sgOpenDialog','#sgInput']){const b=await page.locator(s).boundingBox();assert(Math.round(b.height)>=44,JSON.stringify({s,b}));}
        for(const state of ['page','dialog']){
          if(state==='dialog'){await page.setViewportSize({width,height:1000});await page.locator('#sgOpenDialog').click();}
          else {
            // 产品 body 是独立滚动容器；展开捕获视口，避免元素长截图的下半部分被祖先裁空。
            const height=await page.evaluate(()=>Math.ceil(document.body.scrollHeight)+20);
            await page.setViewportSize({width,height});await page.evaluate(()=>{document.body.scrollTop=0;scrollTo(0,0);});
          }
          const name=`styleguide-${theme}-${width}-${state}.png`,buf=await (state==='page'?page.locator('#page-styleguide'):page.locator('#sgDialog')).screenshot({animations:'disabled'}),target=path.join(baselineDir,name);
          fs.writeFileSync(path.join(actualDir,name),buf);if(update)fs.writeFileSync(target,buf);const result=compare(fs.readFileSync(target),buf);visual.push({name,changed:result.changed,total:result.total,ratio:result.ratio});if(result.changed)fs.writeFileSync(path.join(actualDir,name.replace('.png','-diff.png')),result.diff);assert(result.ratio<=.003&&result.changed<=200,`${name} 差异 ${result.changed} 像素 / ${(result.ratio*100).toFixed(3)}%，超过200像素或0.3%`);
          if(state==='dialog')await page.keyboard.press('Escape');
        }
      });
    }
    await check('真实按钮故意改色被视觉门禁拒绝',async()=>{const height=await page.evaluate(()=>Math.ceil(document.body.scrollHeight)+20);await page.setViewportSize({width:1440,height});await page.evaluate(()=>{document.body.scrollTop=0;scrollTo(0,0);});const style=await page.addStyleTag({content:'#sgNotify{background:#ff00ff!important}'});try{const buf=await page.locator('#page-styleguide').screenshot({animations:'disabled'});const result=compare(fs.readFileSync(path.join(baselineDir,'styleguide-dark-1440-page.png')),buf);assert(result.changed>200||result.ratio>.003);}finally{await style.evaluate(e=>e.remove());}});
    await check('规范页全部示例无 API 写入，页面异常为0',async()=>{assert.equal(state.writes.length,0);assert.deepEqual(errors,[]);});
    await context.close();
  } finally {await browser.close();await server.close();}
  const result={passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass).length,checks,visual,errors,productionWrites:0,baselineUpdated:update};
  fs.writeFileSync(path.join(__dirname,'p3-results.json'),JSON.stringify(result,null,2));console.log(`P3：${result.passed} 通过，${result.failed} 失败，errors=${JSON.stringify(errors)}`);if(result.failed)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
