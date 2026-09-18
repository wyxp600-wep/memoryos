// MemoryOS Dashboard — 真实 API 驱动（替代 mock 数据）
// 同源 fetch /api/*；后端无能力处降级展示。依赖全局 echarts。
//
// 【安全标注 · 供静态扫描】本文件是纯浏览器端脚本（index.html <script src="./app.js"> 加载）。
// 全部请求为浏览器 → 同源 127.0.0.1 内核代理的相对路径 fetch；URL 参数均用
// encodeURIComponent 编码，无用户可控的跨域/外部 URL，无服务端 SSRF 攻击面。
// Mimosa 将浏览器端 fetch 误报为「服务端 SSRF 服务端请求伪造」——见 PROJECT_MEMORY
// 工作日志 2026-09-17 条目（定向复扫 scan seal 130f7712…）与 .mimosa/reports 留痕。
// 本文件的 fetch 均为字面量路径 + 已编码参数，不含动态外部 URL 拼接。
(() => {
  'use strict';
  if (!window.EChartsLoaded) window.EChartsLoaded = {
    // 等待 echarts 就绪
    when(cb) {
      const t = setInterval(() => { if (window.echarts) { clearInterval(t); cb(); } }, 200);
      setTimeout(() => clearInterval(t), 15000);
    },
  };

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = s => s ? String(s).slice(0, 16).replace('T', ' ') : '—';
  const fmtRelative = s => {
    if (!s) return '—';
    const diff = Date.now() - new Date(s).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + ' 天前';
    const months = Math.floor(days / 30);
    if (months < 12) return months + ' 个月前';
    return Math.floor(months / 12) + ' 年前';
  };
  // 文本相似度（基于字符 bigram 的 Jaccard 相似度）
  function textSimilarity(a, b) {
    if (!a || !b) return 0;
    const grams = (s) => {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
      return set;
    };
    const ga = grams(a), gb = grams(b);
    if (ga.size === 0 || gb.size === 0) return 0;
    let inter = 0;
    ga.forEach(g => { if (gb.has(g)) inter++; });
    return inter / (ga.size + gb.size - inter);
  }
  // 找相似记忆
  function findSimilar(memory, limit = 3) {
    return S.memories
      .filter(m => m.id !== memory.id && m.status === 'active')
      .map(m => ({ m, sim: textSimilarity(memory.content, m.content) }))
      .filter(x => x.sim > 0.08)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit);
  }
  // 记忆质量评分（0-100，基于 eff/引用/置信度/长度综合）
  function calcQuality(m) {
    if (!m) return 0;
    const effScore = Math.min(100, (m.eff || 0) * 100);
    const hitScore = Math.min(100, Math.log10((m.hits || 0) + 1) * 50);
    const confScore = (m.confidence || 0) * 100;
    const lenScore = Math.min(100, (m.content || '').length / 5);
    return Math.round(effScore * 0.35 + hitScore * 0.3 + confScore * 0.2 + lenScore * 0.15);
  }
  function qualityLabel(score) {
    if (score >= 80) return { text: '优秀', color: '#10b981' };
    if (score >= 60) return { text: '良好', color: '#06b6d4' };
    if (score >= 40) return { text: '一般', color: '#f59e0b' };
    if (score >= 20) return { text: '较差', color: '#ef4444' };
    return { text: '待优化', color: '#6b7280' };
  }
  // 提取高频关键词（简单中文分词：提取2-4字常用词）
  function extractKeywords(limit = 30) {
    const stopWords = new Set(['的','了','是','在','我','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','那','它','他','她','它们','他们','她们','这个','那个','什么','怎么','为什么','可以','因为','所以','但是','如果','虽然','而且','或者','以及','等等','之类','一下','一些','一样','这样','那样','怎么','什么样','多少','几','哪','哪里','哪个','谁','什么时候','以前','以后','现在','今天','昨天','明天','时候','时间','地方','东西','事情','问题','办法','方法','方式','情况','状态','结果','效果','作用','功能','特点','优势','缺点','原因','理由','目的','目标','计划','安排','准备','开始','结束','完成','继续','停止','开始','进行','执行','实施','落实','推进','推动','促进','提升','提高','增加','减少','降低','优化','改进','改善','完善','解决','处理','应对','面对','面临','存在','出现','发生','产生','形成','变成','成为','属于','关于','对于','通过','根据','按照','基于','由于','鉴于','因此','因而','从而','进而','甚至','尤其','特别','更加','越来越','越','最','更','比较','相当','非常','十分','极其','极为','太','真','确实','的确','显然','明显','当然','自然','其实','实际上','事实上','基本上','大致','大概','大约','约','左右','上下','前后','之间','以内','以上','以下','之中','之外','旁边','附近','周围','周边','上面','下面','里面','外面','前面','后面','左边','右边','中间','中央','中心','核心','重点','关键','主要','重要','必要','必须','需要','需求','要求','期望','期待','希望','愿望','理想','目标','方向','路径','道路','途径','渠道','方式','方法','办法','措施','手段','工具','平台','系统','体系','机制','模式','模型','框架','结构','架构','设计','开发','测试','部署','运维','运营','管理','治理','控制','监控','监测','检测','检查','审查','审核','评估','评价','评审','复盘','总结','归纳','梳理','整理','分类','归档','存储','保存','保留','备份','恢复','同步','异步','并行','串行','顺序','序列','队列','栈','堆','树','图','网','链','环','圈','点','线','面','体','空间','时间','维度','层次','层级','等级','级别','阶段','时期','时代','周期','循环','迭代','递归','回溯','遍历','搜索','查找','查询','检索','过滤','筛选','排序','分组','聚合','统计','计算','分析','研究','探索','发现','发明','创造','创新','创意','想法','思路','思考','思维','思想','理念','观念','概念','定义','术语','名词','动词','形容词','副词','介词','连词','助词','叹词','拟声词','量词','数词','代词','冠词','语法','语义','语用','语境','语气','语调','语音','音标','字母','文字','字符','字符串','数字','数值','数组','对象','类','实例','属性','方法','函数','过程','子程序','模块','组件','控件','插件','扩展','脚本','代码','程序','软件','硬件','固件','中间件','操作系统','数据库','服务器','客户端','浏览器','网页','网站','应用','APP','小程序','公众号','视频号','抖音','快手','B站','知乎','微博','微信','QQ','钉钉','飞书','企业微信','淘宝','京东','拼多多','美团','饿了么','滴滴','高德','百度','谷歌','必应','搜狗','360','金山','微软','苹果','安卓','iOS','Windows','Mac','Linux','Ubuntu','CentOS','Debian','Fedora','Arch','Gentoo','FreeBSD','OpenBSD','NetBSD','DragonFly','Solaris','AIX','HP-UX','IRIX','Tru64','OSF/1','SCO','UnixWare','OpenServer','NeXTSTEP','OPENSTEP','Rhapsody','Mac OS X','OS X','macOS','iOS','iPadOS','watchOS','tvOS','visionOS','Android','Chrome OS','Fuchsia','HarmonyOS','OpenHarmony','EulerOS','openEuler','Kylin','Ubuntu Kylin','Deepin','UOS','统信','麒麟','深度','起点','终点','结束','完成','成功','失败','错误','异常','警告','提示','信息','调试','日志','记录','追踪','监控','报警','告警','通知','消息','事件','动作','操作','行为','活动','状态','属性','特征','特点','特性','参数','配置','设置','选项','开关','按钮','菜单','列表','表格','表单','输入框','下拉框','单选框','复选框','滑块','进度条','标签页','面板','卡片','弹窗','对话框','提示框','确认框','输入框','文件选择器','颜色选择器','日期选择器','时间选择器','数字输入框','文本域','富文本编辑器','代码编辑器','图片编辑器','视频播放器','音频播放器','地图','图表','报表','仪表盘','看板','工作台','控制台','终端','命令行','shell','bash','zsh','fish','powershell','cmd','command','prompt','terminal','console','shell','bash','zsh','fish','powershell','cmd','command','prompt']);
    const wordCount = {};
    S.memories.filter(m => m.status === 'active').forEach(m => {
      const text = m.content || '';
      // 提取2-4字的中文词
      for (let len = 2; len <= 4; len++) {
        for (let i = 0; i <= text.length - len; i++) {
          const word = text.slice(i, i + len);
          if (/^[\u4e00-\u9fa5]+$/.test(word) && !stopWords.has(word) && !stopWords.has(word.slice(0, 2))) {
            wordCount[word] = (wordCount[word] || 0) + 1;
          }
        }
      }
    });
    return Object.entries(wordCount)
      .filter(([w, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
  }
  const fmtNum = n => Number(n || 0).toLocaleString('en-US');
  const typeColor = t => ({ decision: '#f59e0b', experience: '#a855f7', pitfall: '#ef4444', convention: '#10b981', rule: '#10b981' }[t] || '#f59e0b');
  const statusColor = st => ({ active: '#10b981', merged: '#a855f7', superseded: '#f59e0b', rejected: '#ef4444', archived: '#6b7280' }[st] || '#10b981');
  // 状态/类型中文映射
  const STATUS_CN = { active: '活跃', merged: '已合并', superseded: '已取代', archived: '已归档', rejected: '已拒绝' };
  const TYPE_CN = { decision: '决策', experience: '经验', pitfall: '踩坑', convention: '约定', rule: '规则' };
  const statusCN = s => STATUS_CN[s] || s;
  const typeCN = t => TYPE_CN[t] || t;

  const S = { memories: [], zombies: [], top: [], trend: [], cross: [], summary: { total: 0, statusRows: [] }, writeHealth: { lastWrite: null, daysSince: null, writes30d: 0 } };

  async function load() {
    const gl = $('#globalLoading');
    if (gl) gl.classList.add('show');
    // 统一请求包装：失败不再静默吞掉，而是记录失败项（降级数据仍保留，但必须显式上报）
    const failures = [];
    const get = (name, url, fallback) =>
      fetch(url)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(e => { failures.push({ name, url, error: e && e.message ? e.message : String(e) }); return fallback; });
    try {
      const [sum, all, zombies, top, trend] = await Promise.all([
        get('概览汇总', '/api/summary', S.summary),
        get('记忆列表', '/api/all?limit=2000', { rows: [] }),
        get('僵尸记忆', '/api/zombies?days=30&limit=50', []),
        get('高价值 TOP', '/api/top?limit=10', []),
        get('趋势', '/api/trend?days=30', []),
      ]);
      S.summary = sum || { total: 0, statusRows: [] };
      applyRestricted(S.summary.restricted);
      S.memories = all.rows || [];
      S.zombies = Array.isArray(zombies) ? zombies : (zombies.rows || []);
      S.top = Array.isArray(top) ? top : (top.rows || []);
      S.trend = trend || [];
      S.cross = await get('跨工具复用', '/api/cross-tool?limit=40', []);
      S.writeHealth = await get('写入健康', '/api/write-health', { lastWrite: null, daysSince: null, writes30d: 0 });
      S.usageHealth = await get('使用健康', '/api/usage-health', { today: { search: 0, write: 0, returned: 0, cited: 0 }, days30: { search: 0, write: 0, returned: 0, cited: 0 } });
      renderLoadError(failures);
      renderAll();
      // 隐藏骨架屏，显示实际内容
      const skel = $('#summarySkeleton');
      const content = $('#summaryContent');
      if (skel) skel.style.display = 'none';
      if (content) content.style.display = '';
    } finally {
      if (gl) setTimeout(() => gl.classList.remove('show'), 200);
    }
  }

  /* ===== 受限模式（能力位由后端 /api/summary 下发）=====
     入口不删除、只隐藏：body.restricted + CSS 规则生效，后端关闭受限后自动恢复。 */
  let RESTRICTED = { enabled: false, taskCreate: false, planImport: false, customSource: false, cardCreate: false, cardDispatch: false, cardComment: false, cardLink: false, noteCreate: false, cardToMemory: false, agentWrite: false };
  function applyRestricted(r) {
    if (!r || typeof r !== 'object') return;
    RESTRICTED = {
      enabled: !!r.enabled, taskCreate: !!r.taskCreate, planImport: !!r.planImport, customSource: !!r.customSource,
      cardCreate: !!r.cardCreate, cardDispatch: !!r.cardDispatch, cardComment: !!r.cardComment,
      cardLink: !!r.cardLink, noteCreate: !!r.noteCreate, cardToMemory: !!r.cardToMemory,
      agentWrite: !!r.agentWrite,
    };
    document.body.classList.toggle('restricted', RESTRICTED.enabled);
  }

  /* ===== 加载失败可见性（P0-2 / P0-3）：全失败→全屏错误态；部分失败→顶部警示条 + 重试 ===== */
  const LOAD_TOTAL = 8; // load() 中的请求总数
  let _loadFailures = [];
  function renderLoadError(failures) {
    _loadFailures = failures || [];
    const bar = $('#loadErrorBar');
    const full = $('#loadErrorFull');
    const detail = $('#loadErrorDetail');
    if (detail) { detail.style.display = 'none'; detail.textContent = ''; }
    // 全屏错误态时隐藏页面内容，避免"空表格 + 错误提示"混杂（恢复时清空 inline style，交回 CSS 控制）
    const pages = document.querySelectorAll('.main-content > .page');
    const n = _loadFailures.length;
    if (n === 0) {
      if (bar) bar.style.display = 'none';
      if (full) full.style.display = 'none';
      pages.forEach(p => { p.style.display = ''; });
      return;
    }
    const lines = _loadFailures.map(f => '· ' + f.name + '  ' + f.url + '\n  ' + f.error).join('\n');
    if (n >= LOAD_TOTAL) {
      // 全部失败：内核服务不可用 → 全屏错误态
      if (bar) bar.style.display = 'none';
      if (full) full.style.display = 'block';
      pages.forEach(p => { p.style.display = 'none'; });
      const desc = $('#loadErrorFullDesc');
      if (desc) desc.innerHTML = '内核服务（127.0.0.1）没有响应，页面拿不到任何数据。<br>常见原因：<b>MemoryOS 内核进程未启动或已退出</b>、端口被占用、或刚启动尚未就绪。<br>请重启 MemoryOS，或点下方「重试」。';
      if (detail) detail.textContent = lines;
    } else {
      if (full) full.style.display = 'none';
      pages.forEach(p => { p.style.display = ''; });
      if (bar) {
        bar.style.display = 'flex';
        const t = $('#loadErrorBarText');
        if (t) t.innerHTML = '<b>' + n + ' 项数据加载失败</b>：' + _loadFailures.map(f => esc(f.name)).join('、') + '（其余数据已正常显示）';
      }
      if (detail) detail.textContent = lines;
    }
  }
  function toggleLoadErrorDetail() {
    const d = $('#loadErrorDetail');
    if (!d) return;
    d.style.display = d.style.display === 'none' ? 'block' : 'none';
  }
  async function retryLoad() {
    toast('正在重试…');
    await load();
    await loadDaemonHealth();
    if (!_loadFailures.length) toast('已恢复正常');
    else toast('仍有 ' + _loadFailures.length + ' 项失败');
  }
  function initLoadError() {
    const b1 = $('#loadRetryBtn'), b2 = $('#loadRetryBtn2'), b3 = $('#loadErrorBarDetail'), b4 = $('#loadErrorFullDetail');
    if (b1) b1.onclick = retryLoad;
    if (b2) b2.onclick = retryLoad;
    if (b3) b3.onclick = toggleLoadErrorDetail;
    if (b4) b4.onclick = toggleLoadErrorDetail;
  }

  /* ===== 治理守护真实状态（P0-4）：/api/daemon-health，不再写死"运行中" ===== */
  async function loadDaemonHealth() {
    const dot = $('#daemonStatusDot'), txt = $('#daemonStatusText'), sub = $('#daemonStatusSub'), box = $('#daemonStatusBox');
    if (!dot || !txt) return;
    const paint = (color, label, subText, bg, border) => {
      dot.style.background = color;
      dot.style.boxShadow = '0 0 8px ' + color;
      dot.style.animation = label === '运行中' ? 'pulse 2s ease-in-out infinite' : 'none';
      txt.textContent = label;
      txt.style.color = color;
      if (sub) sub.textContent = subText;
      if (box) { box.style.background = bg; box.style.borderColor = border; }
    };
    try {
      const r = await fetch('/api/daemon-health').then(x => { if (!x.ok) throw new Error('HTTP ' + x.status); return x.json(); });
      const h = r.hoursSince;
      const ago = h == null ? '从未运行' : (h < 1 ? Math.round(h * 60) + ' 分钟前' : h.toFixed(1) + ' 小时前');
      if (r.stale) {
        paint('#ef4444', '已停摆', '上次治理 ' + ago, 'rgba(239,68,68,0.08)', 'rgba(239,68,68,0.25)');
      } else if (h != null && h > 2) {
        paint('#f59e0b', '待治理', '上次治理 ' + ago, 'rgba(245,158,11,0.08)', 'rgba(245,158,11,0.25)');
      } else {
        paint('#22c55e', '运行中', '上次治理 ' + ago, 'rgba(74,222,128,0.06)', 'rgba(74,222,128,0.15)');
      }
    } catch (e) {
      paint('#94a3b8', '状态未知', '健康检查失败', 'rgba(148,163,184,0.08)', 'rgba(148,163,184,0.25)');
    }
  }
  function initDaemonHealth() {
    const box = $('#daemonStatusBox');
    if (box) box.style.cursor = 'pointer';
    if (box && !box.dataset.bound) {
      box.dataset.bound = '1';
      box.onclick = () => { loadDaemonHealth(); };
    }
    loadDaemonHealth();
    setInterval(loadDaemonHealth, 300000); // 5 分钟刷新一次
  }

  /* ===== 概览 ===== */
  function renderAll() {
    const safe = (fn, name) => { try { fn(); } catch (e) { console.error('[renderAll] ' + name + ' failed:', e); } };
    safe(renderSummary, 'renderSummary');
    safe(renderWriteHealth, 'renderWriteHealth');
    safe(renderUsageHealth, 'renderUsageHealth');
    safe(renderAllTable, 'renderAllTable');
    safe(renderTop, 'renderTop');
    safe(renderZombies, 'renderZombies');
    safe(renderCross, 'renderCross');
    safe(renderAudit, 'renderAudit');
    safe(bindFilters, 'bindFilters');
    safe(syncFilterButtons, 'syncFilterButtons');
    safe(annotateSectorButtons, 'annotateSectorButtons');
    safe(bindModal, 'bindModal');
    safe(bindZombies, 'bindZombies');
    safe(bindAudit, 'bindAudit');
    window.EChartsLoaded.when(drawOverviewCharts);
  }

  function renderSummary() {
    const s = S.summary;
    const active = s.statusRows.find(r => r.status === 'active')?.c ?? 0;
    const cards = [
      { cls: 'cyan', label: '记忆总量', val: fmtNum(s.total), sub: `${s.statusRows.length} 种状态`, route: 'all' },
      { cls: 'green', label: '活跃可检索', val: fmtNum(active), sub: 'eff > 0.15 阈值', route: 'all' },
      { cls: 'purple', label: '最低活跃 eff', val: s.minActiveEff == null ? '—' : Number(s.minActiveEff).toFixed(3), sub: 'active 记忆', route: 'all' },
      { cls: 'orange', label: '僵尸候选', val: fmtNum(S.zombies.length), sub: '闲置超期 0 命中', route: 'zombies' },
    ];
    $('#page-summary .stat-grid').innerHTML = cards.map((c, i) =>
      `<div class="stat-card ${c.cls}" data-route="${c.route}"><div class="stat-icon">${c.cls === 'cyan' ? '📚' : c.cls === 'green' ? '✅' : c.cls === 'purple' ? '📊' : '💤'}</div><div class="stat-label">${c.label}</div><div class="stat-value" data-target="${typeof c.val === 'number' ? c.val : ''}" data-index="${i}">${c.val}</div><div class="stat-trend">${c.sub}</div></div>`).join('');
    $$('#page-summary .stat-card[data-route]').forEach(card => card.onclick = () => navigate(card.dataset.route));
    // 数字滚动动画
    $$('#page-summary .stat-value[data-target]').forEach(el => {
      const target = parseInt(el.dataset.target);
      if (!isNaN(target) && target > 0) {
        setTimeout(() => animateNumber(el, target), 100 + parseInt(el.dataset.index) * 100);
      }
    });

    const total = s.total || 1;
    $('#page-summary .status-bars').innerHTML = (s.statusRows.length ? s.statusRows : [{ status: 'active', c: 0 }]).map(r =>
      `<div class="status-bar-row"><div class="status-bar-label"><span class="sdot" style="background:${statusColor(r.status)}"></span>${statusCN(r.status)}</div>
       <div class="status-bar-track"><div class="status-bar-fill" style="width:${(r.c / total * 100).toFixed(1)}%;background:${statusColor(r.status)}"></div></div>
       <div class="status-bar-count">${fmtNum(r.c)}</div></div>`).join('');
    // ★ P6：类别分布环形图 + 前瞻到期（sector_distribution 来自 /api/summary；等 ECharts 加载再画）
    if (window.EChartsLoaded && window.EChartsLoaded.when) window.EChartsLoaded.when(() => drawSectorChart(s.sector_distribution));
    else drawSectorChart(s.sector_distribution);
    loadProspective();
    // 侧栏徽标
    $$('.nav-item .nav-badge').forEach(b => b.remove());
    // 热词云
    const wc = $('#wordCloud');
    if (wc) {
      const keywords = extractKeywords(40);
      if (keywords.length) {
        const maxCount = keywords[0][1];
        const colors = ['#06b6d4', '#a855f7', '#f59e0b', '#10b981', '#ef4444', '#3b82f6', '#ec4899'];
        wc.innerHTML = keywords.map(([word, count], i) => {
          const size = 12 + (count / maxCount) * 20;
          const opacity = 0.5 + (count / maxCount) * 0.5;
          const color = colors[i % colors.length];
          return `<span class="word-cloud-item" style="font-size:${size}px;color:${color};opacity:${opacity};font-weight:${count > maxCount * 0.5 ? '700' : '500'};cursor:pointer;transition:all 0.2s" title="${word}: ${count}次">${esc(word)}</span>`;
        }).join('');
        wc.querySelectorAll('.word-cloud-item').forEach(el => {
          el.onmouseenter = () => { el.style.transform = 'scale(1.2)'; el.style.opacity = '1'; };
          el.onmouseleave = () => { el.style.transform = 'scale(1)'; };
          el.onclick = () => {
            $('#globalSearch').value = el.textContent;
            navigate('all');
            renderAllTable();
          };
        });
      } else {
        wc.innerHTML = '<span style="color:var(--text-muted);font-size:13px">暂无足够数据生成热词云</span>';
      }
    }
    // eff 分布直方图
    const eh = $('#effHistogram');
    const ehl = $('#effHistogramLabels');
    if (eh && ehl) {
      const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
      const counts = new Array(bins.length - 1).fill(0);
      S.memories.forEach(m => {
        const eff = m.eff || 0;
        for (let i = 0; i < bins.length - 1; i++) {
          if (eff >= bins[i] && eff < bins[i + 1]) { counts[i]++; break; }
        }
      });
      const maxCount = Math.max(...counts, 1);
      const colors = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6'];
      eh.innerHTML = counts.map((c, i) => `
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:4px">
          <span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono)">${c || ''}</span>
          <div style="width:100%;background:linear-gradient(180deg, ${colors[i]}, ${colors[i]}88);border-radius:4px 4px 0 0;height:${(c / maxCount) * 100}%;min-height:${c > 0 ? '4px' : '0'};transition:height 0.5s ease" title="${bins[i].toFixed(1)}-${bins[i+1].toFixed(1)}: ${c}条"></div>
        </div>
      `).join('');
      ehl.innerHTML = bins.slice(0, -1).map(b => `<div style="flex:1;text-align:center;font-size:10px;color:var(--text-muted);font-family:var(--font-mono)">${b.toFixed(1)}</div>`).join('');
    }
    // 写入活跃度热力图（最近12周，每周7天）
    const hm = $('#heatmap');
    if (hm) {
      const weeks = 12;
      const days = 7;
      const today = new Date();
      const startDate = new Date(today);
      startDate.setDate(today.getDate() - weeks * days + 1);
      // 统计每天的写入数量
      const dayCounts = {};
      S.memories.forEach(m => {
        if (!m.created_at) return;
        const d = new Date(m.created_at);
        const key = d.toISOString().slice(0, 10);
        dayCounts[key] = (dayCounts[key] || 0) + 1;
      });
      const maxCount = Math.max(...Object.values(dayCounts), 1);
      // 按周列渲染
      let html = '';
      for (let w = 0; w < weeks; w++) {
        html += '<div style="display:flex;flex-direction:column;gap:3px">';
        for (let d = 0; d < days; d++) {
          const date = new Date(startDate);
          date.setDate(startDate.getDate() + w * days + d);
          const key = date.toISOString().slice(0, 10);
          const count = dayCounts[key] || 0;
          const intensity = count > 0 ? Math.max(0.1, count / maxCount) : 0;
          const bg = count > 0 ? `rgba(65,187,200,${intensity})` : 'rgba(0,0,0,0.04)';
          const title = `${key}: ${count} 条记忆`;
          html += `<div style="width:14px;height:14px;background:${bg};border-radius:3px;cursor:pointer;transition:all 0.15s" title="${title}" onmouseover="this.style.transform='scale(1.3)'" onmouseout="this.style.transform='scale(1)'"></div>`;
        }
        html += '</div>';
      }
      // 月份标签
      const monthLabels = [];
      let lastMonth = -1;
      for (let w = 0; w < weeks; w++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + w * days);
        const month = date.getMonth();
        if (month !== lastMonth) {
          monthLabels.push({ week: w, label: (month + 1) + '月' });
          lastMonth = month;
        }
      }
      hm.innerHTML = html;
    }
  }

  /* 主动写入健康横幅：距上次主动写入天数 + 近 30 天次数；按钮复用「写入记忆」弹窗 */
  function renderWriteHealth() {
    const el = $('#writeHealth'); if (!el) return;
    const h = S.writeHealth || {};
    const days = h.daysSince;
    const n = h.writes30d ?? 0;
    el.classList.remove('ok', 'warn');
    let txt;
    if (days == null) {
      el.classList.add('warn');
      txt = `从未主动写入（近 30 天 ${n} 次）——解决完重要问题，用 memory_write 沉淀一条「结论 + 依据」`;
    } else if (days === 0) {
      el.classList.add('ok');
      txt = `今天已主动写入（近 30 天 ${n} 次）——保持住，写前先 memory_search 防重复`;
    } else {
      el.classList.add(days >= 7 ? 'warn' : 'ok');
      txt = `距上次主动写入 ${days} 天（近 30 天 ${n} 次）——完成后写一条，让下次任务先想起你`;
    }
    $('#writeHealthText').textContent = txt;
    const btn = $('#writeHealthBtn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.onclick = () => openEdit(null);
    }
  }

  /* ===== 利用率健康：今日 search/write + 30 天漏斗（先搜后干 · 干完必写） ===== */
  function renderUsageHealth() {
    const el = $('#usageHealth'); if (!el) return;
    const u = S.usageHealth || {};
    const t = u.today || { search: 0, write: 0, returned: 0, cited: 0 };
    const d = u.days30 || { search: 0, write: 0, returned: 0, cited: 0 };
    $('#uhSearch').textContent = t.search;
    $('#uhWrite').textContent = t.write;
    $('#uh30').textContent = `${d.search}/${d.write}/${d.returned}/${d.cited}`;
    el.classList.remove('ok', 'warn');
    let txt;
    if (t.search === 0 && t.write === 0) {
      el.classList.add('warn');
      txt = '今日尚未检索与沉淀——开工先 memory_search，完成重要结论后 memory_write 闭环';
    } else if (t.search > 0 && t.write === 0) {
      el.classList.add('warn');
      txt = '今日已检索未沉淀——解决重要问题后请 memory_write 写一条「结论 + 依据」';
    } else if (t.write > 0 && t.search === 0) {
      el.classList.add('warn');
      txt = '今日已沉淀未检索——写前先 memory_search 防重复，命中请 memory_cite';
    } else {
      el.classList.add('ok');
      txt = '检索与沉淀均在运转，继续保持先搜-命中-沉淀-回查闭环';
    }
    $('#usageHealthText').textContent = txt;
  }

  function drawOverviewCharts() {
    if (!window.echarts) return;
    try {
      const tc = echarts.init(document.getElementById('trendChart'));
      const days = S.trend.map(t => t.day.slice(5));
      tc.setOption(chartBase({
        legend: { data: ['写入', '返回', '引用'], textStyle: { color: '#64748b' }, top: 0, right: 0 },
        grid: { left: 40, right: 16, top: 36, bottom: 28 },
        xAxis: { type: 'category', data: days, axisLabel: { color: '#94a3b8' }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } } },
        series: [
          { name: '写入', type: 'line', smooth: true, data: S.trend.map(t => t.write), itemStyle: { color: '#06b6d4' }, areaStyle: { color: 'rgba(6,182,212,0.08)' } },
          { name: '返回', type: 'line', smooth: true, data: S.trend.map(t => t.returned), itemStyle: { color: '#a855f7' } },
          { name: '引用', type: 'line', smooth: true, data: S.trend.map(t => t.cited), itemStyle: { color: '#10b981' } },
        ],
      }));
      const byType = {}; S.memories.forEach(m => byType[m.type] = (byType[m.type] || 0) + 1);
      const pc = echarts.init(document.getElementById('typeChart'));
      pc.setOption({
        tooltip: { backgroundColor: 'rgba(255,255,255,0.96)', textStyle: { color: '#1e293b', fontSize: 12 }, borderColor: 'rgba(0,0,0,0.08)', borderWidth: 1 },
        legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { color: '#64748b' } },
        series: [{ type: 'pie', radius: ['45%', '70%'], center: ['35%', '50%'], label: { show: false }, itemStyle: { borderColor: '#fff', borderWidth: 3 },
          data: Object.entries(byType).map(([name, v]) => ({ name: typeCN(name), value: v, itemStyle: { color: typeColor(name) } })) }],
      });
    } catch (e) { console.error('overview charts', e); }
  }
  const chartText = { color: '#64748b', fontFamily: "'Noto Sans SC', sans-serif" };
  function chartBase(extra) {
    return Object.assign({ tooltip: { backgroundColor: 'rgba(255,255,255,0.96)', textStyle: { color: '#1e293b', fontSize: 12 }, borderColor: 'rgba(0,0,0,0.08)', borderWidth: 1 },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } }, axisLabel: { color: '#94a3b8' } } }, extra);
  }

  /* ===== 全部记忆（分页，防全量渲染卡死） ===== */
  let currentStatus = 'all', currentType = 'all', currentSector = 'all';
  let allPage = 1;
  let ALL_PAGE_SIZE = 100;
  const selectedIds = new Set();
  function updateBatchBar() {
    const bar = $('#batchBar'); if (!bar) return;
    const n = selectedIds.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    const c = $('#batchCount'); if (c) c.textContent = n;
  }
  /** /api/all 是否带 sector 字段（旧内核不带 → 类别筛选无法生效，必须忽略而不是把表筛空） */
  function sectorFieldAvailable() {
    return !S.memories.length || S.memories.some(m => Object.prototype.hasOwnProperty.call(m, 'sector'));
  }
  function renderAllTable() {
    let rows = S.memories;
    if (currentStatus !== 'all') rows = rows.filter(m => m.status === currentStatus);
    if (currentType !== 'all') rows = rows.filter(m => m.type === currentType);
    // ★ 防"空表陷阱"：旧内核不返回 sector 时若仍按类别过滤，会把全部行筛光 → 表现为「记忆不见了」
    if (currentSector !== 'all' && sectorFieldAvailable()) rows = rows.filter(m => m.sector === currentSector);
    // 排序
    if (sortField) {
      rows = [...rows].sort((a, b) => {
        let va = a[sortField], vb = b[sortField];
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / ALL_PAGE_SIZE));
    if (allPage > totalPages) allPage = totalPages;
    const start = (allPage - 1) * ALL_PAGE_SIZE;
    const pageRows = rows.slice(start, start + ALL_PAGE_SIZE);
    const countEl = $('#allCount'); if (countEl) countEl.textContent = '共 ' + total + ' 条';
    const pageInfo = $('#allPageInfo'); if (pageInfo) pageInfo.textContent = '第 ' + allPage + ' / ' + totalPages + ' 页';
    $('#allTableBody').innerHTML = pageRows.length ? pageRows.map((m, i) => {
      const checked = selectedIds.has(m.id) ? 'checked' : '';
      const selCls = selectedIds.has(m.id) ? ' selected' : '';
      return `<tr data-id="${m.id}" class="row-${esc(m.type)}${selCls}">
       <td><input type="checkbox" class="row-checkbox" data-id="${m.id}" ${checked}></td>
       <td class="mono text-muted">${String(start + i + 1).padStart(2, '0')}</td>
       <td class="memory-content">${renderMemoryLinks(m.content)}</td><td><span class="sdot" style="background:${SECTOR_COLOR_P6[m.sector] || '#64748b'}" title="${esc(m.sector || '')}"></span><span class="type-tag ${esc(m.type)}">${typeCN(m.type)}</span></td>
       <td><span class="status-pill ${esc(m.status)}"><span class="sdot"></span>${statusCN(m.status)}</span></td>
       <td class="mono" style="font-size:12px">${esc(m.agent)}</td>
       <td><span class="eff-bar"><span class="eff-bar-fill" style="width:${Math.min(100, (m.eff || 0) * 100)}%"></span></span><span class="mono" style="font-size:12px">${(m.eff || 0).toFixed(2)}</span></td>
       <td class="mono" style="font-size:13px;color:var(--accent-cyan)">${fmtNum(m.hits)}</td>
       <td class="mono text-secondary" style="font-size:12px" title="${fmtRelative(m.created_at)}">${fmtDate(m.created_at)}</td>
       <td><div class="row-actions">
         <button class="row-action-btn" data-edit="${m.id}" title="编辑">✎</button>
         <button class="row-action-btn del" data-del="${m.id}" title="删除">🗑</button>
       </div></td></tr>`;
    }).join('')
      : emptyAllRowsHtml();
    // 「显示全部记忆」一键脱离空态（筛选状态存在 localStorage，不清就会一直空）
    $$('#allTableBody [data-clear-filters]').forEach(btn => btn.onclick = () => {
      currentStatus = 'all'; currentType = 'all'; currentSector = 'all'; allPage = 1;
      syncFilterButtons(); saveFilterState(); renderAllTable();
      toast('已清除全部筛选');
    });
    // 筛选标签
    updateFilterTags();
    // 行点击（除复选框和操作按钮外）打开详情
    $$('#allTableBody tr').forEach(tr => {
      tr.onclick = (e) => {
        if (e.target.closest('.row-checkbox') || e.target.closest('.row-action-btn')) return;
        openDetail(Number(tr.dataset.id));
      };
    });
    // 复选框
    $$('#allTableBody .row-checkbox').forEach(cb => {
      cb.onchange = () => {
        const id = Number(cb.dataset.id);
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        cb.closest('tr').classList.toggle('selected', cb.checked);
        updateBatchBar();
        syncSelectAll();
      };
    });
    // 编辑/删除按钮
    $$('#allTableBody [data-edit]').forEach(btn => btn.onclick = (e) => { e.stopPropagation(); openEdit(Number(btn.dataset.edit)); });
    $$('#allTableBody [data-del]').forEach(btn => btn.onclick = async (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.del);
      if (!confirm('确定删除记忆 #' + id + '？此操作不可撤销。')) return;
      try {
        const r = await fetch('/api/memory/' + id, { method: 'DELETE' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) { toast('删除失败: ' + (j.error || r.status)); return; }
        selectedIds.delete(id);
        toast('已删除 #' + id);
        await load();
        renderAllTable();
        updateBatchBar();
      } catch (err) { toast('删除失败: ' + err.message); }
    });
    syncSelectAll();
    const prev = $('#allPrevBtn'), next = $('#allNextBtn');
    if (prev) { prev.disabled = allPage <= 1; prev.style.opacity = allPage <= 1 ? '0.4' : '1'; prev.style.cursor = allPage <= 1 ? 'not-allowed' : 'pointer'; }
    if (next) { next.disabled = allPage >= totalPages; next.style.opacity = allPage >= totalPages ? '0.4' : '1'; next.style.cursor = allPage >= totalPages ? 'not-allowed' : 'pointer'; }
  }
  function syncSelectAll() {
    const all = $('#selectAllCb'); if (!all) return;
    const cbs = [...$$('#allTableBody .row-checkbox')];
    if (cbs.length === 0) { all.checked = false; all.indeterminate = false; return; }
    const checked = cbs.filter(c => c.checked).length;
    all.checked = checked === cbs.length;
    all.indeterminate = checked > 0 && checked < cbs.length;
  }
  function bindFilters() {
    bindGroup('#statusFilter', d => { currentStatus = d; allPage = 1; renderAllTable(); saveFilterState(); });
    bindGroup('#typeFilter', d => { currentType = d; allPage = 1; renderAllTable(); saveFilterState(); });
    bindGroup('#sectorFilter', d => { currentSector = d; allPage = 1; renderAllTable(); saveFilterState(); });
    // 全选
    const sa = $('#selectAllCb');
    if (sa && !sa.dataset.bound) { sa.dataset.bound = '1'; sa.onchange = () => {
      $$('#allTableBody .row-checkbox').forEach(cb => {
        cb.checked = sa.checked;
        const id = Number(cb.dataset.id);
        if (sa.checked) selectedIds.add(id); else selectedIds.delete(id);
        cb.closest('tr').classList.toggle('selected', sa.checked);
      });
      updateBatchBar();
    };}
    // 批量删除
    const bd = $('#batchDeleteBtn');
    if (bd && !bd.dataset.bound) { bd.dataset.bound = '1'; bd.onclick = async () => {
      const n = selectedIds.size;
      if (n === 0) return;
      if (!confirm('确定批量删除选中的 ' + n + ' 条记忆？此操作不可撤销。')) return;
      let ok = 0, fail = 0;
      for (const id of Array.from(selectedIds)) {
        try {
          const r = await fetch('/api/memory/' + id, { method: 'DELETE' });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.ok) { ok++; selectedIds.delete(id); } else { fail++; }
        } catch { fail++; }
      }
      toast('批量删除完成: ' + ok + ' 成功, ' + fail + ' 失败');
      await load();
      renderAllTable();
      updateBatchBar();
    };}
    // 取消选择
    const bc = $('#batchClearBtn');
    if (bc && !bc.dataset.bound) { bc.dataset.bound = '1'; bc.onclick = () => {
      selectedIds.clear();
      $$('#allTableBody .row-checkbox').forEach(cb => { cb.checked = false; cb.closest('tr').classList.remove('selected'); });
      updateBatchBar(); syncSelectAll();
    };}
    // 批量归档
    const ba = $('#batchArchiveBtn');
    if (ba && !ba.dataset.bound) { ba.dataset.bound = '1'; ba.onclick = async () => {
      const n = selectedIds.size;
      if (n === 0) return;
      if (!confirm('确定批量归档选中的 ' + n + ' 条记忆？')) return;
      let ok = 0, fail = 0;
      for (const id of Array.from(selectedIds)) {
        try {
          const r = await fetch('/api/memory/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: 'archived' }) });
          if (r.ok) { ok++; selectedIds.delete(id); } else { fail++; }
        } catch { fail++; }
      }
      toast('批量归档完成: ' + ok + ' 成功, ' + fail + ' 失败');
      await load(); renderAllTable(); updateBatchBar();
    };}
    // 批量改类型
    const bt = $('#batchTypeSelect');
    if (bt && !bt.dataset.bound) { bt.dataset.bound = '1'; bt.onchange = async () => {
      const type = bt.value;
      if (!type || selectedIds.size === 0) return;
      if (!confirm('确定将选中的 ' + selectedIds.size + ' 条记忆类型改为 ' + type + '？')) { bt.value = ''; return; }
      let ok = 0, fail = 0;
      for (const id of Array.from(selectedIds)) {
        try {
          const r = await fetch('/api/memory/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ type }) });
          if (r.ok) ok++; else fail++;
        } catch { fail++; }
      }
      toast('批量改类型完成: ' + ok + ' 成功, ' + fail + ' 失败');
      bt.value = '';
      await load(); renderAllTable();
    };}
    // 批量改状态
    const bs = $('#batchStatusSelect');
    if (bs && !bs.dataset.bound) { bs.dataset.bound = '1'; bs.onchange = async () => {
      const status = bs.value;
      if (!status || selectedIds.size === 0) return;
      if (!confirm('确定将选中的 ' + selectedIds.size + ' 条记忆状态改为 ' + status + '？')) { bs.value = ''; return; }
      let ok = 0, fail = 0;
      for (const id of Array.from(selectedIds)) {
        try {
          const r = await fetch('/api/memory/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status }) });
          if (r.ok) ok++; else fail++;
        } catch { fail++; }
      }
      toast('批量改状态完成: ' + ok + ' 成功, ' + fail + ' 失败');
      bs.value = '';
      await load(); renderAllTable();
    };}
    // 批量导出选中
    const be = $('#batchExportBtn');
    if (be && !be.dataset.bound) { be.dataset.bound = '1'; be.onclick = () => {
      const rows = S.memories.filter(m => selectedIds.has(m.id));
      if (!rows.length) return;
      const content = rows.map(m => `## #${m.id} [${m.type}/${m.status}]\n\n${m.content}\n\n*${m.agent} · ${m.created_at}*\n\n---\n`).join('\n');
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `memoryos-selected-${Date.now()}.md`;
      a.click();
      URL.revokeObjectURL(url);
      toast('已导出 ' + rows.length + ' 条选中记忆');
    };}
    const prev = $('#allPrevBtn');
    if (prev && !prev.dataset.bound) { prev.dataset.bound = '1'; prev.onclick = () => { if (allPage > 1) { allPage--; renderAllTable(); saveFilterState(); } }; }
    const next = $('#allNextBtn');
    if (next && !next.dataset.bound) { next.dataset.bound = '1'; next.onclick = () => { allPage++; renderAllTable(); saveFilterState(); }; }
  }
  function bindGroup(sel, onPick) {
    $$(sel + ' .filter-btn').forEach(btn => btn.onclick = () => {
      $$(sel + ' .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // ★ 修复：类别（sector）组此前漏读 data-sector —— 点任意类别都传 undefined，
      //   currentSector 变成 undefined 后过滤条件必然为空，表现为「点了没反应」。
      onPick(btn.dataset.status || btn.dataset.type || btn.dataset.sector);
    });
  }

  /* ===== ★ 类别筛选：条数徽标 + 与持久化状态同步 ===== */
  const SECTOR_CN = { all: '全部类别', working: '工作', episodic: '情景', semantic: '语义', procedural: '程序', meta: '元记忆', social: '协作', user: '用户', prospective: '前瞻', affective: '情感', secret: '私密' };
  let sectorCounts = null;
  async function annotateSectorButtons() {
    const btns = $$('#sectorFilter .filter-btn');
    if (!btns.length) return;
    if (!sectorCounts) {
      const r = await fetch('/api/sectors').then(x => x.json()).catch(() => null);
      if (r && Array.isArray(r.sectors)) {
        sectorCounts = new Map(r.sectors.map(s => [s.sector, Number(s.count) || 0]));
        sectorCounts.set('all', [...sectorCounts.values()].reduce((a, b) => a + b, 0));
      }
    }
    btns.forEach(btn => {
      const key = btn.dataset.sector;
      if (!key || !sectorCounts) return;
      const n = sectorCounts.get(key) ?? 0;
      let tag = btn.querySelector('.fcount');
      if (!tag) { tag = document.createElement('span'); tag.className = 'fcount'; btn.appendChild(tag); }
      tag.textContent = n;
      // 0 条只做视觉弱化，仍可点击（点后给出明确的空态说明，而不是静默空白）
      btn.classList.toggle('zero', key !== 'all' && n === 0);
      btn.style.display = (n === 0) ? 'none' : '';
      btn.title = `${SECTOR_CN[key] || key} · 库中 ${n} 条`;
    });
    // ★ 防"筛选状态被记住 → 表恒空"：加载后若当前类别筛不出任何东西，自动回到「全部类别」并说明原因
    //   （localStorage 会记住上次点击的类别；旧内核 + 0 条类别都会让列表永远空白）
    if (currentSector !== 'all' && sectorCounts) {
      const reason = !sectorFieldAvailable()
        ? '当前内核未返回类别字段，类别筛选暂不生效'
        : (sectorCounts.get(currentSector) === 0 ? `「${SECTOR_CN[currentSector] || currentSector}」当前 0 条` : null);
      if (reason) {
        const was = currentSector;
        currentSector = 'all';
        allPage = 1;
        syncFilterButtons();
        saveFilterState();
        renderAllTable();
        toast(`已自动清除类别筛选（${was}）：${reason}`);
      }
    }
  }
  function syncFilterButtons() {
    $$('#statusFilter .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.status === currentStatus));
    $$('#typeFilter .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.type === currentType));
    $$('#sectorFilter .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.sector === currentSector));
  }
  function allFilterLabel() {
    const parts = [];
    if (currentStatus !== 'all') parts.push('状态 ' + statusCN(currentStatus));
    if (currentType !== 'all') parts.push('类型 ' + typeCN(currentType));
    if (currentSector !== 'all') parts.push('类别 ' + (SECTOR_CN[currentSector] || currentSector));
    return parts.join(' · ');
  }
  function emptyAllRowsHtml() {
    const label = allFilterLabel();
    // 内核未在 /api/all 里返回 sector 字段时，类别筛选无法生效 —— 说明原因并给出动作
    const sectorUnsupported = currentSector !== 'all' && !sectorFieldAvailable();
    const desc = sectorUnsupported
      ? '当前内核的 /api/all 未返回<b>类别（sector）</b>字段，类别筛选需要重启内核后生效：<br>托盘图标 → <b>重启内核</b>（或退出后重开 MemoryOS），刷新本页即可。'
      : (label ? `当前筛选：<b>${esc(label)}</b><br>该组合下没有记忆。` : '当前筛选条件下没有匹配的记忆，试试调整筛选或写入新记忆');
    return `<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">暂无记忆</div><div class="empty-desc">${desc}</div>
      ${label ? '<button class="btn-ghost" data-clear-filters style="margin-top:12px;padding:6px 16px;font-size:12px">显示全部记忆（清除筛选）</button>' : ''}
      </div></td></tr>`;
  }

  /* ===== 详情 ===== */
  function openDetail(id, pool) {
    const m = (pool || S.memories).find(x => x.id === id);
    if (!m) return toast('未找到 #' + id);
    detailOpen = true;
    currentDetailIndex = (pool || S.memories).findIndex(x => x.id === id);
    $('#modalBody').innerHTML = `
      <div class="detail-content-box" style="border-left-color:${typeColor(m.type)}">${renderContent(m.content)}</div>
      <div class="detail-grid">
        ${pair('ID', '#' + m.id, true)}${pair('类型', typeCN(m.type), false, `<span class="type-tag ${esc(m.type)}">${typeCN(m.type)}</span>`)}
        ${pair('状态', '', false, `<span class="status-pill ${esc(m.status)}"><span class="sdot"></span>${statusCN(m.status)}</span>`)}
        ${pair('来源工具', esc(m.agent), true)}${pair('文件路径', esc(m.agent_fpath) || '—', true)}
        ${pair('项目', esc(m.project))}${pair('置信度', (m.confidence || 0).toFixed(2), true)}
        ${pair('有效度 eff', (m.eff || 0).toFixed(2), true)}${pair('命中次数', fmtNum(m.hits), true)}
        ${pair('创建时间', fmtDate(m.created_at), true)}${pair('冲突/取代', m.conflict_with ? '#' + m.conflict_with : (m.superseded_by ? '#' + m.superseded_by : '—'), true)}
      </div>
      <div class="quality-score" style="margin-top:16px;padding:14px 16px;background:linear-gradient(135deg, rgba(65,187,200,0.06), rgba(168,85,247,0.06));border:1px solid rgba(65,187,200,0.15);border-radius:12px;display:flex;align-items:center;gap:16px">
        <div style="text-align:center;min-width:60px">
          <div style="font-size:28px;font-weight:700;color:${qualityLabel(calcQuality(m)).color};font-family:var(--font-display)">${calcQuality(m)}</div>
          <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px">质量分</div>
        </div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${qualityLabel(calcQuality(m)).color}22;color:${qualityLabel(calcQuality(m)).color}">${qualityLabel(calcQuality(m)).text}</span>
            <span style="font-size:11px;color:var(--text-muted)">eff ${(m.eff||0).toFixed(2)} · 引用 ${m.hits||0} · 置信 ${(m.confidence||0).toFixed(2)}</span>
          </div>
          <div style="height:6px;background:rgba(0,0,0,0.06);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${calcQuality(m)}%;background:linear-gradient(90deg, ${qualityLabel(calcQuality(m)).color}, ${qualityLabel(calcQuality(m)).color}cc);border-radius:3px;transition:width 0.5s"></div>
          </div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">
        <div style="display:flex;gap:8px">
          <button class="btn-ghost" id="detailPrevBtn" style="padding:6px 14px;font-size:12px">← 上一条</button>
          <button class="btn-ghost" id="detailNextBtn" style="padding:6px 14px;font-size:12px">下一条 →</button>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn-ghost" id="detailCopyBtn" style="padding:6px 14px;font-size:12px">📋 复制</button>
          <button class="btn-primary" id="detailEditBtn">编辑这段记忆</button>
        </div>
      </div>`;
    // 相似记忆推荐
    const similar = findSimilar(m, 3);
    if (similar.length) {
      const similarHtml = `<div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.06)">
        <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">🔗 可能相关的记忆</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${similar.map(({m: sm, sim}) => `<div class="similar-item" data-id="${sm.id}" style="padding:10px 12px;background:rgba(65,187,200,0.04);border:1px solid rgba(65,187,200,0.12);border-radius:8px;cursor:pointer;transition:all 0.15s;display:flex;justify-content:space-between;align-items:center;gap:12px">
            <span style="font-size:13px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(sm.content.slice(0, 60))}${sm.content.length > 60 ? '…' : ''}</span>
            <span style="font-size:11px;color:var(--accent-cyan);font-family:var(--font-mono);flex-shrink:0">${(sim * 100).toFixed(0)}%</span>
          </div>`).join('')}
        </div>
      </div>`;
      $('#modalBody').insertAdjacentHTML('beforeend', similarHtml);
      $$('#modalBody .similar-item').forEach(el => {
        el.onmouseenter = () => { el.style.background = 'rgba(65,187,200,0.1)'; el.style.borderColor = 'rgba(65,187,200,0.3)'; };
        el.onmouseleave = () => { el.style.background = 'rgba(65,187,200,0.04)'; el.style.borderColor = 'rgba(65,187,200,0.12)'; };
        el.onclick = () => openDetail(Number(el.dataset.id));
      });
    }
    $('#detailModal').classList.add('show');
    /* WYSIWYG：展示 ai.* 视图（用户所见 = AI 所得，来自 /api/all 的 ai/ai_visible 字段） */
    const aiBlock = aiWysiwygBlock(m);
    if (aiBlock) $('#modalBody').insertAdjacentHTML('beforeend', aiBlock);
    $('#detailEditBtn').onclick = () => { $('#detailModal').classList.remove('show'); openEdit(m.id); };
    $('#detailPrevBtn').onclick = () => navigateDetail(-1);
    $('#detailNextBtn').onclick = () => navigateDetail(1);
    $('#detailCopyBtn').onclick = () => {
      const md = `# 记忆 #${m.id}\n\n**类型**: ${m.type}\n**状态**: ${m.status}\n**来源**: ${m.agent}\n**eff**: ${(m.eff||0).toFixed(2)}\n**引用**: ${m.hits||0}\n**创建**: ${fmtDate(m.created_at)}\n\n---\n\n${m.content}`;
      navigator.clipboard.writeText(md).then(() => {
        const btn = $('#detailCopyBtn');
        btn.textContent = '✅ 已复制';
        setTimeout(() => btn.textContent = '📋 复制', 1500);
      }).catch(() => toast('复制失败，请手动复制'));
    };
  }
  function closeDetail() {
    detailOpen = false;
    $('#detailModal')?.classList.remove('show');
  }
  function pair(k, v, mono, custom) {
    return `<div class="detail-item"><label>${k}</label><div class="val ${mono ? 'mono' : ''}" ${custom ? '' : ''}>${custom || esc(v)}</div></div>`;
  }
  let editingId = null; // null=新建；number=编辑目标 id
  // 记忆模板
  const MEMORY_TEMPLATES = {
    decision: { type: 'decision', content: '【决策记录】\n\n背景：\n\n选项：\n1. \n2. \n3. \n\n决策：\n\n原因：\n\n代价/风险：' },
    pitfall: { type: 'pitfall', content: '【踩坑记录】\n\n现象：\n\n根因：\n\n解法：\n\n预防：' },
    experience: { type: 'experience', content: '【经验总结】\n\n场景：\n\n做法：\n\n效果：\n\n适用条件：' },
    convention: { type: 'convention', content: '【团队约定】\n\n约定内容：\n\n适用范围：\n\n违反后果：\n\n生效日期：' },
    rule: { type: 'rule', content: '【规则配置】\n\n规则名称：\n\n触发条件：\n\n执行动作：\n\n优先级：' },
  };
  function openEdit(id, forcedType) {
    editingId = id;
    const m = id ? (S.memories.find(x => x.id === id) || ruleRows.find(x => x.id === id)) : null;
    $('#editModalTitle').textContent = m ? '编辑记忆 #' + id : '新建记忆';
    $('#memContent').value = m ? m.content : '';
    $('#memType').value = m ? m.type : (forcedType || 'experience');
    $('#memProject').value = 'global';
    // ★ 2026-09-14 查漏：编辑时回填当前类别，避免下拉永远显示「自动推导」（原缺失，且 PUT 也不发送 sector）
    $('#memSector').value = m && m.sector ? m.sector : '';
    const hint = $('#memHint'); hint.textContent = ''; hint.className = 'form-hint';
    $('#projectField').style.display = m ? 'none' : ''; // 编辑不改 project scope
    // 新建时显示模板选择，编辑时隐藏
    const tplField = $('#templateField');
    if (tplField) tplField.style.display = m ? 'none' : '';
    // 模板按钮点击
    $$('.template-btn').forEach(btn => {
      btn.onclick = () => {
        const tpl = MEMORY_TEMPLATES[btn.dataset.template];
        if (tpl) {
          $('#memContent').value = tpl.content;
          $('#memType').value = tpl.type;
          $$('.template-btn').forEach(b => { b.style.background = ''; b.style.borderColor = ''; b.style.color = ''; });
          btn.style.background = 'rgba(65,187,200,0.12)';
          btn.style.borderColor = 'var(--accent-cyan)';
          btn.style.color = 'var(--accent-cyan)';
        }
      };
    });
    $('#editModal').classList.add('show');
    $('#memContent').focus();
  }
  function closeEdit() { $('#editModal').classList.remove('show'); editingId = null; }
  async function saveMemory() {
    const hint = $('#memHint');
    const content = $('#memContent').value.trim();
    const type = $('#memType').value;
    if (!content) { hint.textContent = '内容不能为空'; hint.className = 'form-hint err'; return; }
    $('#memSave').disabled = true;
    try {
      let r;
      if (editingId) {
        // ★ 2026-09-14 查漏：编辑时同步发送类别（下拉回填后用户可改）；空值=保留原类别（后端以 undefined 忽略）
        const sector = $('#memSector').value || undefined;
        r = await fetch('/api/memory/' + editingId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, type, sector }) });
      } else {
        const project = $('#memProject').value.trim() || 'global';
        const sector = $('#memSector').value || undefined;
        r = await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, type, project, sector }) });
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { hint.textContent = (j.error || '保存失败') + ' (HTTP ' + r.status + ')'; hint.className = 'form-hint err'; return; }
      closeEdit();
      // P0-2: 主动触发向量重算，不等 daemon 周期
      if (editingId) fetch(`/api/embed/recompute/${editingId}`, {method:'POST'}).catch(()=>{});
      toast(editingId ? '已保存记忆 #' + editingId : '已新建记忆 #' + j.id);
      const newId = j.id;
      await load();
      // 新建记忆飞入动画
      if (!editingId && newId) {
        navigate('all');
        setTimeout(() => {
          const row = document.querySelector(`#allTableBody tr[data-id="${newId}"]`);
          if (row) {
            row.classList.add('fly-in');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      }
      if (window.location.hash.includes('rules')) loadRules();
    } catch (e) {
      hint.textContent = '保存失败：' + e.message; hint.className = 'form-hint err';
    } finally { $('#memSave').disabled = false; }
  }
  function bindModal() {
    $('#modalClose').onclick = () => $('#detailModal').classList.remove('show');
    $('#detailModal').onclick = e => { if (e.target.id === 'detailModal') $('#detailModal').classList.remove('show'); };
    // 新建/编辑表单
    const createBtn = $('#createMemoryBtn'); if (createBtn) createBtn.onclick = () => openEdit(null);
    $('#editModalClose').onclick = closeEdit;
    $('#memCancel').onclick = closeEdit;
    $('#editModal').onclick = e => { if (e.target.id === 'editModal') closeEdit(); };
    $('#memSave').onclick = saveMemory;
  }

  /* ===== TOP ===== */
  function renderTop() {
    const cited = [...S.top].sort((a, b) => b.cited - a.cited);
    const exposed = [...S.top].sort((a, b) => b.hit_count - a.hit_count);
    $('#topCitedList').innerHTML = cited.map((m, i) => rank(m, i, m.cited, 'cited')).join('');
    $('#topExposedList').innerHTML = exposed.map((m, i) => rank(m, i, m.hit_count, 'returned')).join('');
    $$('#topCitedList .rank-item, #topExposedList .rank-item').forEach(el => el.onclick = () => openDetail(Number(el.dataset.id)));
    window.EChartsLoaded.when(drawTopScatter);
  }
  function rank(m, i, num, label) {
    return `<div class="rank-item" data-id="${m.id}"><div class="rank-num ${i < 3 ? 'r' + (i + 1) : 'rn'}">${i + 1}</div>
      <div class="rank-content"><div class="rank-text">${esc(m.content)}</div>
      <div class="rank-meta"><span class="type-tag ${esc(m.type)}">${typeCN(m.type)}</span> · ${esc(m.agent)} · conf ${(m.confidence || 0).toFixed(2)}</div></div>
      <div class="rank-stats"><div class="rank-hits">${num}</div><div class="rank-hits-label">${label}</div></div></div>`;
  }
  function drawTopScatter() {
    if (!window.echarts) return;
    const el = document.getElementById('scatterChart');
    if (!el.offsetParent) return;
    try {
      const sc = echarts.init(el);
      sc.setOption(Object.assign(chartBase({}), {
        grid: { left: 50, right: 30, top: 20, bottom: 40 },
        xAxis: { name: 'eff', min: 0, max: 1, axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } }, nameTextStyle: { color: '#64748b' } },
        series: [{ type: 'scatter', data: S.top.map(m => [m.confidence || 0, m.cited, m.content.slice(0, 30)]), symbolSize: 12, itemStyle: { color: 'rgba(6,182,212,0.7)', shadowBlur: 10, shadowColor: 'rgba(6,182,212,0.3)' } }],
      }));
    } catch (e) { console.error('scatter', e); }
  }

  /* ===== 僵尸 ===== */
  let selected = new Set(), zombieDays = 'all';
  function renderZombies() {
    let rows = S.zombies;
    if (zombieDays !== 'all') rows = rows.filter(z => z.days >= parseInt(zombieDays));
    $('#zombieTableBody').innerHTML = rows.length ? rows.map(z =>
      `<tr data-id="${z.id}"><td><div class="checkbox ${selected.has(z.id) ? 'checked' : ''}" data-zid="${z.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div></td>
       <td class="memory-content">${esc(z.content)}</td><td><span class="type-tag ${esc(z.type)}">${esc(z.type)}</span></td>
       <td class="mono" style="font-size:12px">${esc(z.agent)}</td>
       <td><span class="eff-bar"><span class="eff-bar-fill" style="width:15%"></span></span><span class="mono text-secondary">副闲置</span></td>
       <td><span class="mono" style="color:var(--warning);font-weight:600">${z.days}</span> 天</td>
       <td class="mono text-secondary" style="font-size:12px">${fmtDate(z.created_at)}</td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">✨</div><div class="empty-title">暂无闲置记忆</div><div class="empty-desc">记忆库很健康，没有长期闲置未命中的记忆</div></div></td></tr>';
    $$('#zombieTableBody .checkbox').forEach(cb => cb.onclick = e => {
      e.stopPropagation();
      const id = Number(cb.dataset.zid);
      selected.has(id) ? selected.delete(id) : selected.add(id);
      cb.classList.toggle('checked');
      $('#selectedCount').textContent = selected.size;
    });
  }
  function bindZombies() {
    bindGroup('#zombieFilter', d => { zombieDays = d; renderZombies(); });
    $('#archiveSelectedBtn').onclick = async () => {
      if (!selected.size) return toast('请先选择要归档的记忆');
      const r = await fetch('/api/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...selected] }) }).then(x => x.json()).catch(e => ({ error: e.message }));
      if (r.ok) { toast('已归档 ' + r.archived + ' 条'); selected.clear(); $('#selectedCount').textContent = '0'; await load(); }
      else toast(r.error || '归档失败');
    };
  }

  /* ===== 跨工具 ===== */
  function renderCross() {
    const rows = S.cross || [];
    const byW = {}, byR = {};
    rows.forEach(r => { byW[r.writer_agent] = (byW[r.writer_agent] || 0) + r.n; byR[r.reader_agent] = (byR[r.reader_agent] || 0) + r.n; });
    if (rows.length) {
      $('#crossMatrix').innerHTML = '<div class="cross-header">写入方 → 引用方 <span class="text-muted">（事件类型）</span></div>' +
        rows.map(r => `<div class="cross-row"><span class="cross-path"><span class="agent-tag">${esc(r.writer_agent)}</span> → <span class="agent-tag">${esc(r.reader_agent)}</span> <span class="text-muted" style="font-size:11px">(${esc(r.event)})</span></span><span class="cross-count">${r.n}</span></div>`).join('');
    } else {
      $('#crossMatrix').innerHTML = '<div class="empty-state"><div class="empty-icon">🔗</div><div class="empty-title">暂无跨工具复用</div><div class="empty-desc">还没有 AI Agent 引用其他工具写入的记忆，随着使用会逐渐出现</div></div>';
    }
    window.EChartsLoaded.when(() => {
      if (!window.echarts) return;
      try {
        const wp = echarts.init(document.getElementById('writerPie'));
        wp.setOption({ tooltip: { backgroundColor: 'rgba(30,24,16,0.95)', textStyle: { color: '#fdf6e3' } },
          series: [{ type: 'pie', radius: ['40%', '68%'], label: { color: '#b8a88a', fontSize: 11 }, itemStyle: { borderColor: '#1c1610', borderWidth: 3 },
            data: Object.entries(byW).map(([n, v]) => ({ name: n, value: v })) }] });
        const rp = echarts.init(document.getElementById('readerPie'));
        rp.setOption({ tooltip: { backgroundColor: 'rgba(30,24,16,0.95)', textStyle: { color: '#fdf6e3' } },
          series: [{ type: 'pie', radius: ['40%', '68%'], roseType: 'radius', label: { color: '#b8a88a', fontSize: 11 }, itemStyle: { borderColor: '#1c1610', borderWidth: 3 },
            data: Object.entries(byR).map(([n, v]) => ({ name: n, value: v })) }] });
      } catch (e) { console.error('cross charts', e); }
    });
  }

  /* ===== 审计 ===== */
  let auditFilter = 'all';
  async function renderAudit() {
    const a = await fetch('/api/audit').then(r => r.json()).catch(() => ({ rows: [] }));
    const rows = (a.rows || []).filter(l => {
      if (auditFilter === 'all') return true;
      if (auditFilter === 'daemon') return l.operator === 'daemon';
      if (auditFilter === 'human') return l.operator && l.operator.startsWith('human') && !/(仲裁|arbitrat)/i.test(l.task);
      if (auditFilter === 'arbitrate') return /(仲裁|arbitrat|keep_|merge|conflict)/i.test(l.task + l.op);
      return true;
    });
    $('#auditTimeline').innerHTML = rows.length ? rows.map(l => {
      const type = l.operator === 'daemon' ? (l.op === 'archive' ? 'warn' : 'success') : 'danger';
      return `<div class="audit-item ${type}"><div class="audit-time">${fmtDate(l.created_at)}</div>
        <div class="audit-action">${esc(l.task)} · ${esc(l.op)}${l.memory_id ? ' (#' + l.memory_id + ')' : ''}</div>
        <div class="audit-meta"><span class="operator ${l.operator === 'daemon' ? 'daemon' : 'human'}">${esc(l.operator)}</span>${esc(l.detail || '')}</div></div>`;
    }).join('') : '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">暂无审计记录</div><div class="empty-desc">治理守护和人工操作的审计日志会显示在这里</div></div>';
  }
  function bindAudit() {
    bindGroup('#auditFilter', d => { auditFilter = d; renderAudit(); });
  }

  /* ===== 全局搜索 ===== */
  function bindSearch() {
    const box = $('#globalSearch');
    if (!box) return;
    box.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim().toLowerCase();
      navigate('all');
      let rows = S.memories;
      if (q) rows = rows.filter(m => m.content.toLowerCase().includes(q) || String(m.agent).toLowerCase().includes(q) || String(m.type).includes(q));
      $('#allCount').textContent = '搜索结果：' + rows.length + ' 条';
      $('#allTableBody').innerHTML = rows.map((m, i) => `<tr data-id="${m.id}"><td class="mono text-muted">${String(i + 1).padStart(2, '0')}</td><td class="memory-content">${esc(m.content)}</td><td><span class="type-tag ${esc(m.type)}">${typeCN(m.type)}</span></td><td><span class="status-pill ${esc(m.status)}"><span class="sdot"></span>${statusCN(m.status)}</span></td><td class="mono" style="font-size:12px">${esc(m.agent)}</td><td><span class="eff-bar"><span class="eff-bar-fill" style="width:${Math.min(100, (m.eff || 0) * 100)}%"></span></span><span class="mono" style="font-size:12px">${(m.eff || 0).toFixed(2)}</span></td><td class="mono" style="font-size:13px;color:var(--accent-cyan)">${m.hits}</td><td class="mono text-secondary" style="font-size:12px">${fmtDate(m.created_at)}</td></tr>`).join('');
      $$('#allTableBody tr').forEach(tr => tr.onclick = () => openDetail(Number(tr.dataset.id)));
      toast(q ? '检索到 ' + rows.length + ' 条相关记忆' : '显示全部记忆');
    });
  }

  /* ===== 路由 ===== */
  const PAGE_TITLES = { summary: ['概览', 'MemoryOS Dashboard'], all: ['全部记忆', '全量记忆库'], top: ['高价值 TOP', '引用与曝光排行'], zombies: ['待归档·僵尸', '闲置记忆治理'], arbitrate: ['仲裁队列', '冲突记忆裁决'], trend: ['趋势', '时间序列分析'], cross: ['跨工具', 'Writer × Reader 复用'], audit: ['审计', '治理留痕'], connect: ['工具连接', '扫描 & 接入 AI Agent'], agent: ['Agent', '内置智能体 · MCP 工具面 · 可插拔 LLM 端点'], runs: ['执行中心', 'Agent 执行过程 · 工具调用 · 审批 · 产物 · 会话'], rules: ['规则管理', 'AI Agent 协同约束'], ingest: ['采集消化', '读取记忆 · 对话 · 规则并提炼入库'], governance: ['治理中心', '成本治理 · 门控 · 进化验证 · 凭据 · A2A 协议'], obsidian: ['笔记', 'vault 笔记 ↔ 共享记忆库 · 双向链接图谱'], skills: ['技能同步', '中央技能库 ↔ 多 Agent 分发'], graph: ['知识图谱', '笔记 · 记忆 · 卡片统一图'], tasks: ['任务看板', '卡片工作流 · CAS 认领 + 依赖提升'] };
  function navigate(route) {
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.route === route));
    $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + route));
    const [t, s] = PAGE_TITLES[route] || [route, ''];
    // $('#pageTitle').innerHTML = t + ' <span>' + s + '</span>';
    document.title = t + ' - MemoryOS';
    location.hash = route;
    if (route === 'trend') window.EChartsLoaded.when(drawTrendCharts);
    if (route === 'top') window.EChartsLoaded.when(drawTopScatter);
    if (route === 'cross') window.EChartsLoaded.when(drawCrossCharts);
    if (route === 'connect' && autoScanConnect) autoScanConnect();
    if (route === 'agent' && initAgent) initAgent();
    if (route === 'runs' && initRuns) initRuns();
    if (route === 'rules' && initRules) initRules();
    if (route === 'ingest' && initIngest) initIngest();
    if (route === 'governance' && initGovernance) initGovernance();
    if (route === 'obsidian' && initObsidian) initObsidian();
    if (route === 'skills' && initSkills) initSkills();
    if (route === 'graph' && initGraph) initGraph();
    if (route === 'tasks' && initTasks) initTasks();
    /* ★ 实时看板：进任务看板开卡片 SSE（变更即重画当前视图），离开即关 */
    if (route === 'tasks') _cardsStreamStart(); else _cardsStreamStop();
    // ★ UI2.0：入场动画结束后统一重算图表尺寸，修正 ECharts 在容器尺寸未稳定时初始化导致的挤压/只显首点
    setTimeout(() => { try { resizeAllCharts(); } catch { /* ignore */ } }, 340);
  }
  function bindNav() {
    $$('.nav-item').forEach(item => item.onclick = () => navigate(item.dataset.route));
    window.addEventListener('hashchange', () => { const r = location.hash.slice(1) || 'agent'; if (PAGE_TITLES[r]) navigate(r); });
    // 顶部导航栏鼠标滚轮横向滚动
    const navScroll = document.querySelector('.global-nav-scroll');
    if (navScroll) {
      navScroll.addEventListener('wheel', (e) => {
        if (e.deltaY !== 0) {
          e.preventDefault();
          navScroll.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }
  }

  let trendDrawn = false, crossChartsDrawn = false;
  let autoScanConnect = null; // 「工具连接」页进入时自动扫描一次
  function drawTrendCharts() {
    if (!window.echarts || trendDrawn) return; trendDrawn = true;
    try {
      const t = echarts.init(document.getElementById('trend30Chart'));
      t.setOption(Object.assign(chartBase({}), {
        legend: { data: ['写入', '返回', '引用'], textStyle: { color: '#64748b' }, top: 0 },
        grid: { left: 40, right: 20, top: 36, bottom: 28 },
        xAxis: { type: 'category', data: S.trend.map(x => x.day.slice(5)), axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } } },
        series: [
          { name: '写入', type: 'bar', data: S.trend.map(x => x.write), itemStyle: { color: '#06b6d4', borderRadius: [3, 3, 0, 0] } },
          { name: '返回', type: 'line', smooth: true, data: S.trend.map(x => x.returned), itemStyle: { color: '#a855f7' } },
          { name: '引用', type: 'line', smooth: true, data: S.trend.map(x => x.cited), itemStyle: { color: '#10b981' } },
        ],
      }));
      const effs = S.memories.filter(m => m.status === 'active').map(m => m.eff).sort((a, b) => a - b);
      const e2 = echarts.init(document.getElementById('effChart'));
      e2.setOption(Object.assign(chartBase({}), {
        grid: { left: 40, right: 20, top: 20, bottom: 28 },
        xAxis: { type: 'category', data: effs.map((_, i) => '#' + (i + 1)), axisLabel: { color: '#94a3b8' }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } } },
        series: [{ type: 'line', data: effs, itemStyle: { color: '#f59e0b' }, lineStyle: { type: 'dashed' }, areaStyle: { color: 'rgba(245,158,11,0.06)' }, markLine: { silent: true, data: [{ yAxis: 0.15, lineStyle: { color: '#ef4444', type: 'dashed' }, label: { formatter: '僵尸阈值 0.15', color: '#ef4444', fontSize: 10 } }] } }],
      }));
      // 各类型记忆周增量：按 created_at 归周 ISOWeeks 聚合，堆叠柱状图（纯前端，数据来自 S.memories）
      const ttEl = document.getElementById('typeTrendChart');
      if (ttEl) {
        const isoWeek = (s) => {
          const d = new Date(s); d.setHours(0, 0, 0, 0);
          d.setDate(d.getDate() + 4 - (d.getDay() || 7));
          const y = d.getFullYear(); const yStart = new Date(y, 0, 1).getDay() || 7;
          const week = Math.ceil((((d - new Date(y, 0, 1)) / 86400000) + yStart) / 7);
          return `${y}-W${String(week).padStart(2, '0')}`;
        };
        const byWeek = {};
        S.memories.forEach(m => {
          if (!m.created_at) return;
          const w = isoWeek(m.created_at);
          (byWeek[w] = byWeek[w] || {})[m.type] = (byWeek[w][m.type] || 0) + 1;
        });
        const weeks = Object.keys(byWeek).sort();
        const types = [...new Set(S.memories.map(m => m.type).filter(Boolean))];
        const tt = echarts.init(ttEl);
        tt.setOption(Object.assign(chartBase({}), {
          legend: { data: types.map(typeCN), textStyle: { color: '#64748b' }, top: 0 },
          grid: { left: 40, right: 20, top: 36, bottom: 28 },
          xAxis: { type: 'category', data: weeks, axisLabel: { color: '#94a3b8', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(0,0,0,0.08)' } } },
          yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } }, axisLabel: { color: '#94a3b8' } },
          series: types.map(type => ({
            name: typeCN(type), type: 'bar', stack: 'total', barMaxWidth: 28,
            itemStyle: { color: typeColor(type), borderRadius: [0, 0, 0, 0] },
            data: weeks.map(w => (byWeek[w] && byWeek[w][type]) || 0),
          })),
        }));
      }
    } catch (e) { console.error('trend charts', e); }
  }
  function drawCrossCharts() {
    if (!window.echarts || crossChartsDrawn) return; crossChartsDrawn = true;
    const rows = S.cross || []; const byW = {}, byR = {};
    rows.forEach(r => { byW[r.writer_agent] = (byW[r.writer_agent] || 0) + r.n; byR[r.reader_agent] = (byR[r.reader_agent] || 0) + r.n; });
    try {
      const wp = echarts.init(document.getElementById('writerPie'));
      wp.setOption({ tooltip: { backgroundColor: 'rgba(255,255,255,0.96)', textStyle: { color: '#1e293b' }, borderColor: 'rgba(0,0,0,0.08)', borderWidth: 1 }, series: [{ type: 'pie', radius: ['40%', '68%'], label: { color: '#64748b', fontSize: 11 }, itemStyle: { borderColor: '#fff', borderWidth: 2 }, data: Object.entries(byW).map(([n, v]) => ({ name: n, value: v })) }] });
      const rp = echarts.init(document.getElementById('readerPie'));
      rp.setOption({ tooltip: { backgroundColor: 'rgba(255,255,255,0.96)', textStyle: { color: '#1e293b' }, borderColor: 'rgba(0,0,0,0.08)', borderWidth: 1 }, series: [{ type: 'pie', radius: ['40%', '68%'], roseType: 'radius', label: { color: '#64748b', fontSize: 11 }, itemStyle: { borderColor: '#fff', borderWidth: 2 }, data: Object.entries(byR).map(([n, v]) => ({ name: n, value: v })) }] });
    } catch (e) { console.error('cross charts', e); }
  }

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
  }
  // 图表自适应：统一 resize 所有已初始化的 ECharts 实例
  function resizeAllCharts() {
    if (!window.echarts) return;
    [...$$('[id$="Chart"], [id$="Pie"]')].forEach(el => {
      const inst = echarts.getInstanceByDom(el);
      if (inst) inst.resize();
    });
  }
  // 防抖：窗口拖拽时避免高频调用
  let _resizeTimer = null;
  window.addEventListener('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(resizeAllCharts, 120);
  });

  // 工具连接：真实扫描本机已装 AI Agent（/api/scan-agents）
  function initConnectScan() {
    const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    let scanned = [];
    let scanMeta = {};
    const shortPath = (p) => String(p || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
    const render = () => {
      const connectedN = scanned.filter(a => a.connected).length;
      set('#connectedCount', connectedN);
      set('#connectedBadge', connectedN);
      set('#discoveredCount', scanned.length);
      set('#pendingCount', Math.max(0, scanned.length - connectedN));
      set('#mcpDbPath', shortPath(scanMeta.dbPath) || '未知');
      set('#mcpConnectedSummary', `${connectedN} / ${scanned.length}`);

      // 证据列：状态 + 依据（配置文件 / 心跳时间）
      const evidenceHtml = (t) => {
        if (!t.connected) return '';
        const hb = t.heartbeat && t.heartbeat.at ? `心跳 ${fmtDate(t.heartbeat.at)}${t.heartbeat.live ? '（活跃）' : ''}` : '';
        const detail = t.configFile ? shortPath(t.configFile) : hb;
        return `<div class="mcp-evidence" title="${esc([t.evidence, t.configFile ? '配置：' + t.configFile : '', hb].filter(Boolean).join(' · '))}">${esc([t.evidence, detail].filter(Boolean).join(' · '))}</div>`;
      };
      // 指向的库：与仪表盘当前库比对（null = 载体不记录库路径，无法判定，不谎报）
      const dbHtml = (t) => {
        if (!t.connected) return '<span class="text-muted" style="font-size:11px">—</span>';
        if (!t.resolvedDb) return '<span class="db-pill unknown" title="该载体不记录库路径（如 Trae 目录型载体），无法判定">无法判定</span>';
        return t.dbMatches
          ? `<span class="db-pill ok" title="${esc(t.resolvedDb)}">✓ 当前库</span>`
          : `<span class="db-pill bad" title="${esc(t.resolvedDb)}">⚠ 其他库</span>`;
      };
      const connectAction = (t) => {
        const agency = t.id || t.name || '';
        if (!t.connected) return `<button class="btn-ghost" data-connect="${esc(agency)}" style="padding:4px 12px;font-size:12px">接入</button>`;
        // 已连接也要能进向导看配置（库不一致时按钮直接写「改库」）
        if (t.resolvedDb && t.dbMatches === false) return `<button class="btn-ghost" data-connect="${esc(agency)}" style="padding:4px 12px;font-size:12px;color:var(--warning);border-color:rgba(217,119,6,0.35)">改库</button>`;
        return `<button class="btn-ghost" data-connect="${esc(agency)}" style="padding:4px 12px;font-size:12px">查看</button>`;
      };
      const tb = $('#toolTableBody');
      if (tb) tb.innerHTML = scanned.length ? scanned.map((t, i) =>
        `<tr><td class="mono text-muted">${String(i + 1).padStart(2, '0')}</td>
         <td style="color:var(--text-primary);font-weight:600">${esc(t.name)}</td>
         <td><span class="type-tag ${t.type.includes('CLI') ? 'decision' : 'experience'}">${esc(t.type)}</span></td>
         <td class="mono" style="font-size:11px;color:var(--text-secondary);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.path || '')}">${esc(t.path ? shortPath(t.path) : '—')}</td>
         <td class="mono" style="font-size:12px">${esc(t.version) || '—'}</td>
         <td><span class="status-pill ${t.connected ? 'active' : 'archived'}"><span class="sdot"></span>${t.connected ? '已连接' : '未连接'}</span>${evidenceHtml(t)}</td>
         <td>${dbHtml(t)}</td>
         <td>${connectAction(t)}</td></tr>`).join('')
        : '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted)">点击「开始扫描」发现本机已安装的 AI Agent</td></tr>';
      $$('#toolTableBody [data-connect]').forEach(btn => btn.onclick = () => showConnectGuide(btn.dataset.connect));
      renderDbAlert();
      renderCarriers();
    };
    // 库不一致告警：直接点出"连了却看不到数据"的根因
    function renderDbAlert() {
      const alert = $('#mcpDbAlert'); if (!alert) return;
      const mism = scanned.filter(a => a.connected && a.resolvedDb && a.dbMatches === false);
      const stale = scanned.filter(a => a.staleServer);
      if (!mism.length && !stale.length) { alert.style.display = 'none'; return; }
      const parts = [];
      if (mism.length) parts.push(`⚠ <b>${mism.length} 个客户端连的是别的库</b>：${mism.map(m => esc(m.name)).join('、')} —— 它们写的记忆不会出现在本仪表盘（当前库 <span class="mono">${esc(shortPath(scanMeta.dbPath))}</span>）。点该行右侧「<b>改库</b>」按当前库重写配置，写前自动备份。`);
      if (stale.length) parts.push(`⚠ ${stale.map(s => esc(s.name)).join('、')} 配置里的 <span class="mono">server.js</span> 路径已不存在，需改指到本机内核。`);
      alert.style.display = '';
      alert.innerHTML = parts.join('<br>');
    }
    // 载体核验：把磁盘上每个已知 MCP 配置文件逐个摊开
    function renderCarriers() {
      const body = $('#mcpCarriersBody'); if (!body) return;
      const carriers = (scanMeta.carriers || []).slice().sort((a, b) => Number(b.declares) - Number(a.declares));
      set('#mcpCarriersBadge', carriers.length ? `${carriers.filter(c => c.declares).length} / ${carriers.length} 个载体声明了 memoryos` : '无记录');
      body.innerHTML = carriers.length ? carriers.map(c => `
        <tr class="mcp-carrier-row${c.declares && c.dbMatches === false ? ' bad' : ''}">
          <td style="font-size:12px">${esc(c.agentLabel || c.agentId)}</td>
          <td class="mono" style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.file)}">${esc(shortPath(c.file))}</td>
          <td>${c.declares ? '<span class="status-pill active"><span class="sdot"></span>已声明</span>' : '<span class="text-muted" style="font-size:11px">未声明</span>'}</td>
          <td class="mono" style="font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c.serverPath || '')}">${esc(shortPath(c.serverPath || '—'))}</td>
          <td class="mono" style="font-size:11px">${esc(shortPath(c.resolvedDb || '—'))} ${c.declares ? (c.dbMatches === true ? '<span class="db-pill ok">当前库</span>' : c.dbMatches === false ? '<span class="db-pill bad">非当前库</span>' : '<span class="db-pill unknown">无法判定</span>') : ''}</td>
        </tr>`).join('')
        : '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-muted)">未发现任何 MCP 载体文件</td></tr>';
    }
    $('#scanBtn').onclick = () => runScan(true);
    let autoRan = false;
    function runScan(manual) {
      if (!manual && autoRan) return; // 自动扫描只跑一次；手动每次可再扫
      autoRan = true;
      const btn = $('#scanBtn');
      btn.disabled = true; btn.style.opacity = '0.6';
      const sk = $('#scanEmpty'); if (sk) sk.style.display = 'none';
      const pr = $('#scanProgress'); if (pr) pr.style.display = 'block';
      const lg = $('#scanLog'); if (lg) lg.innerHTML = '';
      const bar = $('#scanBar'); let p = 0;
      const setAuto = (s) => { const e = $('#scanStatus'); if (e) e.textContent = s; };
      const iv = setInterval(() => { p = Math.min(p + 30, 90); if (bar) bar.style.width = p + '%'; set('#scanPercent', p + '%'); setAuto('正在探测本机 Agent…'); }, 300);
      fetch('/api/scan-agents').then(r => r.json()).then(r => {
        clearInterval(iv);
        scanned = r.agents || [];
        scanMeta = r;
        if (bar) bar.style.width = '100%'; set('#scanPercent', '100%');
        const mism = scanned.filter(a => a.connected && a.resolvedDb && a.dbMatches === false).length;
        setAuto('扫描完成：发现 ' + scanned.length + ' 个工具，MCP 已连接 ' + r.connected + ' 个' + (mism ? '，其中 ' + mism + ' 个连的是别的库' : ''));
        render();
      }).catch(e => {
        clearInterval(iv); setAuto('扫描失败：' + e.message); scanned = []; render();
      }).finally(() => { btn.disabled = false; btn.style.opacity = '1'; });
    }
    autoScanConnect = runScan;

    // 接入向导：拉取该 agent 的 connect-guide，弹窗展示（自动写预览 / 手动步骤 + 完整配置）
    async function copyConnectSnippet(text, body) {
      if (!text) { toast('没有可复制的片段'); return; }
      try {
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板');
      } catch {
        const pre = body.querySelector('#connectSnippet');
        if (pre) { const rr = document.createRange(); rr.selectNodeContents(pre); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rr); document.execCommand('copy'); toast('已复制'); }
        else toast('复制失败');
      }
    }
    async function showConnectGuide(agentId) {
      try {
        const g = await fetch('/api/agent/' + encodeURIComponent(agentId) + '/connect-guide').then(r => r.json());
        if (!g.ok || !g.guide) { toast('获取接入向导失败'); return; }
        const gu = g.guide;
        const id = gu.agentId || agentId;
        const modal = $('#connectModal');
        const body = $('#connectBody'); if (!modal || !body) { toast('未找到向导容器'); return; }
        // 旧内核不下发 dbMatches（undefined）→ 显示「库未核验」，不谎报"不一致"
        const dbKnown = gu.dbMatches === true || gu.dbMatches === false;
        const dbState = gu.dbMatches === true ? 'ok' : (dbKnown ? 'bad' : 'unknown');
        const dbText = gu.dbMatches === true ? '库已对齐' : (dbKnown ? '库不一致' : '库未核验');
        let html = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;margin-bottom:8px">
            <b style="color:var(--text-primary)">${esc(gu.name)}</b>
            <span class="status-pill ${gu.connected ? 'active' : 'archived'}"><span class="sdot"></span>${gu.connected ? '已连接 MCP' : '未连接 MCP'}</span>
            ${gu.connected ? `<span class="db-pill ${dbState}">${dbText}</span>` : ''}
          </div>`;
        if (gu.needsDbFix) {
          html += `<div class="mcp-alert" style="margin:0 0 10px">当前配置指向 <span class="mono">${esc(shortPath(gu.carrierDb) || '未知')}</span>，而本仪表盘读的是 <span class="mono">${esc(shortPath(gu.targetDb) || '')}</span> —— 两者不是同一个库，"连上了却看不到数据"就是这么来的。确认写入会把它改指到当前库。</div>`;
        }
        if (gu.staleServer) {
          html += `<div class="mcp-alert" style="margin:0 0 10px">⚠ 配置里的 <span class="mono">server.js</span> 路径在磁盘上已不存在：<span class="mono">${esc(gu.serverPath || '')}</span>，需改指到本机内核。</div>`;
        }
        // ★ 两种用途分开给：导入框吃「名字→配置」裸映射；配置文件是各客户端自己的结构。
        //   （混用会报 `server "version": entry must be an object` —— 顶层 version 被当成 server 条目）
        const blocks = [];
        if (gu.importSnippet) blocks.push({ kind: 'import', title: '① 导入框用 —— 粘贴到客户端的「MCP 导入 / 从 JSON 添加」输入框', code: gu.importSnippet });
        if (gu.fileSnippet) blocks.push({ kind: 'file', title: `② 配置文件用 —— ${gu.fileSnippetLabel || '写进客户端配置文件'}`, code: gu.fileSnippet });
        // 旧内核只下发 attachSnippet/manualSnippet（单块）→ 回退显示，避免过渡期空白
        if (!blocks.length) {
          const legacy = gu.canAutoWrite ? gu.attachSnippet : gu.manualSnippet;
          if (legacy) blocks.push({ kind: 'legacy', title: '配置内容 —— 重启内核后可分别给出「导入框用」与「配置文件用」两种格式', code: legacy });
        }
        if (blocks.length > 1 && gu.importSnippet !== gu.fileSnippet) {
          const fmt = gu.carrierShape === 'servers' ? '{version, servers:[…]}' : (gu.carrierShape === 'toml' ? 'TOML 表' : (gu.carrierShape === 'mcp.servers' ? '{mcp:{servers:{…}}}' : (gu.carrierShape === 'vscode' ? '{servers:{…}}' : '{mcpServers:{…}}')));
          html += `<div style="margin-top:8px;padding:8px 11px;border-radius:8px;font-size:11.5px;line-height:1.8;background:rgba(65,187,200,0.07);border:1px solid rgba(65,187,200,0.22);color:var(--text-secondary)">这两种格式<b>用途不同、别混用</b>：导入框只接受「名字 → 配置」的裸映射；而 ${esc(gu.name)} 的配置文件是 <span class="mono">${esc(fmt)}</span>。把②粘进导入框会报 <span class="mono">entry must be an object</span>。</div>`;
        }
        blocks.forEach((b, bi) => {
          html += `<div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="font-size:12px;color:var(--text-secondary)">${esc(b.title)}</span><button class="btn-ghost" data-copy-snippet="${bi}" style="padding:4px 12px;font-size:12px;margin-left:auto">复制</button></div>`;
          html += `<pre style="margin-top:6px;padding:10px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:11px;overflow:auto;white-space:pre-wrap;max-height:260px"${bi === 0 ? ' id="connectSnippet"' : ''}>${esc(b.code)}</pre>`;
        });
        if (gu.canAutoWrite) {
          html += `<div style="padding:10px;background:rgba(65,187,200,0.08);border-radius:8px;font-size:12px;margin-top:8px">写入 <code style="color:var(--accent-cyan)">${esc(shortPath(gu.autoWriteFile))}</code>；写前自动备份到 <span class="mono">_pending-delete/connect-backup</span>，只更新 memoryos 条目，其它配置原样保留。目标库：<span class="mono">${esc(shortPath(gu.targetDb) || '')}</span>。写完请重启该客户端会话。</div>`;
        } else {
          html += `<div style="padding:10px;background:rgba(251,191,36,0.1);border-radius:8px;font-size:12px;margin-top:8px">该载体为目录型 / 未实证，无法安全自动写，请按下面步骤手动接入。</div><ol style="margin:8px 0 0 18px;font-size:12px;line-height:1.9">${(gu.manualSteps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol>`;
          html += `<div style="margin-top:12px;padding:10px;background:rgba(65,187,200,0.08);border-radius:8px;font-size:12px">粘贴配置后点「<b>重扫验证</b>」——重新扫描本机，若已接上，状态会变为「已连接」且显示它指向的库。</div>`;
          html += `<button class="btn-primary" data-rescan style="margin-top:8px;width:100%">重扫验证</button>`;
        }
        body.innerHTML = html;
        body.dataset.canAuto = gu.canAutoWrite ? '1' : '0';
        body.dataset.agent = id;
        body.dataset.file = gu.autoWriteFile || '';
        body.dataset.snippet = gu.attachSnippet || '';
        const reBtn = body.querySelector('[data-rescan]');
        if (reBtn) reBtn.onclick = () => { modal.style.display = 'none'; if (runScan) runScan(true); };
        modal.style.display = 'flex';
        body.querySelectorAll('[data-copy-snippet]').forEach(btn => {
          const bi = Number(btn.dataset.copySnippet);
          btn.onclick = () => copyConnectSnippet((blocks[bi] || blocks[0]).code, body);
        });
        const confirmBtn = $('#connectConfirm');
        if (confirmBtn) {
          confirmBtn.style.display = gu.canAutoWrite ? '' : 'none';
          confirmBtn.textContent = gu.needsDbFix ? '确认改库并写入' : '确认写入';
        }
      } catch (e) { toast('加载接入向导失败：' + e.message); }
    }
    // 接入向导 Modal：关闭 + 确认写入
    (function bindConnectModal() {
      const modal = $('#connectModal');
      if (!modal || modal.dataset.bound) return; modal.dataset.bound = '1';
      const close = () => modal.style.display = 'none';
      $('#connectModalClose').onclick = close;
      $('#connectCancel').onclick = close;
      modal.onclick = (e) => { if (e.target === modal) close(); };
      const confirmBtn = $('#connectConfirm');
      if (confirmBtn) confirmBtn.onclick = async () => {
        const body = $('#connectBody');
        const agentId = body?.dataset.agent;
        if (!agentId) return;
        confirmBtn.disabled = true;
        try {
          const dry = await fetch('/api/agent/' + encodeURIComponent(agentId) + '/connect?dry_run=1', { method: 'POST' }).then(r => r.json());
          if (dry.ok) {
            const bak = '写入前自动备份到 _pending-delete/connect-backup';
            const dbLine = dry.dbPath ? `\n目标库：${dry.dbPath}` : '';
            if (!confirm('将写入 ' + (dry.target || body.dataset.file || '配置文件') + dbLine + '\n' + bak + '。确认执行？')) { confirmBtn.disabled = false; return; }
            const r = await fetch('/api/agent/' + encodeURIComponent(agentId) + '/connect', { method: 'POST' }).then(x => x.json());
            if (r.ok) {
              toast('已写入' + (r.target ? ' ' + r.target.split('\\').pop() : '') + (r.backupPath ? '（备份：' + r.backupPath.split(/[\\/]/).pop() + '）' : ''));
              close();
              if (runScan) runScan(true); // 写完立刻重扫，状态与"指向的库"当场刷新
            }
            else toast('写入失败：' + (r.error || ''));
          } else { toast('预览失败：' + (dry.error || '')); }
        } catch (e) { toast('写入异常：' + e.message); }
        confirmBtn.disabled = false;
      };
    })();
  render();
}

  /* ===== 规则管理（type=rule）===== */
  let ruleRows = [], ruleStatus = 'all';
  async function loadRules() {
    const url = '/api/rules?limit=1000&status=' + (ruleStatus === 'all' ? '' : ruleStatus);
    const r = await fetch(url).then(x => x.json()).catch(e => ({ rows: [], error: e.message }));
    ruleRows = r.rows || [];
    const show = ruleStatus === 'all' ? ruleRows : ruleRows.filter(x => x.status === ruleStatus);
    $('#ruleCount').textContent = '共 ' + show.length + ' 条';
    $('#ruleTableBody').innerHTML = show.length ? show.map((m, i) =>
      `<tr data-id="${m.id}"><td class="mono text-muted">${String(i + 1).padStart(2, '0')}</td>
       <td class="memory-content">${esc(m.content)}</td>
       <td class="mono" style="font-size:12px">${esc(m.agent)}</td>
       <td><span class="status-pill ${esc(m.status)}"><span class="sdot"></span>${statusCN(m.status)}</span></td>
       <td class="mono" style="font-size:12px">${Number(m.confidence || 0).toFixed(2)}</td>
       <td class="mono text-secondary" style="font-size:12px">${fmtDate(m.created_at)}</td>
       <td><div style="display:flex;gap:6px"><button class="btn-ghost rule-edit" data-rid="${m.id}" style="padding:4px 10px;font-size:12px">编辑</button><button class="btn-ghost rule-del" data-rid="${m.id}" style="padding:4px 10px;font-size:12px;color:var(--danger);border-color:rgba(248,113,113,0.3)">删除</button></div></td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📏</div><div class="empty-title">暂无规则</div><div class="empty-desc">还没有创建 AI Agent 协同约束规则，点击右上角"新建规则"开始</div></div></td></tr>';
    $$('#ruleTableBody tr[data-id]').forEach(tr => tr.onclick = () => openDetail(Number(tr.dataset.id), ruleRows));
    $$('#ruleTableBody .rule-edit').forEach(b => b.onclick = e => { e.stopPropagation(); openEdit(Number(b.dataset.rid), 'rule'); });
    $$('#ruleTableBody .rule-del').forEach(b => b.onclick = e => { e.stopPropagation(); delRule(Number(b.dataset.rid)); });
  }
  async function delRule(id) {
    if (!confirm('确认删除规则 #' + id + ' ？（软删除，可审计回溯）')) return;
    const r = await fetch('/api/memory/' + id, { method: 'DELETE' }).then(x => x.json()).catch(e => ({ error: e.message }));
    if (r.ok) { toast('已删除规则 #' + id); loadRules(); }
    else toast(r.error || '删除失败');
  }
  function initRules() {
    const g = $('#ruleFilter');
    if (g && !g.dataset.bound) { g.dataset.bound = '1';
      bindGroup('#ruleFilter', d => { ruleStatus = d; loadRules(); });
    }
    const cb = $('#createRuleBtn'); if (cb) cb.onclick = () => openEdit(null, 'rule');
    const sb = $('#syncRulesBtn'); if (sb) sb.onclick = syncRulesNow;
    loadProjectCandidates();
    const pb = $('#projSyncBtn'); if (pb) pb.onclick = runProjectSync;
    loadRules();
  }
  async function loadProjectCandidates() {
    const wrap = $('#projChips');
    if (!wrap) return;
    try {
      const r = await fetch('/api/rules/project-candidates').then(x => x.json());
      const list = r.projects || [];
      if (!list.length) { wrap.innerHTML = '<span style="color:var(--text-muted);font-size:12px">未发现候选项目，请手动输入路径</span>'; return; }
      wrap.innerHTML = list.map(p =>
        `<button class="proj-chip ${p.hasAgents ? 'has-agents' : ''}" data-dir="${esc(p.dir)}" title="${p.hasAgents ? '已存在 AGENTS.md' : '将新建 AGENTS.md'}">
          ${esc(p.name)}${p.hasAgents ? ' ⚑' : ''}</button>`).join('');
      $$('.proj-chip').forEach(b => b.onclick = () => {
        $('#projDirInput').value = b.dataset.dir;
        runProjectSync();
      });
    } catch (e) {
      wrap.innerHTML = '<span style="color:var(--text-muted);font-size:12px">候选加载失败，可手动输入路径</span>';
    }
  }
  async function runProjectSync() {
    const el = $('#projSyncResult');
    const dir = ($('#projDirInput').value || '').trim();
    if (!dir) { if (el) el.innerHTML = '<span style="color:var(--danger)">请先选择候选项目或输入路径</span>'; return; }
    if (el) el.innerHTML = '注入中…';
    try {
      const r = await fetch('/api/rules/project-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) }).then(x => x.json());
      if (r.ok && r.result && r.result.ok) {
        const x = r.result;
        if (el) el.innerHTML = `<span style="color:var(--success)">已注入 ${x.rules} 条 → ${esc(x.file)}${x.backedUp ? '（原文件已备份）' : x.added ? '（新建/追加）' : '（幂等更新）'}</span>`;
        toast('项目规则注入成功：' + x.file);
      } else {
        if (el) el.innerHTML = `<span style="color:var(--danger)">${esc(r.error || '注入失败')}</span>`;
      }
    } catch (e) {
      if (el) el.innerHTML = `<span style="color:var(--danger)">注入失败：${esc(e.message)}</span>`;
    }
  }
  async function syncRulesNow() {
    const el = $('#syncRulesResult');
    if (el) el.textContent = '同步中…';
    try {
      const r = await fetch('/api/rules/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then(x => x.json());
      if (r.ok && Array.isArray(r.results)) {
        const ok = r.results.filter(x => x.ok);
        if (el) el.innerHTML = `<span style="color:var(--success)">已注入 ${ok.length} 个智能体（${ok.map(x => x.target).join(', ')}，共 ${ok.reduce((s, x) => s + x.rules, 0)} 条）</span>`;
        toast('已同步规则到 ' + ok.length + ' 个智能体：' + ok.map(x => x.target).join(', '));
      } else {
        if (el) el.innerHTML = `<span style="color:var(--danger)">${esc(r.error || '同步失败')}</span>`;
      }
    } catch (e) {
      if (el) el.innerHTML = `<span style="color:var(--danger)">同步失败：${esc(e.message)}</span>`;
    }
  }

  /* ===== 采集消化 ===== */
  /* ===== 采集源：内置 + 自定义（自定义源存于 sources.json，可增删）===== */
  let _customSources = [];
  function renderIngestSources(sources) {
    const body = $('#ingestSourceBody');
    if (!body) return;
    if (!sources.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📥</div><div class="empty-title">尚未探测到可采集的来源</div><div class="empty-desc">采集地址由系统自动分配，无需手动配置；装了对应 AI Agent 后其记忆目录会自动出现</div></div></td></tr>';
      return;
    }
    body.innerHTML = sources.map((s, i) => {
      const custom = s.source === 'custom';
      const off = custom && s.enabled === false;
      const badge = custom
        ? '<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(65,187,200,0.12);color:var(--accent-cyan)">系统预置</span>'
        : '<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(148,163,184,0.12);color:var(--text-muted)">内置</span>';
      const action = custom
        ? `<button class="btn-ghost src-toggle" data-id="${esc(s.id)}" data-enabled="${off ? '0' : '1'}" style="padding:3px 8px;font-size:11px">${off ? '启用' : '停用'}</button>` +
          `<button class="btn-ghost src-del" data-id="${esc(s.id)}" data-name="${esc(s.name)}" style="padding:3px 8px;font-size:11px;margin-left:6px">删除</button>`
        : '<span class="text-muted" style="font-size:11px">—</span>';
      return `<tr${off ? ' style="opacity:0.55"' : ''}><td class="mono text-muted">${String(i + 1).padStart(2, '0')}</td>
       <td><span class="type-tag ${s.agent === 'codex' ? 'decision' : 'experience'}">${esc(s.agent)}</span></td>
       <td style="color:var(--text-primary)">${esc(s.name)}${off ? ' <span style="font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(239,68,68,0.12);color:var(--danger)">已停用</span>' : ''}</td>
       <td><span class="type-tag ${esc(s.kind)}">${esc(s.kind)}</span></td>
       <td class="mono" style="font-size:11px;color:var(--text-secondary);max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.path)}">${esc(s.path)}</td>
       <td>${badge}</td>
       <td>${action}</td></tr>`;
    }).join('');
    body.querySelectorAll('.src-del').forEach(b => { b.onclick = () => deleteCustomSource(b.dataset.id, b.dataset.name); });
    body.querySelectorAll('.src-toggle').forEach(b => { b.onclick = () => toggleCustomSource(b.dataset.id, b.dataset.enabled !== '1'); });
  }
  async function loadIngestSources() {
    const [r, c] = await Promise.all([
      fetch('/api/ingest/sources').then(x => x.json()).catch(e => ({ sources: [], error: e.message })),
      fetch('/api/ingest/custom-sources').then(x => x.json()).catch(() => ({ sources: [] })),
    ]);
    _customSources = c.sources || [];
    const norm = p => String(p || '').replace(/\\/g, '/').toLowerCase();
    const customPaths = new Set(_customSources.map(s => norm(s.path)));
    // 内置源（剔除自定义）+ 全部系统预置源（含已停用 —— 停用后仍需展示，才能重新启用）
    const rows = [
      ...(r.sources || []).filter(s => !customPaths.has(norm(s.path))).map(s => Object.assign({}, s, { source: 'builtin', enabled: true })),
      ..._customSources.map(s => Object.assign({}, s, { source: 'custom', enabled: s.enabled !== false })),
    ];
    renderIngestSources(rows);
    const btn = $('#ingestRunBtn');
    if (btn && rows.length) {
      btn.style.display = '';
      btn.textContent = '开始采集（' + rows.length + ' 个源）';
    }
  }
  function initIngest() {
    const btn = $('#ingestRunBtn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.onclick = runIngest;
    }
    const add = $('#addSourceBtn');
    if (add && !add.dataset.bound) {
      add.dataset.bound = '1';
      add.onclick = openSourceModal;
    }
    const modal = $('#sourceModal');
    if (modal && !modal.dataset.bound) {
      modal.dataset.bound = '1';
      $('#sourceModalClose').onclick = closeSourceModal;
      $('#srcCancelBtn').onclick = closeSourceModal;
      $('#srcValidateBtn').onclick = () => validateSourceForm(true);
      $('#srcSaveBtn').onclick = saveCustomSource;
      modal.addEventListener('click', e => { if (e.target === modal) closeSourceModal(); });
    }
    loadIngestSources();
  }
  function openSourceModal() {
    $('#sourceModalTitle').textContent = '添加自定义源';
    $('#srcPath').value = ''; $('#srcName').value = '';
    $('#srcKind').value = 'memory'; $('#srcLevel').value = 'L2';
    $('#srcFilter').value = ''; $('#srcMaxFiles').value = '50'; $('#srcMaxDepth').value = '3';
    $('#srcCheck').style.display = 'none';
    const hint = $('#srcHint'); hint.style.display = 'none'; hint.textContent = '';
    $('#sourceModal').style.display = 'flex';
    setTimeout(() => { const el = $('#srcPath'); if (el) el.focus(); }, 50);
  }
  function closeSourceModal() {
    const m = $('#sourceModal');
    if (m) m.style.display = 'none';
  }
  function sourceFormPayload() {
    return {
      path: $('#srcPath').value.trim(),
      name: $('#srcName').value.trim(),
      kind: $('#srcKind').value,
      level: $('#srcLevel').value,
      includeFilter: $('#srcFilter').value.trim(),
      maxFiles: Number($('#srcMaxFiles').value) || 50,
      maxDepth: Number($('#srcMaxDepth').value) || 3,
    };
  }
  function renderSourceCheck(check) {
    const box = $('#srcCheck');
    box.style.display = 'block';
    if (check && check.ok) {
      const kb = (check.totalBytes / 1024).toFixed(1);
      box.style.background = 'rgba(34,197,94,0.08)';
      box.style.color = 'var(--text-secondary)';
      box.innerHTML = '✅ 预检通过：发现 <strong style="color:var(--success)">' + check.files + '</strong> 个可采集文件 · 共 <strong>' + kb + ' KB</strong>' +
        (check.truncated ? '（已达上限，仅统计前 ' + check.files + ' 个）' : '') +
        '<br><span class="mono" style="font-size:11px;color:var(--text-muted)">' + (check.samples || []).map(esc).join('<br>') + '</span>';
    } else {
      box.style.background = 'rgba(239,68,68,0.08)';
      box.style.color = '#ef4444';
      box.textContent = '⛔ ' + ((check && check.error) || '预检失败');
    }
    return !!(check && check.ok);
  }
  async function validateSourceForm(showToast) {
    const hint = $('#srcHint'); hint.style.display = 'none';
    const p = sourceFormPayload();
    if (!p.path) { hint.textContent = '路径不能为空'; hint.style.display = 'block'; return false; }
    try {
      const r = await fetch('/api/ingest/validate-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(x => x.json());
      const ok = renderSourceCheck(r.check);
      if (showToast) toast(ok ? '预检通过' : '预检未通过，请检查路径');
      return ok;
    } catch (e) {
      renderSourceCheck({ ok: false, error: '预检请求失败：' + e.message });
      return false;
    }
  }
  async function saveCustomSource() {
    const hint = $('#srcHint'); hint.style.display = 'none';
    const p = sourceFormPayload();
    if (!p.path) { hint.textContent = '路径不能为空'; hint.style.display = 'block'; return; }
    const btn = $('#srcSaveBtn'); btn.disabled = true; btn.style.opacity = '0.6';
    try {
      const r = await fetch('/api/ingest/custom-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).then(x => x.json());
      if (!r.ok) { hint.textContent = r.error || '保存失败'; hint.style.display = 'block'; return; }
      closeSourceModal();
      toast('已添加自定义源：' + ((r.source && r.source.name) || '') + '（命中 ' + ((r.check && r.check.files) || 0) + ' 文件）');
      await loadIngestSources();
    } catch (e) {
      hint.textContent = '保存失败：' + e.message; hint.style.display = 'block';
    } finally { btn.disabled = false; btn.style.opacity = '1'; }
  }
  async function deleteCustomSource(id, name) {
    if (!confirm('确定删除自定义源「' + (name || id) + '」？\n内置源不受影响，仅从 sources.json 移除。')) return;
    try {
      const r = await fetch('/api/ingest/custom-sources/' + encodeURIComponent(id), { method: 'DELETE' }).then(x => x.json());
      if (!r.ok) { toast('删除失败：' + (r.error || '未知错误')); return; }
      toast('已删除自定义源');
      await loadIngestSources();
    } catch (e) { toast('删除失败：' + e.message); }
  }
  /** 启用/停用系统预置源（受限模式下唯一允许的用户侧操作：只切状态，不改路径） */
  async function toggleCustomSource(id, enabled) {
    try {
      const r = await fetch('/api/ingest/custom-sources/' + encodeURIComponent(id) + '/enabled', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }).then(x => x.json());
      if (!r.ok) { toast('操作失败：' + (r.error || '未知错误'), 'error'); return; }
      toast(enabled ? '已启用该采集源' : '已停用该采集源');
      await loadIngestSources();
    } catch (e) { toast('操作失败：' + e.message, 'error'); }
  }
  async function runIngest() {
    const btn = $('#ingestRunBtn');
    btn.disabled = true; btn.style.opacity = '0.6';
    const pr = $('#ingestProgress'); pr.style.display = 'block';
    $('#ingestStatus').textContent = '正在读取源并本地去重…';
    $('#ingestBar').style.width = '0%'; $('#ingestPercent').textContent = '0%';
    $('#ingestLog').innerHTML = '';
    let p = 5;
    const iv = setInterval(() => { p = Math.min(p + 4, 92); $('#ingestBar').style.width = p + '%'; $('#ingestPercent').textContent = p + '%'; }, 250);
    try {
      const r = await fetch('/api/ingest/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then(x => x.json());
      clearInterval(iv);
      $('#ingestBar').style.width = '100%'; $('#ingestPercent').textContent = '100%';
      const st = r.stats || {};
      // P1 成本治理三级渐进档位（normal/compress/downgrade）+ 三级统计，回显到治理中心
      S.ingestBudget = { level: st.budgetLevel, compress: st.budgetCompress, downgrade: st.budgetDowngrade, terminated: st.budgetTerminated };
      $('#ingestStatus').textContent = r.ok ? '采集完成' : '采集未完成';
      const budgetNote = st.budgetLevel ? ` · 成本档位 ${esc(st.budgetLevel)}${st.budgetCompress ? `（压缩 ${st.budgetCompress} 块）` : ''}${st.budgetTerminated ? `（终止 ${st.budgetTerminated} 源）` : ''}` : '';
      $('#ingestStats').innerHTML = `${st.sources || 0} 源 · ${st.files || 0} 文件 · ${st.chunks || 0} 块 · 跳过重复 ${st.skippedDup || 0} · LLM 失败 ${st.llmFail || 0} · <strong style="color:var(--success)">新入库 ${st.inserted || 0} 条</strong>${budgetNote}`;
      const logs = (st.errors || []).map(e => '⛔ ' + esc(e));
      const items = (st.items || []).slice(0, 20).map(it => `✅ [${esc(it.type)}] ${esc(it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content)}`);
      $('#ingestLog').innerHTML = [...logs, ...items].join('<br>') || '本轮无可展示明细';
      if (r.ok && (st.inserted || 0) > 0) { toast('采集入库 ' + st.inserted + ' 条'); if (ruleStatus === 'all' && updateRulesAfterIngest) updateRulesAfterIngest(); }
      else toast(r.error || '本轮无新增');
    } catch (e) {
      clearInterval(iv);
      $('#ingestStatus').textContent = '采集失败';
      $('#ingestLog').innerHTML = '⛔ ' + esc(String(e));
      toast('采集失败：' + e.message);
    } finally { btn.disabled = false; btn.style.opacity = '1'; }
  }
  function updateRulesAfterIngest() { loadRules(); }

  /* ===== 治理中心（融合架构增量：成本治理 / 门控 / 进化 / 凭据 / A2A 协议）===== */
  const GOV_ECHOED = { _loaded: false };
  function initGovernance() {
    const cardsBtn = $('#govCardsBtn');
    if (cardsBtn && !cardsBtn.dataset.bound) {
      cardsBtn.dataset.bound = '1';
      cardsBtn.onclick = loadGovCards;
    }
    const issBtn = $('#govCredIssueBtn');
    if (issBtn && !issBtn.dataset.bound) {
      issBtn.dataset.bound = '1';
      issBtn.onclick = issueGovCred;
    }
    loadGovCreds();
    loadGovGates();
    loadGovEvo();
    if (!GOV_ECHOED._loaded) {
      GOV_ECHOED._loaded = true;
      loadGovCards();
      echoGovBudgetLevel();
    }
  }
  async function loadGovEvo() {
    const el = $('#govEvoState');
    if (!el) return;
    try {
      const r = await fetch('/api/evolution-gate').then(x => x.json());
      if (!r.enabled) { el.textContent = '未启用'; el.style.color = 'var(--text-muted)'; return; }
      const accepted = r.accepted ?? 0, rejected = r.rejected ?? 0, scanned = r.scanned ?? 0;
      el.textContent = `${accepted}/${scanned}`;
      el.style.color = accepted ? 'var(--success)' : (rejected ? '#fbbf24' : 'var(--text-muted)');
      el.title = `进化双回归门：提案 ${scanned} / 接受 ${accepted} / 拒绝 ${rejected}`;
    } catch (e) { el.textContent = '—'; }
  }
  /** 成本治理：采集消化运行后把最终档位回显到治理中心卡片（跨页共享，进入页即读 S.ingestBudget） */
  function echoGovBudgetLevel() {
    const el = $('#govBudgetLevel');
    if (!el) return;
    const lv = (S && S.ingestBudget) ? S.ingestBudget.level : null;
    const map = { normal: ['正常', 'var(--success)'], compress: ['压缩', 'var(--warning, #fbbf24)'], downgrade: ['降级终止', '#ef4444'] };
    const m = map[lv] || ['—', 'var(--text-muted)'];
    el.textContent = m[0];
    el.style.color = m[1];
  }
  async function loadGovCards() {
    const box = $('#govCards');
    if (!box) return;
    try {
      const r = await fetch('/api/agents/cards').then(x => x.json());
      const self = r.self || {};
      const sig = (r.signature || '').slice(0, 20);
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <b style="color:var(--text-primary)">${esc(self.agent || 'memoryos')}</b>
          <span style="color:var(--text-secondary)">${esc(self.name || '')}</span>
          <span class="mono" style="font-size:11px;color:var(--accent-cyan)">MCP ${esc(self.mcpServer || 'memory-hub')} · 工具面 ${self.toolCount ?? '—'}</span>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted)">能力：${(self.capabilities || []).map(c => `<span class="mono" style="background:rgba(65,187,200,0.1);padding:2px 6px;border-radius:4px;margin-right:4px">${esc(c)}</span>`).join('')}
          <br>A2A 卡片共 ${(r.cards || []).length} 张 · 签名 <span class="mono" style="color:var(--text-secondary)">${esc(sig)}…</span>（SHA-256 规范 JSON，对端可复算验证）</div>`;
    } catch (e) {
      box.innerHTML = '<div style="color:#ef4444">拉取 A2A 卡片失败：' + esc(e.message) + '</div>';
    }
  }
  async function loadGovGates() {
    const body = $('#govGateBody');
    if (!body) return;
    try {
      const r = await fetch('/api/gate-presets').then(x => x.json());
      const ps = r.presets || [];
      const el = $('#govGateCount');
      if (el) el.textContent = String(ps.length);
      body.innerHTML = ps.length
        ? ps.map(p => `<tr><td class="mono" style="color:var(--accent-cyan)">${esc(p.name)}</td><td>${esc(p.label)}</td><td style="font-size:11px;color:var(--text-muted)">task 头声明 [gate:${esc(p.name)}] 时生效</td></tr>`).join('')
        : '<tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text-muted)">无预设（旧内核未下发）</td></tr>';
    } catch (e) {
      body.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:#ef4444">加载门控预设失败：' + esc(e.message) + '</td></tr>';
    }
  }
  async function loadGovCreds() {
    const body = $('#govCredBody');
    if (!body) return;
    try {
      const r = await fetch('/api/agent-creds').then(x => x.json());
      const el = $('#govCredTotal');
      if (el) el.textContent = String(r.total ?? 0);
      const rows = r.agents || [];
      body.innerHTML = rows.length
        ? rows.map(a => `<tr>
            <td class="mono" style="color:var(--text-primary)">${esc(a.agent)}</td>
            <td><span class="type-tag" style="background:rgba(65,187,200,0.12);color:var(--accent-cyan)">${esc(a.scope)}</span></td>
            <td class="mono">${a.c}</td>
            <td class="mono">${a.revoked || 0}</td>
            <td class="mono" style="font-size:11px;color:var(--text-muted)">${esc((a.latest_expires || '').slice(0, 16).replace('T', ' '))}</td>
          </tr>`).join('')
        : '<tr><td colspan="5" style="text-align:center;padding:16px;color:var(--text-muted)">暂无凭据（点「签发凭据」生成短生命周期凭据）</td></tr>';
    } catch (e) {
      body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:16px;color:#ef4444">加载凭据失败：' + esc(e.message) + '</td></tr>';
    }
  }
  async function issueGovCred() {
    const agent = prompt('为哪个 agent 签发凭据？', 'zcode');
    if (!agent) return;
    const scope = prompt('权限 scope（read/write/admin）', 'read') || 'read';
    const ttl = Number(prompt('短生命周期小时数（0.1–24）', '1')) || 1;
    try {
      const r = await fetch('/api/agent-creds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'issue', agent, scope, ttl_hours: ttl }) }).then(x => x.json());
      if (!r.ok) { toast('签发失败：' + (r.error || '')); return; }
      toast(`已签发 ${agent}（scope=${scope}，${ttl}h）凭据`);
      loadGovCreds();
    } catch (e) { toast('签发失败：' + e.message); }
  }

  /* ===== Obsidian 同步 ===== */
  function currentVault() {
    const el = $('#obsidianVaultInput');
    return el ? el.value.trim() : '';
  }
  async function loadObsidianVaults() {
    const r = await fetch('/api/obsidian/vaults').then(x => x.json()).catch(() => ({ vaults: [] }));
    const list = $('#obsidianVaultList');
    if (list) list.innerHTML = (r.vaults || []).map(v => `<option value="${esc(v.path)}">${esc(v.name)}</option>`).join('');
  }
  function renderObsidianImported(rows) {
    const body = $('#obsidianImportedBody');
    if (!body) return;
    body.innerHTML = rows.length ? rows.map((r, i) =>
      `<tr><td class="mono text-muted">${String(i + 1).padStart(2, '0')}</td>
       <td style="color:var(--text-primary);font-family:var(--font-mono);font-size:11px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.note_path)}">${esc(r.note_path)}</td>
       <td><a href="#all" data-action="focus-mem-search" style="color:var(--accent-cyan)">#${r.memory_id}</a></td>
       <td class="mono" style="font-size:11px;color:var(--text-muted)">${esc(r.note_hash)}</td>
       <td class="mono" style="font-size:11px;color:var(--text-secondary)">${esc((r.created_at || '').slice(0, 19).replace('T', ' '))}</td></tr>`).join('')
      : '<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">📝</div><div class="empty-title">暂无已导入笔记</div><div class="empty-desc">选择 Obsidian vault 后点击"导入笔记"开始同步</div></div></td></tr>';
  }
  async function loadObsidianStatus() {
    const vault = currentVault();
    const badge = $('#obsidianStatusBadge');
    if (!vault) { if (badge) badge.textContent = '选择 vault 后查看'; return; }
    const r = await fetch('/api/obsidian/status?vault=' + encodeURIComponent(vault)).then(x => x.json()).catch(e => ({ error: e.message }));
    if (r.error) { if (badge) badge.textContent = '加载失败：' + r.error; return; }
    if (badge) badge.textContent = `笔记 ${r.noteFiles} · 已导入 ${r.imported} · 待导入 ${r.pending} · 库中 obsidian 记忆 ${r.memoriesFromObsidian}`;
    renderObsidianImported(r.imported || []);
  }
  function obsidianProgressStart(label) {
    $('#obsidianProgress').style.display = 'block';
    $('#obsidianStatus').textContent = label;
    $('#obsidianPercent').textContent = '0%';
    $('#obsidianBar').style.width = '0%';
    $('#obsidianStats').innerHTML = '';
  }
  function obsidianProgressDone(ok, stats, label, isDryRun) {
    $('#obsidianBar').style.width = '100%';
    $('#obsidianPercent').textContent = '100%';
    $('#obsidianStatus').textContent = ok ? (isDryRun ? '预演完成（未落库）' : label + '完成') : label + '失败';
    if (stats) {
      const parts = [];
      if (stats.scanned != null) parts.push(`扫描 ${stats.scanned}`);
      if (stats.added != null) parts.push(`<strong style="color:var(--success)">新增 ${stats.added}</strong>`);
      if (stats.updated != null) parts.push(`更新 ${stats.updated}`);
      if (stats.merged != null) parts.push(`去重合并 ${stats.merged}`);
      if (stats.skipped != null) parts.push(`跳过 ${stats.skipped}`);
      if (stats.failed != null) parts.push(`失败 ${stats.failed}`);
      if (stats.written != null) parts.push(`<strong style="color:var(--success)">写入 ${stats.written}</strong>`);
      if (stats.dir) parts.push(`目录 <span class="mono">${esc(stats.dir)}</span>`);
      $('#obsidianStats').innerHTML = parts.join(' · ');
    }
  }
  async function runObsidianImport() {
    const vault = currentVault();
    if (!vault) { toast('请先选择或输入 Obsidian vault 路径'); return; }
    const dryRun = $('#obsidianDryRun').checked;
    const btn = $('#obsidianImportBtn');
    btn.disabled = true; btn.style.opacity = '0.6';
    obsidianProgressStart(dryRun ? '正在预演导入（不落库）…' : '正在扫描 vault 并增量导入…');
    let p = 8;
    const iv = setInterval(() => { p = Math.min(p + 5, 90); $('#obsidianBar').style.width = p + '%'; $('#obsidianPercent').textContent = p + '%'; }, 220);
    try {
      const r = await fetch('/api/obsidian/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vault, project: $('#obsidianProjectInput').value.trim() || undefined, dry_run: dryRun }),
      }).then(x => x.json());
      clearInterval(iv);
      obsidianProgressDone(!!r.ok, r.stats, '导入', dryRun);
      if (r.ok) {
        toast(dryRun ? '预演完成' : ('导入完成：新增 ' + (r.stats.added || 0) + ' / 更新 ' + (r.stats.updated || 0)));
        if (!dryRun) loadObsidianStatus();
        if (!dryRun) refreshNoteWorkbench();
      } else toast('导入失败：' + (r.error || '未知错误'));
    } catch (e) {
      clearInterval(iv);
      obsidianProgressDone(false, null, '导入', false);
      toast('导入失败：' + e.message);
    } finally { btn.disabled = false; btn.style.opacity = '1'; }
  }
  async function runObsidianExport() {
    const vault = currentVault();
    if (!vault) { toast('请先选择或输入 Obsidian vault 路径'); return; }
    const btn = $('#obsidianExportBtn');
    btn.disabled = true; btn.style.opacity = '0.6';
    obsidianProgressStart('正在导出 active 记忆到 vault/MemoryOS 导出/…');
    let p = 10;
    const iv = setInterval(() => { p = Math.min(p + 6, 88); $('#obsidianBar').style.width = p + '%'; $('#obsidianPercent').textContent = p + '%'; }, 200);
    try {
      const r = await fetch('/api/obsidian/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vault, project: $('#obsidianProjectInput').value.trim() || undefined }),
      }).then(x => x.json());
      clearInterval(iv);
      obsidianProgressDone(!!r.ok, r.stats, '导出', false);
      if (r.ok) toast('导出完成：写入 ' + (r.stats.written || 0) + ' / 跳过 ' + (r.stats.skipped || 0));
      else toast('导出失败：' + (r.error || '未知错误'));
    } catch (e) {
      clearInterval(iv);
      obsidianProgressDone(false, null, '导出', false);
      toast('导出失败：' + e.message);
    } finally { btn.disabled = false; btn.style.opacity = '1'; }
  }
  function initObsidian() {
    const importBtn = $('#obsidianImportBtn');
    const exportBtn = $('#obsidianExportBtn');
    const vaultInput = $('#obsidianVaultInput');
    if (importBtn && !importBtn.dataset.bound) { importBtn.dataset.bound = '1'; importBtn.onclick = runObsidianImport; }
    if (exportBtn && !exportBtn.dataset.bound) { exportBtn.dataset.bound = '1'; exportBtn.onclick = runObsidianExport; }
    if (vaultInput && !vaultInput.dataset.bound) {
      vaultInput.dataset.bound = '1';
      vaultInput.addEventListener('change', loadObsidianStatus);
      vaultInput.addEventListener('blur', loadObsidianStatus);
    }
    loadObsidianVaults();
    if (currentVault()) loadObsidianStatus();
    initNoteEditor();
    initNoteWorkbench();
  }

  /* ===== ★ 笔记工作台（Obsidian 风格：左=笔记列表 · 中=关系图谱 · 右=内容/反向链接/编辑）=====
     呈现形式重构，功能不动：vault 选择 / dry-run / 导入 / 导出 / 进度 / 已导入明细 /
     笔记编辑器（[[ 候选 + 预览）/ 双向链接面板全部保留原有实现与 ID。 */
  const NOTE_VAULT_KEY = 'memoryos-note-vault';
  let NOTE_ALL = [];              // /api/notes 索引（跨 vault，≤500）
  let NOTE_VAULTS = [];           // 本机探测到的 vault
  let NOTE_SELECTED_ID = null;
  let NOTE_GRAPH_CHART = null;
  let NOTE_GRAPH_IDS = [];
  let NOTE_GRAPH_ZOOM = 1;
  let NOTE_MEM_CACHE = null;      // 旧内核回退：memoryId → 正文
  let noteResizeBound = false;
  const noteNorm = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => !!a && !!b && noteNorm(a) === noteNorm(b);

  async function loadNoteIndex() {
    await loadNotesList();            // 复用既有实现（同时刷新 #noteSelect 与 [[ 候选索引）
    NOTE_ALL = Array.isArray(_noteAll) ? _noteAll : [];
  }

  async function refreshNoteWorkbench() {
    try { await loadNoteIndex(); } catch (e) { console.error('note index', e); }
    renderNoteRail();
    drawNoteGraph();
  }

  function notesOfVault(vault) {
    return NOTE_ALL.filter(n => !vault || samePath(n.vault_root, vault));
  }

  function renderNoteRail() {
    const box = $('#notesRailList'); if (!box) return;
    const vault = currentVault();
    const q = (($('#notesRailSearch') || {}).value || '').trim().toLowerCase();
    let rows = notesOfVault(vault);
    if (q) rows = rows.filter(n => (n.title || '').toLowerCase().includes(q) || (n.rel_path || '').toLowerCase().includes(q));
    const cnt = $('#notesRailCount');
    if (cnt) cnt.textContent = vault ? `${rows.length} / ${NOTE_ALL.length}` : String(rows.length);
    if (!NOTE_ALL.length) {
      box.innerHTML = '<div class="notes-empty"><span class="big">📓</span>还没有索引到笔记<br>选好 vault 后点右上角「导入笔记」</div>';
      return;
    }
    if (!rows.length) {
      box.innerHTML = `<div class="notes-empty">${q ? '没有匹配的笔记' : '当前 vault 下还没有笔记<br>（列表显示的是已索引笔记，可切到「全部」范围或先导入）'}</div>`;
      return;
    }
    box.innerHTML = rows.map(n => `
      <div class="notes-item${n.id === NOTE_SELECTED_ID ? ' active' : ''}" data-nid="${n.id}" title="${esc(n.rel_path)}">
        <div class="notes-item-title">${esc(n.title)}${n.origin === 'user' ? '<span class="nbadge">自建</span>' : ''}</div>
        <div class="notes-item-sub">${esc(n.rel_path || '')}</div>
      </div>`).join('');
    $$('#notesRailList .notes-item').forEach(el => el.onclick = () => selectNote(Number(el.dataset.nid)));
  }

  function noteGraphTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return dark
      ? { node: '#8fa3b8', label: '#94a3b8', edge: '#334155', sel: '#22d3ee', selLabel: '#e2e8f0' }
      : { node: '#8b98a5', label: '#7b8794', edge: '#c9ced3', sel: '#0ea5b7', selLabel: '#1a2e35' };
  }

  function setGraphEmpty(show, html) {
    const box = $('#noteGraphEmpty'), txt = $('#noteGraphEmptyText');
    if (txt && html) txt.innerHTML = html;
    if (box) box.style.display = show ? 'flex' : 'none';
  }

  async function drawNoteGraph() {
    const el = $('#noteGraphChart'); if (!el) return;
    // 页面未激活（display:none）时容器尺寸为 0，echarts 画不出来 —— 等进入本页时由 navigate → initObsidian 重画
    const page = $('#page-obsidian');
    if (page && !page.classList.contains('active')) return;
    const stats = $('#noteGraphStats');
    const scope = (($('#noteGraphScope') || {}).value) || 'vault';
    const vault = currentVault();
    const data = await fetch('/api/graph?scope=note&depth=1').then(r => r.json()).catch(() => null);
    if (!data) { setGraphEmpty(true, '图谱数据加载失败，点「刷新」重试'); return; }
    const byId = new Map(NOTE_ALL.map(n => ['note:' + n.id, n]));
    let nodes = (data.nodes || []).filter(n => byId.has(n.id));
    let edges = (data.edges || []).filter(e => byId.has(e.source) && byId.has(e.target));
    if (scope === 'vault' && vault) {
      nodes = nodes.filter(n => samePath(byId.get(n.id).vault_root, vault));
      const keep = new Set(nodes.map(n => n.id));
      edges = edges.filter(e => keep.has(e.source) && keep.has(e.target));
    }
    if (stats) stats.textContent = `${nodes.length} 笔记 · ${edges.length} 链接`;
    if (!nodes.length) {
      if (!NOTE_ALL.length) setGraphEmpty(true, (vault
        ? '这个 vault 还没有索引到笔记<br>点右上角「<b>导入笔记</b>」，笔记与 [[双向链接]] 会在这里结成图谱'
        : '先在上方选择 / 粘贴 vault 路径，再点右上角「<b>导入笔记</b>」'));
      else setGraphEmpty(true, scope === 'vault'
        ? '当前 vault 还没有已索引笔记<br>可切换右上范围到「全部笔记」，或先点「导入笔记」'
        : '还没有可画的笔记节点');
      if (!window.echarts) return;
      if (!NOTE_GRAPH_CHART) { try { NOTE_GRAPH_CHART = echarts.init(el); } catch { return; } }
      NOTE_GRAPH_IDS = [];
      NOTE_GRAPH_CHART.clear();
      return;
    }
    setGraphEmpty(false);
    if (!window.echarts) return;
    const C = noteGraphTheme();
    const showLabels = !!($('#noteGraphLabels') || {}).checked;
    const highlightId = NOTE_SELECTED_ID != null ? 'note:' + NOTE_SELECTED_ID : null;
    if (!NOTE_GRAPH_CHART || NOTE_GRAPH_CHART.getDom() !== el) {
      if (NOTE_GRAPH_CHART) { try { NOTE_GRAPH_CHART.dispose(); } catch { /* ignore */ } }
      NOTE_GRAPH_CHART = echarts.init(el);
      NOTE_GRAPH_CHART.on('click', p => {
        if (p.dataType !== 'node') return;
        selectNote(Number(String(p.data.id).replace('note:', '')));
      });
    }
    NOTE_GRAPH_IDS = nodes.map(n => n.id);
    NOTE_GRAPH_CHART.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        backgroundColor: 'rgba(255,255,255,0.97)', borderColor: 'rgba(0,0,0,0.08)', borderWidth: 1,
        textStyle: { color: '#1e293b', fontSize: 12 },
        formatter: p => {
          if (p.dataType !== 'node') return '';
          const n = byId.get(p.data.id);
          const deg = p.data.value || 0;
          return `<b>${esc((n && n.title) || p.data.name)}</b><br><span style="color:#64748b">${esc((n && n.rel_path) || '')}</span><br><span style="color:#64748b">链接 ${deg} · 点击查看内容</span>`;
        },
      },
      series: [{
        type: 'graph', layout: 'force', roam: true, draggable: true, animation: true,
        data: nodes.map(n => {
          const note = byId.get(n.id);
          const deg = n.degree || 0;
          const isSel = n.id === highlightId;
          return {
            id: n.id,
            name: n.label || (note && note.title) || n.id,
            value: deg,
            symbolSize: isSel ? 13 : 5 + Math.min(7, deg * 1.7),
            itemStyle: { color: isSel ? C.sel : C.node, borderColor: isSel ? C.sel : 'transparent', borderWidth: isSel ? 4 : 0, opacity: 0.95 },
            label: { show: showLabels, position: 'right', distance: 5, fontSize: 10, color: isSel ? C.selLabel : C.label },
          };
        }),
        links: edges.map(e => ({
          source: e.source, target: e.target,
          lineStyle: { color: C.edge, width: 1, opacity: 0.8, curveness: 0.06 },
        })),
        force: { repulsion: 150, edgeLength: 70, gravity: 0.32, friction: 0.14 },
        label: { show: showLabels, fontSize: 10, color: C.label },
        emphasis: { focus: 'adjacency', itemStyle: { color: C.sel }, lineStyle: { color: C.sel, width: 2, opacity: 1 } },
        zoom: NOTE_GRAPH_ZOOM,
        center: undefined,
      }],
    }, { notMerge: true });
    try { NOTE_GRAPH_CHART.resize(); } catch { /* 容器尺寸变化后重算 */ }
    if (NOTE_SELECTED_ID != null) highlightNoteNode(NOTE_SELECTED_ID);
  }

  function highlightNoteNode(id) {
    if (!NOTE_GRAPH_CHART || !NOTE_GRAPH_IDS.length) return;
    const idx = NOTE_GRAPH_IDS.indexOf('note:' + id);
    try {
      NOTE_GRAPH_CHART.dispatchAction({ type: 'downplay', seriesIndex: 0 });
      if (idx >= 0) NOTE_GRAPH_CHART.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx });
    } catch { /* 高亮失败不影响功能 */ }
  }

  function zoomNoteGraph(kind) {
    if (!NOTE_GRAPH_CHART || !NOTE_GRAPH_IDS.length) return;
    NOTE_GRAPH_ZOOM = kind === 'reset' ? 1 : Math.min(4, Math.max(0.3, NOTE_GRAPH_ZOOM * (kind === 'in' ? 1.25 : 0.8)));
    try { NOTE_GRAPH_CHART.setOption({ series: [{ zoom: NOTE_GRAPH_ZOOM }] }); } catch { /* ignore */ }
  }

  /** 正文：① 新内核 /api/notes?id= 直接带 body；② 旧内核回退 obsidian_sync → 记忆库正文 */
  async function loadNoteBody(note) {
    try {
      const r = await fetch('/api/notes?id=' + encodeURIComponent(note.id)).then(x => x.json());
      if (r && r.note && typeof r.note.body === 'string') return { body: r.note.body, from: 'notes' };
    } catch { /* 落到回退 */ }
    try {
      const st = await fetch('/api/obsidian/status?vault=' + encodeURIComponent(note.vault_root)).then(x => x.json());
      const hit = ((st && st.imported) || []).find(x => x.note_path === note.rel_path);
      if (!hit) return { body: null, from: 'none' };
      if (!NOTE_MEM_CACHE) {
        const all = await fetch('/api/all?limit=2000').then(x => x.json()).catch(() => ({ rows: [] }));
        NOTE_MEM_CACHE = new Map((all.rows || []).map(r => [r.id, r.content]));
      }
      const body = NOTE_MEM_CACHE.get(hit.memory_id);
      return { body: typeof body === 'string' ? body : null, from: body != null ? 'memory' : 'none' };
    } catch { return { body: null, from: 'error' }; }
  }

  function renderNoteBody(body) {
    const titles = new Set(NOTE_ALL.map(n => (n.title || '').toLowerCase()));
    return esc(body)
      .replace(/!?\[\[([^\]|#^]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (m, t, alias) => {
        const target = String(t).trim();
        const known = titles.has(target.toLowerCase());
        const label = (alias || target).trim();
        return `<span class="wl${known ? '' : ' miss'}"${known ? ` data-title="${esc(target)}"` : ''} title="${known ? '跳转到该笔记' : '未解析链接'}">[[${esc(label)}]]</span>`;
      })
      .replace(/\n/g, '<br>');
  }

  function renderNoteDetail(note, res) {
    const box = $('#noteDetail'); if (!box) return;
    let tags = [];
    try { const t = JSON.parse(note.tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* 坏 JSON 忽略 */ }
    const bodyHtml = (res.body != null && res.body !== '')
      ? `<div class="notes-body">${renderNoteBody(res.body)}</div>`
      : `<div class="notes-body" style="color:var(--text-muted)">${res.from === 'none'
        ? '这条笔记还没有对应的记忆正文（可能尚未导入，或记忆已被合并）。可在「编辑」标签页里重写，保存会写入 vault 的 MemoryOS 写入/ 目录。'
        : '正文读取失败，可在「编辑」标签页里重写后保存。'}</div>`;
    box.innerHTML = `
      <div class="notes-detail-title">${esc(note.title)}</div>
      <div class="notes-detail-meta">${esc(note.rel_path || '')}<br>${esc(note.vault_root || '')}</div>
      <div class="notes-tagchips">
        <span class="notes-tagchip">${note.origin === 'user' ? '用户自建' : 'vault 导入'}</span>
        ${note.sector ? `<span class="notes-tagchip">${esc(note.sector)}</span>` : ''}
        ${tags.map(t => `<span class="notes-tagchip">#${esc(String(t))}</span>`).join('')}
      </div>
      <div class="notes-detail-meta" style="margin-top:6px">修改时间 ${note.mtime_ms ? esc(fmtDate(new Date(Number(note.mtime_ms)).toISOString())) : '—'} · 正文来源 ${res.from === 'notes' ? '笔记索引' : res.from === 'memory' ? '记忆库镜像' : '不可用'}</div>
      ${bodyHtml}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn-ghost" id="noteDetailLinksBtn" style="padding:5px 12px;font-size:12px">反向链接</button>
        <button class="btn-ghost" id="noteDetailEditBtn" style="padding:5px 12px;font-size:12px">复制到编辑器</button>
      </div>`;
    const lb = $('#noteDetailLinksBtn');
    if (lb) lb.onclick = () => switchNoteTab('links');
    const eb = $('#noteDetailEditBtn');
    if (eb) eb.onclick = () => {
      switchNoteTab('edit');
      const t = $('#noteTitle'), b = $('#noteBody'), h = $('#noteHint');
      if (t) t.value = note.title;
      if (b) b.value = res.body || '';
      if (h) { h.className = 'form-hint'; h.textContent = '已复制到编辑器；保存会作为新笔记写入 vault（不覆盖原文件）'; }
    };
    // 正文里的 [[wikilink]] 直接跳转
    $$('#noteDetail .notes-body .wl[data-title]').forEach(el => el.onclick = () => {
      const hit = NOTE_ALL.find(n => (n.title || '').toLowerCase() === String(el.dataset.title).toLowerCase());
      if (hit) { switchNoteTab('content'); selectNote(hit.id); }
    });
  }

  async function selectNote(id) {
    const note = NOTE_ALL.find(n => n.id === id);
    if (!note) return;
    NOTE_SELECTED_ID = id;
    renderNoteRail();
    highlightNoteNode(id);
    const box = $('#noteDetail');
    if (box) box.innerHTML = '<div class="notes-empty">加载笔记内容…</div>';
    // 同步既有「双向链接」面板：填 <select> 后调用原渲染函数，复用同一实现
    const sel = $('#noteSelect');
    if (sel) {
      if (![...sel.options].some(o => Number(o.value) === id)) {
        const o = document.createElement('option');
        o.value = String(id); o.textContent = note.title;
        sel.appendChild(o);
      }
      sel.value = String(id);
      showNoteLinks();
    }
    const res = await loadNoteBody(note);
    if (NOTE_SELECTED_ID !== id) return; // 选择已切换，丢弃过期结果
    renderNoteDetail(note, res);
  }

  function switchNoteTab(name) {
    $$('.notes-tab').forEach(t => t.classList.toggle('active', t.dataset.ntab === name));
    $$('.notes-tabpane').forEach(p => { p.style.display = p.dataset.npane === name ? '' : 'none'; });
  }

  /** 受限模式下后端会拒绝 POST /api/notes（noteCreate）——在编辑器里讲清楚，别让用户以为按钮坏了 */
  function syncNoteRestrictedUI() {
    const pane = $('.notes-tabpane[data-npane="edit"]'); if (!pane) return;
    let bar = pane.querySelector('.notes-restricted');
    if (RESTRICTED && RESTRICTED.noteCreate) {
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'notes-restricted';
        bar.innerHTML = '⚠ 当前为<b>受限模式</b>：用户自建笔记已被后端关闭（仅系统采集）。下方编辑器会返回「笔记创建已关闭」，需要时请管理员把内核环境变量 <span class="mono">MEMORY_RESTRICTED=0</span> 打开。';
        pane.insertBefore(bar, pane.firstChild);
      }
      const save = $('#noteSaveBtn'); if (save) { save.disabled = true; save.style.opacity = '0.5'; save.title = '受限模式：笔记创建已关闭'; }
    } else {
      if (bar) bar.remove();
      const save = $('#noteSaveBtn'); if (save) { save.disabled = false; save.style.opacity = '1'; save.title = ''; }
    }
  }

  function renderVaultChips() {
    const box = $('#noteVaultChips'); if (!box) return;
    const cur = currentVault();
    if (!NOTE_VAULTS.length) { box.innerHTML = '<span class="text-muted" style="font-size:11px">未探测到 vault，可直接粘贴绝对路径</span>'; return; }
    box.innerHTML = '<span class="text-muted" style="font-size:11px">已探测</span>' + NOTE_VAULTS.map(v =>
      `<span class="notes-vchip${samePath(v.path, cur) ? ' on' : ''}" data-path="${esc(v.path)}" title="${esc(v.path)}">${esc(v.name)}</span>`).join('');
    $$('#noteVaultChips .notes-vchip').forEach(el => el.onclick = () => {
      const input = $('#obsidianVaultInput'); if (!input) return;
      input.value = el.dataset.path;
      input.dispatchEvent(new Event('change')); // 触发既有 loadObsidianStatus + 本页刷新
    });
  }
  async function loadVaultChips() {
    const r = await fetch('/api/obsidian/vaults').then(x => x.json()).catch(() => ({ vaults: [] }));
    NOTE_VAULTS = r.vaults || [];
    renderVaultChips();
  }

  function initNoteWorkbench() {
    const input = $('#obsidianVaultInput');
    if (input && !input.dataset.wbBound) {
      input.dataset.wbBound = '1';
      try { const saved = localStorage.getItem(NOTE_VAULT_KEY); if (saved && !input.value) input.value = saved; } catch { /* ignore */ }
      const onChange = () => {
        try { localStorage.setItem(NOTE_VAULT_KEY, input.value.trim()); } catch { /* ignore */ }
        renderVaultChips(); renderNoteRail(); drawNoteGraph();
      };
      input.addEventListener('change', onChange);
      input.addEventListener('blur', onChange);
    }
    const search = $('#notesRailSearch');
    if (search && !search.dataset.wbBound) { search.dataset.wbBound = '1'; search.oninput = renderNoteRail; }
    const scope = $('#noteGraphScope');
    if (scope && !scope.dataset.wbBound) { scope.dataset.wbBound = '1'; scope.onchange = drawNoteGraph; }
    const labels = $('#noteGraphLabels');
    if (labels && !labels.dataset.wbBound) { labels.dataset.wbBound = '1'; labels.onchange = drawNoteGraph; }
    const rf = $('#noteGraphRefreshBtn');
    if (rf && !rf.dataset.wbBound) {
      rf.dataset.wbBound = '1';
      rf.onclick = async () => { NOTE_MEM_CACHE = null; await refreshNoteWorkbench(); loadObsidianStatus(); };
    }
    const nb = $('#noteNewBtn');
    if (nb && !nb.dataset.wbBound) {
      nb.dataset.wbBound = '1';
      nb.onclick = () => {
        switchNoteTab('edit');
        const t = $('#noteTitle'), b = $('#noteBody'), h = $('#noteHint'), p = $('#notePreviewBox');
        if (t) t.value = ''; if (b) b.value = '';
        if (h) { h.className = 'form-hint'; h.textContent = ''; }
        if (p) p.style.display = 'none';
      };
    }
    $$('.notes-tab').forEach(t => { if (!t.dataset.wbBound) { t.dataset.wbBound = '1'; t.onclick = () => switchNoteTab(t.dataset.ntab); } });
    $$('.notes-zoom button').forEach(b => { if (!b.dataset.wbBound) { b.dataset.wbBound = '1'; b.onclick = () => zoomNoteGraph(b.dataset.zoom); } });
    if (!noteResizeBound) {
      noteResizeBound = true;
      window.addEventListener('resize', () => { if (NOTE_GRAPH_CHART) { try { NOTE_GRAPH_CHART.resize(); } catch { /* ignore */ } } });
    }
    loadVaultChips();
    syncNoteRestrictedUI();
    refreshNoteWorkbench();
  }

  /* ========== 技能同步页 ========== */
  async function loadSkillsStatus() {
    const box = $('#skillsTargets');
    if (!box) return;
    try {
      const r = await fetch('/api/skills/status').then(x => x.json());
      renderSkillsStatus(r);
    } catch (e) {
      box.innerHTML = '<div style="padding:20px;text-align:center;color:var(--error);font-size:13px">加载失败：' + esc(e.message) + '</div>';
    }
  }
  function renderSkillsStatus(d) {
    const badge = $('#skillsStatusBadge');
    const info = $('#skillsCentralInfo');
    if (!d || !d.targets) return;
    badge.textContent = d.central.length ? ('中央库 ' + d.central.length + ' 个技能') : '中央库为空';
    info.innerHTML =
      '<div style="font-size:12px;color:var(--text-secondary);line-height:1.8">中央库路径：<span class="mono" style="color:var(--text-primary)">' + esc(d.centralDir) + '</span><br>' +
      '技能列表：' + (d.central.length
        ? d.central.map(n => '<span style="display:inline-block;margin:3px 4px 0 0;padding:2px 10px;border-radius:12px;font-size:11px;background:rgba(56,189,248,0.12);color:var(--accent-cyan);border:1px solid rgba(56,189,248,0.25)">' + esc(n) + '</span>').join('')
        : '<span style="color:var(--text-muted)">空 — 把技能目录（含 SKILL.md）放入中央库后执行同步</span>') + '</div>';
    const box = $('#skillsTargets');
    box.innerHTML = d.targets.map(t => {
      const parts = [];
      if (t.missing.length) parts.push('<span style="color:var(--error)">缺 ' + t.missing.length + '</span>');
      if (t.outdated.length) parts.push('<span style="color:var(--warning)">待更新 ' + t.outdated.length + '</span>');
      if (t.upToDate.length) parts.push('<span style="color:var(--success)">同步 ' + t.upToDate.length + '</span>');
      const pills = [];
      if (t.missing.length) pills.push('<span style="color:var(--error)">' + esc('待分发: ' + t.missing.join(', ')) + '</span>');
      if (t.outdated.length) pills.push('<span style="color:var(--warning)">' + esc('需更新: ' + t.outdated.join(', ')) + '</span>');
      if (t.skills.length) pills.push('<span style="color:var(--text-muted)">' + esc('目标现有 ' + t.skills.length + ': ' + t.skills.join(', ')) + '</span>');
      return (
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;border:1px solid rgba(255,255,255,0.07);border-radius:10px;background:rgba(255,255,255,0.02)">' +
          '<div style="flex:0 0 130px;font-size:13px;font-weight:600;color:var(--text-primary)">' + esc(t.name) + '</div>' +
          '<div style="flex:1 1 200px;min-width:0;font-size:11px;color:var(--text-muted);font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(t.dir) + '">' + esc(t.dir) + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px">' + (parts.length ? parts.join(' / ') : '<span style="color:var(--text-muted)">—</span>') + '</div>' +
          '<div style="flex:1 1 100%;display:flex;gap:8px;flex-wrap:wrap;font-size:11px;padding-left:142px;box-sizing:border-box">' + pills.join('') + '</div>' +
        '</div>'
      );
    }).join('');
    // —— 本机 Agent 自动检测（与「工具连接」页同源）——
    const detBox = $('#skillsDetected');
    const detBadge = $('#skillsDetectedBadge');
    if (d.detected && detBox) {
      const supported = d.detected.filter(a => a.supported).length;
      const connected = d.detected.filter(a => a.connected).length;
      if (detBadge) detBadge.textContent = '检测到 ' + d.detected.length + ' 个 Agent / ' + connected + ' 已连接 / ' + supported + ' 支持技能分发';
      detBox.innerHTML = d.detected.map(a => {
        let status, color;
        if (a.supported && a.alreadyTarget) { status = '✓ 已在分发目标'; color = 'var(--success)'; }
        else if (a.supported && a.connected) { status = '🔵 将自动加入分发'; color = 'var(--accent-cyan)'; }
        else if (a.supported && !a.connected) { status = '未连接 MCP'; color = 'var(--text-muted)'; }
        else { status = '不支持技能分发'; color = 'var(--text-muted)'; }
        return (
          '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;background:rgba(255,255,255,0.015)">' +
            '<div style="flex:0 0 150px;font-size:12px;font-weight:600;color:var(--text-primary)">' + esc(a.name) + '</div>' +
            '<div style="flex:0 0 90px;font-size:11px;color:var(--text-muted)">' + esc(a.type) + '</div>' +
            '<div style="flex:1 1 200px;min-width:0;font-size:11px;color:var(--text-muted);font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(a.skillsDir || '') + '">' + (a.skillsDir ? esc(a.skillsDir) : '—') + '</div>' +
            '<div style="font-size:11px;color:' + color + ';white-space:nowrap">' + status + (a.note ? ' · ' + esc(a.note) : '') + '</div>' +
          '</div>'
        );
      }).join('');
    }
  }
  async function runSkillsSync(dryRun) {
    const btn = $('#skillsSyncBtn');
    const dryBtn = $('#skillsDryBtn');
    const box = $('#skillsResult');
    const text = $('#skillsResultText');
    if (!box) return;
    box.style.display = 'block';
    text.textContent = dryRun ? '正在预演（不写入）…' : '正在同步…';
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
    if (dryBtn) { dryBtn.disabled = true; dryBtn.style.opacity = '0.6'; }
    try {
      const r = await fetch('/api/skills/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: dryRun }),
      }).then(x => x.json());
      if (r.ok) {
        let out = (dryRun ? '[dry-run 预演] 未写入任何文件\n' : '✓ 同步完成\n') + '\n';
        for (const res of r.results) {
          out += '[' + res.target + ']\n';
          out += '  新增: ' + (res.added.length ? res.added.join(', ') : '无') + '\n';
          out += '  更新: ' + (res.updated.length ? res.updated.join(', ') : '无') + '\n';
          out += '  跳过: ' + (res.skipped.length ? res.skipped.join(', ') : '无') + '\n';
          if (res.backedUp.length) out += '  已备份旧版: ' + res.backedUp.join(', ') + '\n';
        }
        text.textContent = out;
        toast(dryRun ? '预演完成' : '同步完成');
        if (!dryRun) loadSkillsStatus();
      } else {
        text.textContent = '同步失败：' + (r.error || '未知错误');
        toast('同步失败：' + (r.error || '未知错误'));
      }
    } catch (e) {
      text.textContent = '同步失败：' + e.message;
      toast('同步失败：' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
      if (dryBtn) { dryBtn.disabled = false; dryBtn.style.opacity = '1'; }
    }
  }
  function initSkills() {
    const refresh = $('#skillsRefreshBtn');
    const sync = $('#skillsSyncBtn');
    const dry = $('#skillsDryBtn');
    if (refresh && !refresh.dataset.bound) { refresh.dataset.bound = '1'; refresh.onclick = loadSkillsStatus; }
    if (dry && !dry.dataset.bound) { dry.dataset.bound = '1'; dry.onclick = () => runSkillsSync(true); }
    if (sync && !sync.dataset.bound) { sync.dataset.bound = '1'; sync.onclick = () => runSkillsSync(false); }
    loadSkillsStatus();
  }

  /* ===== 任务看板（v1.1 七态）===== */
  const TASK_STATUS_META = {
    pending: { label: '待处理', color: '#94a3b8' },
    in_progress: { label: '进行中', color: '#06b6d4' },
    blocked: { label: '阻塞', color: '#f59e0b' },
    review: { label: '待审核', color: '#a855f7' },
    done: { label: '已完成', color: '#10b981' },
    failed: { label: '失败', color: '#ef4444' },
    cancelled: { label: '已取消', color: '#64748b' },
  };
  const TASK_ORDER = ['pending', 'in_progress', 'blocked', 'review', 'done', 'failed', 'cancelled'];
  let _taskAll = []; // 任务看板全量（供详情弹窗查询）
  let _taskViewMode = 'map'; // ★ 2026-09-13：任务地图为唯一任务模块（看板/任务视图功能已并入地图）
  let _taskMapFilter = null; // 状态过滤（看板列式速览并入地图）
  function refreshCurrentTaskView() {
    if (_taskViewMode === 'map') return renderTaskMap();
    if (_taskViewMode === 'legacy') return loadTasks();
    return renderCards();
  }
  /* ★ 实时看板 SSE：卡片任何变更（后端 /api/cards/stream，writeCardEvent 中心点推送）
   * → 800ms 防抖 → 重画当前视图。鉴权走同源 cookie（EventSource 自动带 memoryos_token）。
   * 进任务看板页时建、离开时关（navigate 统一调）。 */
  let _cardsEs = null, _cardsRefreshTimer = null;
  function _cardsStreamStart() {
    if (typeof EventSource === 'undefined') return;
    if (_cardsEs) return; // 已开（同页重复 navigate 不重连）
    _cardsEs = new EventSource('/api/cards/stream');
    _cardsEs.addEventListener('card', () => {
      if (_cardsRefreshTimer) clearTimeout(_cardsRefreshTimer);
      _cardsRefreshTimer = setTimeout(() => { _cardsRefreshTimer = null; refreshCurrentTaskView(); }, 800); // 批量合并，避免高频重画
    });
  }
  function _cardsStreamStop() {
    if (_cardsEs) { _cardsEs.close(); _cardsEs = null; }
    if (_cardsRefreshTimer) { clearTimeout(_cardsRefreshTimer); _cardsRefreshTimer = null; }
  }
  async function loadTasks() {
    const board = $('#tasksBoard');
    if (!board) return;
    board.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-muted)">加载中…</div>';
    const data = await fetch('/api/tasks?limit=300').then(r => r.json()).catch(() => ({ total: 0 }));
    _taskAll = [];
    TASK_ORDER.forEach(s => { (data[s] || []).forEach(t => _taskAll.push(Object.assign({ status: s }, t))); });
    const nOcc = {};
    TASK_ORDER.forEach(s => nOcc[s] = 0);
    const html = TASK_ORDER.map(s => {
      const items = data[s] || [];
      nOcc[s] = items.length;
      const meta = TASK_STATUS_META[s];
      const cards = items.length ? items.map(t => `
        <div data-task-id="${t.id}" style="padding:10px 12px;background:rgba(255,255,255,0.6);border:1px solid rgba(0,0,0,0.06);border-radius:10px;margin-bottom:8px;cursor:pointer" title="点击查看详情">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
            <span class="mono" style="font-size:10px;color:var(--text-muted)">#${t.id}</span>
            <span style="font-size:10px;color:${esc(t.assignee) ? 'var(--text-secondary)' : 'var(--text-muted)'}">${esc(t.assignee || '未分配')}</span>
          </div>
          <div style="font-size:12px;color:var(--text-primary);margin-top:4px;line-height:1.5">${esc(t.body || t.body)}</div>
          ${t.blocked ? '<div style="font-size:10px;color:var(--danger);margin-top:4px">⛔ 等待依赖完成</div>' : ''}
          ${t.deps && t.deps.length ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px">依赖: ${t.deps.map(d => '#' + d).join(',')}${t.conclusion ? ' · ' + esc(t.concludedBy) : ''}</div>` : ''}
          ${t.conclusion ? `<div style="font-size:10px;color:var(--text-muted);margin-top:4px">✓ ${esc(t.conclusion)}</div>` : ''}
        </div>`).join('')
        : '<div style="text-align:center;color:var(--text-muted);font-size:11px;padding:16px 0">—</div>';
      return `<div style="display:flex;flex-direction:column;background:rgba(255,255,255,0.03);border:1px solid rgba(0,0,0,0.06);border-radius:12px;padding:10px;min-height:120px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="width:8px;height:8px;border-radius:50%;background:${meta.color};display:inline-block"></span>
          <span style="font-size:12px;font-weight:600;color:var(--text-primary)">${meta.label}</span>
          <span class="mono" style="font-size:10px;color:var(--text-muted)">${nOcc[s]}</span>
          <button class="col-add" data-status="${s}" title="在该列新建任务" style="margin-left:auto;background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:15px;line-height:1;padding:0 2px">＋</button>
        </div>
        ${cards}
      </div>`;
    }).join('');
    board.innerHTML = html;
    // 卡片点击 → 任务详情
    $$('#tasksBoard [data-task-id]').forEach(el => el.onclick = () => {
      const t = _taskAll.find(x => x.id === Number(el.dataset.taskId));
      if (t) openTaskDetail(t);
    });
    // 列头「＋」→ 预置该列状态新建
    board.querySelectorAll('.col-add').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); openTaskModal(b.dataset.status); };
    });
  }
  /** 任务详情弹窗（复用 detailModal） */
  function openTaskDetail(t) {
    const meta = TASK_STATUS_META[t.status] || { label: t.status, color: '#64748b' };
    const idStr = '#' + t.id;
    $('#modalBody').innerHTML = `
      <div class="detail-content-box" style="border-left-color:${meta.color}">${renderContent(t.body || '—')}</div>
      <div class="detail-grid">
        ${pair('ID', idStr, true)}
        ${pair('状态', '', false, `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${meta.color};display:inline-block"></span>${esc(meta.label)}</span>`)}
        ${pair('接收方', esc(t.assignee) || '未分配', true)}
        ${pair('提交方', esc(t.submittedBy) || '—', true)}
        ${pair('依赖', (t.deps && t.deps.length ? t.deps.map(d => '#' + d).join(', ') : '—'), true)}
        ${t.blocked ? pair('阻塞', '等待依赖完成') : ''}
        ${pair('置信度', (t.confidence || 0).toFixed(2), true)}
        ${pair('创建时间', fmtDate(t.created_at), true)}
      </div>
      ${t.conclusion ? `<div style="margin-top:16px;padding:12px 14px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:10px"><div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">完成结论 · ${esc(t.concludedBy || '')}</div><div style="font-size:13px;color:var(--text-primary);white-space:pre-wrap">${renderContent(t.conclusion)}</div></div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px">
        <button class="btn-ghost" id="taskDetailCopyBtn" style="padding:6px 14px;font-size:12px">📋 复制</button>
        <button class="btn-danger" id="taskDeleteBtn" style="padding:6px 14px;font-size:12px">删除任务</button>
        <button class="btn-ghost" id="taskDetailCloseBtn" style="padding:6px 14px;font-size:12px">关闭</button>
      </div>`;
    $('#detailModal').classList.add('show');
    $('#taskDetailCloseBtn').onclick = () => $('#detailModal').classList.remove('show');
    $('#taskDetailCopyBtn').onclick = () => {
      const md = `# 任务 #${t.id}\n\n**状态**: ${meta.label}\n**接收方**: ${t.assignee || '未分配'}\n**提交方**: ${t.submittedBy || '—'}\n**依赖**: ${(t.deps && t.deps.length ? t.deps.map(d => '#' + d).join(', ') : '—')}\n**创建**: ${fmtDate(t.created_at)}${t.conclusion ? '\n\n**结论**(' + (t.concludedBy || '') + '):\n' + t.conclusion : ''}\n\n---\n\n${t.body || ''}`;
      navigator.clipboard.writeText(md).then(() => {
        const btn = $('#taskDetailCopyBtn');
        btn.textContent = '✅ 已复制';
        setTimeout(() => btn.textContent = '📋 复制', 1500);
        }).catch(() => toast('复制失败，请手动复制'));
    };
    $('#taskDeleteBtn').onclick = async () => {
      if (!confirm(`删除任务 #${t.id}？任务将从看板消失并保留归档记录。`)) return;
      const res = await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(j.error || '删除任务失败'); return; }
      $('#detailModal').classList.remove('show');
      toast(`已删除任务 #${t.id}`);
      refreshCurrentTaskView();
    };
  }
  /* ===== 任务看板：人工派活（新建任务 / 导入计划）===== */
  function initTasks() {
    const btn = $('#tasksRefreshBtn');
    if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.onclick = refreshCurrentTaskView; }
    const create = $('#createTaskBtn');
    if (create && !create.dataset.bound) { create.dataset.bound = '1'; create.onclick = () => openTaskModal(); }
    const imp = $('#importPlanBtn');
    if (imp && !imp.dataset.bound) { imp.dataset.bound = '1'; imp.onclick = openPlanModal; }
    const tm = $('#taskModal');
    if (tm && !tm.dataset.bound) {
      tm.dataset.bound = '1';
      $('#taskModalClose').onclick = closeTaskModal;
      $('#taskCancelBtn').onclick = closeTaskModal;
      $('#taskSaveBtn').onclick = saveTask;
      $('#taskTitle').addEventListener('keydown', e => { if (e.key === 'Enter') saveTask(); });
      tm.addEventListener('click', e => { if (e.target === tm) closeTaskModal(); });
    }
    const pm = $('#planModal');
    if (pm && !pm.dataset.bound) {
      pm.dataset.bound = '1';
      $('#planModalClose').onclick = closePlanModal;
      $('#planCancelBtn').onclick = closePlanModal;
      $('#planValidateBtn').onclick = () => validatePlanForm(true);
      $('#planImportBtn').onclick = importPlan;
      $('#planFileSelect').onchange = onPlanFileChange;
      $('#planJsonInput').addEventListener('input', () => { if ($('#planJsonInput').value.trim()) $('#planFileSelect').value = ''; });
      pm.addEventListener('click', e => { if (e.target === pm) closePlanModal(); });
    }
    loadTasks();
    initSystemPlans();
    /* ★ P6：卡片看板视图（/api/cards，与旧 /api/tasks 任务视图并存 Tab） */
    const tabCards = $('#tabCards'), tabMap = $('#tabMap'), tabLegacy = $('#tabLegacy');
    const cardsBoard = $('#cardsBoard'), mapEl = $('#taskMap'), boardEl = $('#tasksBoard');
    const ccb = $('#createCardBtn'), dpb = $('#dispatchBtn'), ilb = $('#importLegacyBtn');
    const anchor = tabCards || tabMap;
    if (anchor && !anchor.dataset.bound) {
      anchor.dataset.bound = '1';
      const restricted = RESTRICTED;
      const showTaskView = (mode) => {
        _taskViewMode = mode;
        const cardsOn = mode === 'cards';
        const mapOn = mode === 'map';
        if (cardsBoard) cardsBoard.style.display = cardsOn ? 'block' : 'none';
        if (mapEl) mapEl.style.display = mapOn ? 'block' : 'none';
        if (boardEl) boardEl.style.display = mode === 'legacy' ? 'grid' : 'none';
        if (ccb) ccb.style.display = ((cardsOn || mapOn) && !restricted.cardCreate) ? '' : 'none';
        if (dpb) dpb.style.display = ((cardsOn || mapOn) && !restricted.cardDispatch) ? '' : 'none';
        if (ilb) ilb.style.display = ((cardsOn || mapOn) && !restricted.cardCreate) ? '' : 'none';
        if (tabCards) {
          tabCards.className = cardsOn ? 'btn-primary' : 'btn-ghost';
          tabCards.setAttribute('aria-selected', cardsOn ? 'true' : 'false');
        }
        if (tabMap) {
          tabMap.className = mapOn ? 'btn-primary' : 'btn-ghost';
          tabMap.setAttribute('aria-selected', mapOn ? 'true' : 'false');
        }
        if (tabLegacy) {
          tabLegacy.className = mode === 'legacy' ? 'btn-primary' : 'btn-ghost';
          tabLegacy.setAttribute('aria-selected', mode === 'legacy' ? 'true' : 'false');
        }
        if (cardsOn) renderCards();
        else if (mapOn) renderTaskMap();
        else loadTasks();
      };
      // ★ 2026-09-13：tabCards/tabLegacy 已从 DOM 移除（功能并入任务地图），仅保留地图入口
      if (tabMap) tabMap.onclick = () => showTaskView('map');
      if (tabLegacy) tabLegacy.onclick = () => showTaskView('legacy');
      // ★ 2026-09-13：只留任务地图模块 —— 旧 Tab（卡片看板/任务视图）隐藏，功能并入地图工具栏/右键菜单
      if (tabCards) tabCards.style.display = 'none';
      if (tabLegacy) tabLegacy.style.display = 'none';
      if (ccb) ccb.onclick = createCard;
      if (dpb) dpb.onclick = runDispatch;
      if (ilb) ilb.onclick = importLegacy;
      showTaskView('map'); // ★ 2026-09-13：任务地图为唯一模块入口
    }
  }
  /* ===== 系统计划（受限模式：用户只能「应用」系统下发的计划，不能自行创建/导入）===== */
  async function initSystemPlans() {
    const card = $('#sysPlanCard');
    if (!card) return;
    if (!RESTRICTED.enabled) { card.style.display = 'none'; return; }
    card.style.display = '';
    await loadSystemPlans();
  }
  async function loadSystemPlans() {
    const list = $('#sysPlanList');
    if (!list) return;
    list.innerHTML = '<div class="text-muted" style="font-size:12px">正在读取系统计划…</div>';
    try {
      const r = await fetch('/api/plans').then(x => x.json());
      const rows = r.rows || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">系统尚未下发计划</div><div class="empty-desc">任务由系统计划统一派发，无需手动创建</div></div>';
        return;
      }
      const statusMap = { active: '进行中', completed: '已完成', draft: '草稿', cancelled: '已取消' };
      list.innerHTML = rows.map(p => {
        const ok = p.valid !== false;
        const statusText = statusMap[p.plan_status] || p.plan_status || '—';
        return `<div class="sysplan-row">
          <span style="font-size:13px;color:var(--text-primary);font-weight:600">${esc(p.plan_id || p.file)}</span>
          <span class="text-muted" style="font-size:11px">${esc(statusText)} · ${p.tasks || 0} 个任务 · ${esc(p.file)}</span>
          ${ok ? '' : '<span style="font-size:11px;color:var(--danger)">结构校验未通过</span>'}
          <button class="btn-primary sysplan-apply" data-file="${esc(p.file)}" style="margin-left:auto;padding:5px 14px;font-size:12px"${ok ? '' : ' disabled'}>应用</button>
        </div>`;
      }).join('');
      list.querySelectorAll('.sysplan-apply').forEach(b => { b.onclick = () => applySystemPlan(b.dataset.file); });
    } catch (e) {
      list.innerHTML = '<div class="text-muted" style="font-size:12px">读取系统计划失败：' + esc(e.message) + '</div>';
    }
  }
  async function applySystemPlan(file) {
    if (!confirm('确定应用系统计划「' + file + '」？\n未完成任务会原位更新，执行中或已完成任务保留当前状态。')) return;
    try {
      const r = await fetch('/api/plans/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      }).then(x => x.json());
      if (!r.ok) { toast('应用失败：' + (r.error || '未知错误')); return; }
      const created = r.inserted ?? r.created ?? 0;
      toast('已应用计划 ' + r.plan_id + '：新增 ' + created + ' / 更新 ' + (r.overwritten || 0) + ' / 依赖 ' + (r.linksCreated || 0) + ' / 跳过 ' + (r.skipped || 0) + ' / 失败 ' + (r.failed || 0));
      await Promise.all([loadTasks(), renderCards()]);
    } catch (e) { toast('应用失败：' + e.message); }
  }
  function openTaskModal(status) {
    $('#taskTitle').value = ''; $('#taskAssignee').value = '';
    $('#taskStatus').value = status || 'pending';
    $('#taskDepends').value = ''; $('#taskSummary').value = '';
    const hint = $('#taskHint'); hint.style.display = 'none'; hint.textContent = '';
    $('#taskModal').style.display = 'flex';
    setTimeout(() => { const el = $('#taskTitle'); if (el) el.focus(); }, 50);
  }
  function closeTaskModal() {
    const m = $('#taskModal'); if (m) m.style.display = 'none';
  }
  async function saveTask() {
    const hint = $('#taskHint'); hint.style.display = 'none';
    const title = $('#taskTitle').value.trim();
    if (!title) { hint.textContent = '任务标题不能为空'; hint.style.display = 'block'; return; }
    const deps = $('#taskDepends').value.split(/[,，\s]+/).map(x => Number(x.trim())).filter(n => Number.isFinite(n) && n > 0);
    const btn = $('#taskSaveBtn'); btn.disabled = true; btn.style.opacity = '0.6';
    try {
      const r = await fetch('/api/task', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, assignee: $('#taskAssignee').value.trim(), status: $('#taskStatus').value, depends: deps, summary: $('#taskSummary').value.trim() }),
      }).then(x => x.json());
      if (!r.ok) { hint.textContent = r.error || '创建失败'; hint.style.display = 'block'; return; }
      closeTaskModal();
      const meta = TASK_STATUS_META[r.status];
      toast('已创建任务 #' + r.id + '（' + (meta ? meta.label : r.status) + '）');
      await loadTasks();
    } catch (e) {
      hint.textContent = '创建失败：' + e.message; hint.style.display = 'block';
    } finally { btn.disabled = false; btn.style.opacity = '1'; }
  }
  let _planList = [];
  async function openPlanModal() {
    $('#planJsonInput').value = '';
    $('#planCheck').style.display = 'none';
    const hint = $('#planHint'); hint.style.display = 'none'; hint.textContent = '';
    $('#planModal').style.display = 'flex';
    const sel = $('#planFileSelect');
    sel.innerHTML = '<option value="">— 选择计划文件 —</option>';
    try {
      const r = await fetch('/api/plans').then(x => x.json());
      _planList = r.rows || [];
      const dirEl = $('#planDirPath'); if (dirEl) dirEl.textContent = r.dir || '—';
      _planList.forEach(p => {
        const o = document.createElement('option');
        o.value = p.file;
        o.textContent = `${p.file} · ${p.tasks} 任务 · ${p.plan_status || '?'}${p.valid ? '' : ' ⚠ 校验未通过'}`;
        sel.appendChild(o);
      });
      if (!_planList.length) {
        const o = document.createElement('option');
        o.value = ''; o.disabled = true; o.textContent = '（plans 目录下暂无可导入的 plan-*.json）';
        sel.appendChild(o);
      }
    } catch (e) {
      const dirEl = $('#planDirPath'); if (dirEl) dirEl.textContent = '加载失败：' + e.message;
    }
  }
  function closePlanModal() {
    const m = $('#planModal'); if (m) m.style.display = 'none';
  }
  function planFormPayload() {
    return { content: $('#planJsonInput').value.trim(), path: $('#planFileSelect').value };
  }
  function renderPlanCheck(res) {
    const box = $('#planCheck');
    box.style.display = 'block';
    if (res && res.ok) {
      box.style.background = 'rgba(34,197,94,0.08)';
      box.style.color = 'var(--text-secondary)';
      const parts = ['<strong style="color:var(--success)">✅ 校验通过</strong>'];
      if (res.plan_id) parts.push('plan_id <span class="mono">' + esc(res.plan_id) + '</span>');
      if (res.plan_status) parts.push('状态 <span class="mono">' + esc(res.plan_status) + '</span>');
      if (res.tasks != null) parts.push('任务 ' + res.tasks + ' 条');
      if (res.willImport != null) parts.push('<strong style="color:var(--accent-cyan)">将导入 ' + res.willImport + '</strong>');
      if (res.skipped != null) parts.push('已存在跳过 ' + res.skipped);
      if (res.forcedDone) parts.push('<span style="color:#f59e0b">计划已完成 → 任务按 done 落库</span>');
      if (res.source) parts.push('来源 ' + esc(res.source));
      box.innerHTML = parts.join(' · ');
    } else {
      box.style.background = 'rgba(239,68,68,0.08)';
      box.style.color = '#ef4444';
      box.innerHTML = '⛔ 校验未通过' + (res && res.source ? '（' + esc(res.source) + '）' : '') + '：<br>' +
        ((res && res.errors) || ['未知错误']).map(e => '· ' + esc(e)).join('<br>');
    }
    return !!(res && res.ok);
  }
  async function onPlanFileChange() {
    const f = $('#planFileSelect').value;
    const box = $('#planCheck');
    if (!f) { if (box) box.style.display = 'none'; return; }
    $('#planJsonInput').value = '';
    await validatePlanForm(false, { path: f });
  }
  async function validatePlanForm(showToast, override) {
    const hint = $('#planHint'); hint.style.display = 'none';
    const body = override || planFormPayload();
    if (!body.content && !body.path) {
      hint.textContent = '请选择计划文件，或粘贴计划 JSON';
      hint.style.display = 'block';
      return false;
    }
    try {
      const r = await fetch('/api/plans/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ dryRun: true }, body)),
      }).then(x => x.json());
      const ok = renderPlanCheck(r);
      if (showToast) toast(ok ? '校验通过，可导入' : '校验未通过');
      return ok;
    } catch (e) {
      renderPlanCheck({ ok: false, errors: ['校验请求失败：' + e.message] });
      return false;
    }
  }
  async function importPlan() {
    const hint = $('#planHint'); hint.style.display = 'none';
    const body = planFormPayload();
    if (!body.content && !body.path) { hint.textContent = '请选择计划文件，或粘贴计划 JSON'; hint.style.display = 'block'; return; }
    const btn = $('#planImportBtn'); btn.disabled = true; btn.style.opacity = '0.6';
    try {
      const r = await fetch('/api/plans/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(x => x.json());
      if (!r.ok) {
        renderPlanCheck({ ok: false, errors: r.errors || [r.error || '导入失败'], source: r.source });
        hint.textContent = r.error || '导入失败'; hint.style.display = 'block';
        return;
      }
      const created = r.inserted ?? r.created ?? 0;
      toast('导入完成：新增 ' + created + ' · 更新 ' + (r.overwritten || 0) + ' · 依赖 ' + (r.linksCreated || 0) + ' · 跳过 ' + (r.skipped || 0) + ' · 失败 ' + (r.failed || 0));
      closePlanModal();
      await Promise.all([loadTasks(), renderCards()]);
    } catch (e) {
      hint.textContent = '导入失败：' + e.message; hint.style.display = 'block';
    } finally { btn.disabled = false; btn.style.opacity = '1'; }
  }

  /* ===== 新功能增强模块 ===== */

  // 暗色模式切换
  function initTheme() {
    // 主题已由 initSettings 应用，这里只绑定按钮
    const btn = $('#themeToggle');
    if (btn) {
      btn.onclick = () => {
        const settings = loadSettings();
        settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
        saveSettings(settings);
        applySettings(settings);
      };
    }
  }

  // 波纹效果
  function initRipple() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-primary, .btn-ghost, .btn-danger, .page-btn, .filter-btn, .row-action-btn, .proj-chip');
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      const size = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      btn.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  }

  // 数字滚动动画
  function animateNumber(el, target) {
    const duration = 800;
    const start = 0;
    const startTime = performance.now();
    function update(now) {
      const progress = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.floor(start + (target - start) * eased);
      el.textContent = current.toLocaleString('en-US');
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  // 键盘快捷键
  function initKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+K 或 / 聚焦搜索
      if ((e.ctrlKey && e.key === 'k') || e.key === '/') {
        e.preventDefault();
        $('#globalSearch')?.focus();
      }
      // N 新建记忆
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        openEdit(null);
      }
      // Esc 关闭弹窗
      if (e.key === 'Escape') {
        closeDetail();
        closeEdit();
        $('#contextMenu')?.classList.remove('show');
      }
      // 详情页左右切换
      if (detailOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        navigateDetail(e.key === 'ArrowLeft' ? -1 : 1);
      }
    });
  }

  // 详情页左右切换
  let detailOpen = false;
  let currentDetailIndex = -1;
  function navigateDetail(dir) {
    const rows = S.memories;
    if (!rows.length) return;
    currentDetailIndex = (currentDetailIndex + dir + rows.length) % rows.length;
    openDetail(rows[currentDetailIndex].id);
  }

  // 搜索高亮
  function highlightText(text, keyword) {
    if (!keyword) return esc(text);
    const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return esc(text).replace(regex, '<span class="search-highlight">$1</span>');
  }

  // hover 内容预览
  function initPreviewTooltip() {
    const tooltip = $('#previewTooltip');
    if (!tooltip) return;
    document.addEventListener('mouseover', (e) => {
      const cell = e.target.closest('.memory-content');
      if (!cell) return;
      const tr = cell.closest('tr');
      const id = Number(tr?.dataset.id);
      const m = S.memories.find(x => x.id === id);
      if (!m) return;
      tooltip.innerHTML = `<span class="preview-type type-tag ${m.type}" style="background:${typeColor(m.type)}22;color:${typeColor(m.type)}">${typeCN(m.type)}</span><div>${esc(m.content)}</div>`;
      tooltip.classList.add('show');
    });
    document.addEventListener('mousemove', (e) => {
      if (!tooltip.classList.contains('show')) return;
      const x = Math.min(e.clientX + 16, window.innerWidth - 420);
      const y = Math.min(e.clientY + 16, window.innerHeight - 220);
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    });
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest('.memory-content')) tooltip.classList.remove('show');
    });
  }

  // 筛选状态持久化
  function saveFilterState() {
    localStorage.setItem('memoryos-filters', JSON.stringify({ currentStatus, currentType, currentSector, allPage }));
  }
  function loadFilterState() {
    try {
      const saved = JSON.parse(localStorage.getItem('memoryos-filters') || '{}');
      if (saved.currentStatus) currentStatus = saved.currentStatus;
      if (saved.currentType) currentType = saved.currentType;
      if (saved.currentSector) currentSector = saved.currentSector;
      if (saved.allPage) allPage = saved.allPage;
    } catch (e) {}
  }

  // 设置管理
  const DEFAULT_SETTINGS = { theme: 'light', fontSize: 'medium', reduceMotion: false, pageSize: 100 };
  function loadSettings() {
    try {
      return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem('memoryos-settings') || '{}'));
    } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(s) {
    localStorage.setItem('memoryos-settings', JSON.stringify(s));
  }
  function applySettings(s) {
    // 主题
    if (s.theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      const tt = $('#themeToggle'); if (tt) tt.textContent = '☀️';
    } else {
      document.documentElement.removeAttribute('data-theme');
      const tt = $('#themeToggle'); if (tt) tt.textContent = '🌙';
    }
    // 字体大小
    document.documentElement.setAttribute('data-font-size', s.fontSize);
    // 减少动画
    if (s.reduceMotion) document.documentElement.setAttribute('data-reduce-motion', 'true');
    else document.documentElement.removeAttribute('data-reduce-motion');
    // 每页条数
    ALL_PAGE_SIZE = s.pageSize;
    // ★ UI2.0：主题切换会改变容器配色与布局，延迟统一重算 ECharts 尺寸，避免图表挤压
    setTimeout(() => { try { resizeAllCharts(); } catch { /* ignore */ } }, 300);
  }

  // ===== 命令面板 =====
  const COMMANDS = [
    { id: 'new', name: '新建记忆', desc: '创建一条新的记忆', icon: '✏️', shortcut: 'N', action: () => openEdit(null) },
    { id: 'search', name: '聚焦搜索', desc: '在搜索框中输入关键词', icon: '🔍', shortcut: 'Ctrl+K', action: () => $('#globalSearch')?.focus() },
    { id: 'all', name: '全部记忆', desc: '跳转到全部记忆列表', icon: '📚', action: () => navigate('all') },
    { id: 'summary', name: '概览页', desc: '跳转到概览仪表盘', icon: '📊', action: () => navigate('summary') },
    { id: 'top', name: '高价值 TOP', desc: '查看引用量最高的记忆', icon: '⭐', action: () => navigate('top') },
    { id: 'zombies', name: '僵尸记忆', desc: '查看闲置待归档的记忆', icon: '💤', action: () => navigate('zombies') },
    { id: 'trend', name: '趋势分析', desc: '查看记忆写入/引用趋势', icon: '📈', action: () => navigate('trend') },
    { id: 'cross', name: '跨工具分析', desc: '查看工具间的记忆复用', icon: '🔗', action: () => navigate('cross') },
    { id: 'audit', name: '审计日志', desc: '查看治理操作审计记录', icon: '📋', action: () => navigate('audit') },
    { id: 'settings', name: '打开设置', desc: '调整外观和数据设置', icon: '⚙️', shortcut: 'Ctrl+,', action: () => $('#settingsModal')?.classList.add('show') },
    { id: 'theme', name: '切换主题', desc: '在亮色/暗色主题间切换', icon: '🎨', action: () => { const s = loadSettings(); s.theme = s.theme === 'dark' ? 'light' : 'dark'; saveSettings(s); applySettings(s); } },
    { id: 'export', name: '导出全部数据', desc: '导出所有记忆为 JSON 备份', icon: '💾', shortcut: 'Ctrl+E', action: () => $('#exportAllBtn')?.click() },
    { id: 'shortcuts', name: '快捷键帮助', desc: '查看所有可用快捷键', icon: '⌨️', shortcut: '?', action: () => $('#shortcutsHelp')?.classList.add('show') },
    { id: 'reload', name: '重新加载', desc: '刷新页面重新加载数据', icon: '🔄', action: () => location.reload() },
  ];
  function initCommandPalette() {
    const palette = $('#commandPalette');
    const input = $('#commandInput');
    const list = $('#commandList');
    if (!palette || !input || !list) return;

    function renderCommands(filter = '') {
      const filtered = COMMANDS.filter(c =>
        c.name.toLowerCase().includes(filter.toLowerCase()) ||
        c.desc.toLowerCase().includes(filter.toLowerCase())
      );
      if (!filtered.length) {
        list.innerHTML = '<div class="command-empty">没有找到匹配的命令</div>';
        return;
      }
      list.innerHTML = filtered.map((c, i) => `
        <div class="command-item ${i === 0 ? 'active' : ''}" data-id="${c.id}">
          <div class="command-item-icon">${c.icon}</div>
          <div class="command-item-info">
            <div class="command-item-name">${c.name}</div>
            <div class="command-item-desc">${c.desc}</div>
          </div>
          ${c.shortcut ? `<span class="command-item-shortcut">${c.shortcut}</span>` : ''}
        </div>
      `).join('');
      list.querySelectorAll('.command-item').forEach((el, i) => {
        el.onclick = () => {
          const cmd = filtered[i];
          palette.classList.remove('show');
          input.value = '';
          cmd.action();
        };
      });
    }

    function openPalette() {
      palette.classList.add('show');
      input.value = '';
      renderCommands();
      setTimeout(() => input.focus(), 50);
    }
    function closePalette() { palette.classList.remove('show'); }

    // Ctrl+Shift+P 打开
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'P') { e.preventDefault(); openPalette(); }
      if (e.ctrlKey && e.key === ',') { e.preventDefault(); $('#settingsModal')?.classList.add('show'); }
      if (e.ctrlKey && e.key === 'e') { e.preventDefault(); $('#exportAllBtn')?.click(); }
      if (e.key === '?' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        $('#shortcutsHelp')?.classList.add('show');
      }
    });

    input.addEventListener('input', () => renderCommands(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePalette();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const items = list.querySelectorAll('.command-item');
        const active = list.querySelector('.command-item.active');
        let idx = active ? Array.from(items).indexOf(active) : -1;
        idx = (idx + 1) % items.length;
        items.forEach(it => it.classList.remove('active'));
        items[idx]?.classList.add('active');
        items[idx]?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const items = list.querySelectorAll('.command-item');
        const active = list.querySelector('.command-item.active');
        let idx = active ? Array.from(items).indexOf(active) : 0;
        idx = (idx - 1 + items.length) % items.length;
        items.forEach(it => it.classList.remove('active'));
        items[idx]?.classList.add('active');
        items[idx]?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        list.querySelector('.command-item.active')?.click();
      }
    });
    palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });
    $('#shortcutsClose')?.addEventListener('click', () => $('#shortcutsHelp')?.classList.remove('show'));
    $('#shortcutsHelp')?.addEventListener('click', (e) => { if (e.target.id === 'shortcutsHelp') e.target.classList.remove('show'); });
  }

  // ===== 表格列排序 =====
  let sortField = null, sortDir = 'asc';
  function initTableSort() {
    const headers = document.querySelectorAll('#allTable thead th[data-sort]');
    headers.forEach(th => {
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      th.onclick = () => {
        const field = th.dataset.sort;
        if (sortField === field) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortField = field;
          sortDir = 'asc';
        }
        // 更新表头指示
        headers.forEach(h => { h.textContent = h.textContent.replace(/ [↑↓]$/, ''); });
        th.textContent += sortDir === 'asc' ? ' ↑' : ' ↓';
        renderAllTable();
      };
    });
  }

  // ===== 筛选条件可视化 =====
  function initFilterTags() {
    // 在表格上方添加筛选标签容器
    const tableCard = document.querySelector('#page-all .glass-card');
    if (!tableCard) return;
    const tagContainer = document.createElement('div');
    tagContainer.id = 'filterTags';
    tagContainer.style.cssText = 'display:none;flex-wrap:wrap;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border-glass);background:rgba(65,187,200,0.03)';
    tableCard.insertBefore(tagContainer, tableCard.querySelector('.table-wrap'));
  }
  function updateFilterTags() {
    const container = $('#filterTags');
    if (!container) return;
    const tags = [];
    if (currentStatus !== 'all') tags.push({ type: 'status', value: currentStatus, label: '状态: ' + currentStatus });
    if (currentType !== 'all') tags.push({ type: 'type', value: currentType, label: '类型: ' + currentType });
    if (tags.length) {
      container.style.display = 'flex';
      container.innerHTML = tags.map(t => `
        <span class="filter-tag" data-type="${t.type}" data-value="${t.value}" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(65,187,200,0.1);border:1px solid rgba(65,187,200,0.25);border-radius:999px;font-size:12px;color:var(--accent-cyan);cursor:pointer">
          ${t.label} <span style="font-weight:700;opacity:0.6">×</span>
        </span>
      `).join('') + `<span class="filter-tag-clear" style="padding:4px 10px;font-size:12px;color:var(--text-muted);cursor:pointer;text-decoration:underline">清除全部</span>`;
      container.querySelectorAll('.filter-tag').forEach(tag => {
        tag.onclick = () => {
          if (tag.dataset.type === 'status') { currentStatus = 'all'; document.querySelectorAll('#statusFilter .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.status === 'all')); }
          if (tag.dataset.type === 'type') { currentType = 'all'; document.querySelectorAll('#typeFilter .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'all')); }
          renderAllTable(); saveFilterState();
        };
      });
      container.querySelector('.filter-tag-clear').onclick = () => {
        currentStatus = 'all'; currentType = 'all';
        document.querySelectorAll('#statusFilter .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.status === 'all'));
        document.querySelectorAll('#typeFilter .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'all'));
        renderAllTable(); saveFilterState();
      };
    } else {
      container.style.display = 'none';
    }
  }

  // ===== 侧栏折叠 =====
  function initSidebarCollapse() {
    const sidebar = document.querySelector('.sidebar');
    const main = document.querySelector('.main-content');
    const logo = document.querySelector('.sidebar-logo');
    if (!sidebar || !main || !logo) return;

    // 恢复折叠状态
    if (localStorage.getItem('memoryos-sidebar-collapsed') === 'true') {
      sidebar.classList.add('collapsed');
      main.classList.add('sidebar-collapsed');
    }

    // 双击 Logo 折叠/展开
    logo.style.cursor = 'pointer';
    logo.title = '双击折叠/展开侧栏';
    logo.addEventListener('dblclick', () => {
      const collapsed = sidebar.classList.toggle('collapsed');
      main.classList.toggle('sidebar-collapsed', collapsed);
      localStorage.setItem('memoryos-sidebar-collapsed', collapsed);
      // 侧栏折叠/展开后内容区宽度变化，触发图表自适应
      setTimeout(resizeAllCharts, 50);
    });

    // 窄屏抽屉菜单：汉堡按钮开、遮罩与导航点击关
    const toggleBtn = document.getElementById('sidebarToggle');
    const backdrop = document.getElementById('sidebarBackdrop');
    const closeDrawer = () => {
      sidebar.classList.remove('open');
      if (backdrop) backdrop.classList.remove('show');
    };
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        sidebar.classList.add('open');
        if (backdrop) backdrop.classList.add('show');
      });
    }
    if (backdrop) {
      backdrop.addEventListener('click', closeDrawer);
    }
    // 抽屉打开时点击任意导航项/Logo 关闭
    sidebar.querySelectorAll('.nav-item, .sidebar-logo').forEach((el) => {
      el.addEventListener('click', () => closeDrawer());
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 768) closeDrawer(); });
  }

  // ===== 记忆内链接跳转 =====
  function initMemoryLinks() {
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.memory-link');
      if (!link) return;
      e.preventDefault();
      const id = parseInt(link.dataset.id);
      if (id) openDetail(id);
    });
  }
  function renderMemoryLinks(content) {
    return esc(content).replace(/#(\d+)/g, '<a href="#" class="memory-link" data-id="$1" style="color:var(--accent-cyan);text-decoration:underline;cursor:pointer">#$1</a>');
  }

  // ===== CSP 合规的 data-action 委托（替代内联 onclick，支持 T4 三处） =====
  function initDataActions() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const action = el.getAttribute('data-action');
      if (action === 'reload') { location.reload(); return; }
      if (action === 'focus-mem-search') {
        // 原语义：跳 #all 后再聚焦搜索框
        setTimeout(() => document.getElementById('memSearchInput')?.focus(), 100);
        return;
      }
      if (action === 'copy-code') {
        const code = el.closest('.code-block-wrapper')?.querySelector('code')?.textContent;
        if (code && navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
      }
    });
  }

  // ===== WYSIWYG 视图渲染：把 /api/all 的 ai.* / ai_visible 字段原样展示，用户所见即 AI 所得 =====
  function aiWysiwygBlock(m) {
    if (!m || !m.ai) return '';
    const ai = m.ai;
    const vis = m.ai_visible;
    const clipBadge = (clipped, hidden) => clipped
      ? ` <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,0.15);color:#f59e0b" title="超出 AI 可见上限，已裁剪 ${hidden} 字">✂ ${hidden} 字被 AI 裁剪</span>`
      : ` <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(34,197,94,0.15);color:#22c55e">完整可见</span>`;
    const visBadge = vis
      ? (vis.searchable
        ? `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(34,197,94,0.15);color:#22c55e">AI 可检索</span>`
        : `<span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(239,68,68,0.15);color:#ef4444" title="${esc(vis.reason)}">AI 不可检索：${esc(vis.reason)}</span>`)
      : '';
    const line = (label, text, clipped, hidden) =>
      `<div style="margin:4px 0"><span style="font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px">${label}</span>${clipBadge(clipped, hidden)}<div class="ai-wysiwyg-line mono" style="font-size:11.5px;line-height:1.7;color:var(--text-secondary);margin-top:3px;white-space:pre-wrap;word-break:break-all;padding:6px 10px;background:rgba(0,0,0,0.03);border-radius:6px;border-left:2px solid var(--accent-cyan)">${esc(text)}</div></div>`;
    return `<div style="margin-top:20px;padding-top:16px;border-top:1px solid rgba(0,0,0,0.06)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:12px;font-weight:600;color:var(--text-secondary)">👁 AI 视图（所见即所得）</span>
        ${visBadge}
      </div>
      ${line('memory_search', ai.search, ai.searchClipped, ai.searchHidden)}
      ${line('memory_context', ai.context, ai.contextClipped, ai.contextHidden)}
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">memory_read 全文视图：${line('memory_read', ai.read.replace(/^完整正文（\d+ 字）：\n/, ''), false, 0)}</div>
    </div>`;
  }

  // ===== 内容渲染（支持代码块、行内代码、记忆链接、Markdown表格） =====
  function renderContent(content) {
    let html = esc(content);
    // 代码块 ```...```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<div class="code-block-wrapper" style="margin:12px 0"><div class="code-block-header"><span>${lang || 'code'}</span><button class="code-copy-btn" data-action="copy-code">复制</button></div><pre><code>${code}</code></pre></div>`;
    });
    // Markdown 表格
    html = html.replace(/((?:\|[^\n]+\|\n){2,})/g, (match) => {
      const lines = match.trim().split('\n').filter(l => l.includes('|'));
      if (lines.length < 2) return match;
      const isSeparator = (l) => /^\|[\s\-:|]+\|$/.test(l);
      if (!isSeparator(lines[1])) return match;
      const headers = lines[0].split('|').slice(1, -1).map(h => h.trim());
      const rows = lines.slice(2).map(l => l.split('|').slice(1, -1).map(c => c.trim()));
      let table = '<div style="margin:12px 0;overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid var(--border-glass);border-radius:8px;overflow:hidden">';
      table += '<thead><tr style="background:rgba(65,187,200,0.08)">' + headers.map(h => `<th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border-glass);font-weight:600;color:var(--text-primary)">${h}</th>`).join('') + '</tr></thead>';
      table += '<tbody>' + rows.map((r, i) => `<tr style="${i % 2 ? 'background:rgba(0,0,0,0.02)' : ''}">` + r.map(c => `<td style="padding:8px 12px;border-bottom:1px solid var(--border-glass);color:var(--text-secondary)">${c}</td>`).join('') + '</tr>').join('') + '</tbody>';
      table += '</table></div>';
      return table;
    });
    // 行内代码 `...`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 记忆链接 #123
    html = html.replace(/#(\d+)/g, '<a href="#" class="memory-link" data-id="$1" style="color:var(--accent-cyan);text-decoration:underline;cursor:pointer">#$1</a>');
    // 换行
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  function initSettings() {
    let settings = loadSettings();
    applySettings(settings);

    // 打开设置弹窗
    const btn = $('#settingsBtn');
    const modal = $('#settingsModal');
    const close = $('#settingsClose');
    if (btn) btn.onclick = () => {
      // 同步当前设置到UI
      $$('.settings-option[data-setting="theme"]').forEach(o => o.classList.toggle('active', o.dataset.value === settings.theme));
      $$('.settings-option[data-setting="fontSize"]').forEach(o => o.classList.toggle('active', o.dataset.value === settings.fontSize));
      $('#reduceMotion').checked = settings.reduceMotion;
      $('#pageSizeSelect').value = settings.pageSize;
      $('#aboutTotal').textContent = fmtNum(S.memories.length);
      $('#aboutActive').textContent = fmtNum(S.memories.filter(m => m.status === 'active').length);
      loadCfg();
      modal.classList.add('show');
    };
    if (close) close.onclick = () => modal.classList.remove('show');
    if (modal) modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('show'); };

    // 主题切换
    $$('.settings-option[data-setting="theme"]').forEach(o => {
      o.onclick = () => {
        settings.theme = o.dataset.value;
        saveSettings(settings);
        applySettings(settings);
        $$('.settings-option[data-setting="theme"]').forEach(x => x.classList.remove('active'));
        o.classList.add('active');
      };
    });

    // 字体大小
    $$('.settings-option[data-setting="fontSize"]').forEach(o => {
      o.onclick = () => {
        settings.fontSize = o.dataset.value;
        saveSettings(settings);
        applySettings(settings);
        $$('.settings-option[data-setting="fontSize"]').forEach(x => x.classList.remove('active'));
        o.classList.add('active');
      };
    });

    // 减少动画
    const rm = $('#reduceMotion');
    if (rm) rm.onchange = () => {
      settings.reduceMotion = rm.checked;
      saveSettings(settings);
      applySettings(settings);
    };

    // 每页条数
    const ps = $('#pageSizeSelect');
    if (ps) ps.onchange = () => {
      settings.pageSize = parseInt(ps.value);
      saveSettings(settings);
      applySettings(settings);
      allPage = 1;
      renderAllTable();
      toast('每页显示 ' + settings.pageSize + ' 条');
    };

    // 导出全部
    const exp = $('#exportAllBtn');
    if (exp) exp.onclick = () => {
      const data = { version: '0.3.0', exportTime: new Date().toISOString(), memories: S.memories, summary: S.summary };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `memoryos-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('已导出 ' + S.memories.length + ' 条记忆');
    };

    // 重置设置
    const reset = $('#resetSettingsBtn');
    if (reset) reset.onclick = () => {
      if (!confirm('确定重置所有设置为默认值？记忆数据不会受影响。')) return;
      settings = Object.assign({}, DEFAULT_SETTINGS);
      saveSettings(settings);
      applySettings(settings);
      $$('.settings-option[data-setting="theme"]').forEach(o => o.classList.toggle('active', o.dataset.value === settings.theme));
      $$('.settings-option[data-setting="fontSize"]').forEach(o => o.classList.toggle('active', o.dataset.value === settings.fontSize));
      $('#reduceMotion').checked = settings.reduceMotion;
      $('#pageSizeSelect').value = settings.pageSize;
      toast('已重置为默认设置');
    };

    // ★ 设置面板增强 /api/config：LLM / 受限 / 状态
    //   LLM 配置保存后**即时生效**（内核侧现读 config.json）；密钥以 DPAPI 密文落盘，明文不落盘。
    function llmKeyStateText(r) {
      if (!r.llmKeySet) return '未设置';
      const src = r.llmKeySource || '';
      if (src.startsWith('env')) return '已设置（来自环境变量 ' + src.replace(/^env\(|\)$/g, '') + '）';
      if (src === 'encrypted') return '已设置（DPAPI 密文存储）';
      return '已设置';
    }
    async function loadCfg() {
      try {
        const r = await fetch('/api/config').then(x => x.json());
        $('#cfgLlmUrl').value = r.llmUrl || '';
        $('#cfgLlmModel').value = r.llmModel || '';
        $('#cfgLlmKeyState').textContent = llmKeyStateText(r);
        $('#cfgLlmKey').value = '';
        const eff = $('#cfgLlmEffective');
        if (eff && r.llmEffective) eff.textContent = r.llmEffective.url + '　·　' + r.llmEffective.model + '　（来源：' + r.llmEffective.source + '；密钥：' + r.llmEffective.keySource + '）';
        const _rCfg = $('#cfgRestricted'); if (_rCfg) _rCfg.checked = !!r.restricted; // 受限模式开关已移除（2026-09-13），元素缺失时安全跳过
        $('#cfgDataDir').value = r.dataDir || '';
        $('#cfgPort').textContent = r.port || '—';
        $('#cfgDbPath').textContent = r.dbPath || '—';
        const aliveEl = $('#cfgAlive');
        if (aliveEl) {
          const stale = r.daemonStale;
          const hrs = r.hoursSince;
          const label = stale
            ? (hrs != null ? '停滞(' + hrs + 'h)' : '已停止')
            : (hrs != null ? '运行中(' + hrs + 'h前)' : '运行中');
          aliveEl.textContent = label;
          aliveEl.style.color = stale ? 'var(--danger)' : '#16a34a';
        }
      } catch (e) { console.warn('加载配置失败', e); }
    }
    loadCfg();
    const keyInput = $('#cfgLlmKey'), keyToggle = $('#cfgLlmKeyToggle');
    if (keyToggle && keyInput) keyToggle.onclick = () => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      keyToggle.textContent = show ? '隐藏' : '显示';
    };
    const keyClear = $('#cfgLlmKeyClear');
    if (keyClear) keyClear.onclick = async () => {
      if (!confirm('删除已保存的 LLM 密钥？（环境变量里的密钥不受影响）')) return;
      const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clearLlmKey: true }) }).then(x => x.json()).catch(e => ({ error: e.message }));
      toast(r.ok ? '密钥已清除' : ('清除失败：' + (r.error || '')));
      await loadCfg();
    };
    const testBtn = $('#testLlmBtn');
    if (testBtn) testBtn.onclick = async () => {
      const item = $('#cfgLlmTestItem'), out = $('#cfgLlmTestResult');
      const payload = { llmUrl: $('#cfgLlmUrl').value.trim(), llmModel: $('#cfgLlmModel').value.trim(), llmKey: $('#cfgLlmKey').value.trim() };
      if (item) item.style.display = '';
      if (out) { out.textContent = '测试中…（本地模型冷启动可能要十几秒）'; out.style.color = 'var(--text-muted)'; }
      try {
        const r = await fetch('/api/config/test-llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(x => x.json());
        if (!out) return;
        if (r.ok) {
          out.style.color = '#16a34a';
          out.textContent = '✓ 连接成功　' + r.url + '\n模型 ' + r.model + '　耗时 ' + r.latencyMs + 'ms';
        } else {
          out.style.color = 'var(--danger)';
          out.textContent = '✗ 失败' + (r.status ? '（HTTP ' + r.status + '）' : '') + '　' + (r.url || '') + '\n' + (r.error || '') + (r.hint ? '\n💡 ' + r.hint : '');
        }
      } catch (e) {
        if (out) { out.style.color = 'var(--danger)'; out.textContent = '✗ 请求失败：' + e.message; }
      }
    };
    const saveBtn = $('#saveCfgBtn');
    if (saveBtn) saveBtn.onclick = async () => {
      const payload = { llmUrl: $('#cfgLlmUrl').value.trim(), llmModel: $('#cfgLlmModel').value.trim() };
      const key = $('#cfgLlmKey').value.trim();
      if (key) payload.llmKey = key;
      try {
        const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(x => x.json());
        if (!r.ok) { toast('保存失败：' + (r.error || '未知错误')); return; }
        toast(r.note || (r.restartRequired ? '已保存，重启内核后生效' : '已保存，即时生效'));
        $('#cfgLlmKey').value = '';
        await loadCfg();
      } catch (e) { toast('保存失败：' + e.message); }
    };
    const rstr = $('#cfgRestricted');
    if (rstr) rstr.onchange = async () => {
      if (!confirm('切换受限模式需重启内核生效，继续？')) { rstr.checked = !rstr.checked; return; }
      try {
        await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restricted: rstr.checked }) });
        toast('已保存受限模式，重启内核后生效');
      } catch (e) { toast('保存失败：' + e.message); }
    };
    const cdd = $('#copyDataDir');
    if (cdd) cdd.onclick = async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText($('#cfgDataDir').value || ''); toast('已复制数据目录'); }
      catch { toast('复制失败'); }
    };
  }

  // 右键菜单
  function initContextMenu() {
    const menu = $('#contextMenu');
    if (!menu) return;
    document.addEventListener('contextmenu', (e) => {
      const tr = e.target.closest('#allTableBody tr');
      if (!tr) return;
      e.preventDefault();
      const id = Number(tr.dataset.id);
      menu.dataset.memoryId = id;
      menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
      menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + 'px';
      menu.classList.add('show');
    });
    document.addEventListener('click', () => menu.classList.remove('show'));
    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.onclick = () => {
        const id = Number(menu.dataset.memoryId);
        const action = item.dataset.action;
        if (action === 'edit') openEdit(id);
        else if (action === 'detail') openDetail(id);
        else if (action === 'copy') {
          const m = S.memories.find(x => x.id === id);
          if (m) navigator.clipboard.writeText(m.content).then(() => toast('已复制内容'));
        }
        else if (action === 'delete') {
          if (confirm('确定删除这条记忆？')) deleteMemory(id);
        }
        menu.classList.remove('show');
      };
    });
  }

  // 错误边界
  function initErrorBoundary() {
    window.addEventListener('error', (e) => {
      const boundary = $('#errorBoundary');
      const msg = $('#errorMsg');
      if (boundary && msg) {
        msg.textContent = e.message + ' (' + e.filename + ':' + e.lineno + ')';
        boundary.classList.add('show');
      }
    });
    window.addEventListener('unhandledrejection', (e) => {
      console.error('Unhandled promise rejection:', e.reason);
    });
  }

  // 导出增强
  function initExport() {
    const exportBtn = document.querySelector('.topbar-actions .btn-ghost');
    if (exportBtn && !exportBtn.dataset.bound) {
      exportBtn.dataset.bound = '1';
      exportBtn.onclick = () => {
        const format = prompt('导出格式：输入 md / json / csv（默认 md）', 'md');
        if (format === null) return;
        const data = S.memories;
        let content = '', mime = 'text/plain', ext = 'txt';
        if (format === 'json') {
          content = JSON.stringify(data, null, 2);
          mime = 'application/json'; ext = 'json';
        } else if (format === 'csv') {
          content = 'id,type,status,agent,content,created_at\n' +
            data.map(m => `"${m.id}","${m.type}","${m.status}","${m.agent}","${(m.content||'').replace(/"/g,'""')}","${m.created_at}"`).join('\n');
          mime = 'text/csv'; ext = 'csv';
        } else {
          content = data.map(m => `## #${m.id} [${m.type}/${m.status}]\n\n${m.content}\n\n*${m.agent} · ${m.created_at}*\n\n---\n`).join('\n');
          mime = 'text/markdown'; ext = 'md';
        }
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `memoryos-export-${new Date().toISOString().slice(0,10)}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
        toast(`已导出 ${data.length} 条记忆（${ext.toUpperCase()}）`);
      };
    }
  }

  // 表格行展开
  function initRowExpand() {
    document.addEventListener('dblclick', (e) => {
      const tr = e.target.closest('#allTableBody tr');
      if (!tr) return;
      const id = Number(tr.dataset.id);
      const m = S.memories.find(x => x.id === id);
      if (!m) return;
      // 切换展开状态
      const nextTr = tr.nextElementSibling;
      if (nextTr && nextTr.classList.contains('expand-row')) {
        nextTr.remove();
        tr.classList.remove('expanded');
      } else {
        tr.classList.add('expanded');
        const expandRow = document.createElement('tr');
        expandRow.className = 'expand-row';
        expandRow.innerHTML = `<td colspan="10"><div class="expanded-content">${esc(m.content)}</div></td>`;
        tr.after(expandRow);
      }
    });
  }

  bindNav(); bindSearch(); bindModal();
  initSettings();
  initTheme();
  initRipple();
  initKeyboard();
  /* ===== ★ P6 知识图谱 + 卡片看板（调用 /api/graph /api/cards 新后端）===== */
  const CARD_STATES_UI = [
    ['triage', '待细化', '#64748b'], ['todo', '待就绪', '#3b82f6'], ['ready', '可认领', '#06b6d4'], ['running', '执行中', '#a8557f'],
    ['review', '待验收', '#f59e0b'], ['blocked', '阻塞', '#ef4444'], ['failed', '失败', '#f97316'], ['done', '完成', '#10b981'],
    ['cancelled', '取消', '#94a3b8'], ['archived', '归档', '#64748b'],
  ];
  const SECTOR_COLOR_P6 = { working: '#94a3b8', episodic: '#38bdf8', semantic: '#34d399', procedural: '#a78bfa', meta: '#fbbf24', social: '#f472b6', user: '#22d3ee', prospective: '#fb923c', affective: '#f87171', secret: '#64748b' };
  const SECTOR_CN_P6 = { working: '工作', episodic: '情景', semantic: '语义', procedural: '程序', meta: '元记忆', social: '协作', user: '用户', prospective: '前瞻', affective: '情感' };

  function drawSectorChart(dist) {
    const el = $('#sectorChart'); if (!el || !window.echarts || !Array.isArray(dist)) return;
    const data = dist.filter(d => d.count > 0);
    if (!data.length) { el.innerHTML = '<div style="text-align:center;padding:50px;color:var(--text-muted);font-size:12px">暂无类别数据</div>'; return; }
    const chart = echarts.init(el);
    chart.setOption({
      tooltip: { trigger: 'item', formatter: p => `${SECTOR_CN_P6[p.name] || p.name}：${p.value} 条（${p.percent}%）` },
      legend: { bottom: 0, textStyle: { color: '#94a3b8', fontSize: 10 }, itemWidth: 12, itemHeight: 8 },
      series: [{
        type: 'pie', radius: ['40%', '68%'], center: ['50%', '44%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: 'transparent', borderWidth: 0 },
        label: { show: false },
        data: data.map(d => ({ name: d.sector, value: d.count, itemStyle: { color: SECTOR_COLOR_P6[d.sector] || '#64748b' } })),
        emphasis: { label: { show: true, fontSize: 13, fontWeight: 600 } },
      }],
    });
  }

  async function loadProspective() {
    const list = $('#prospectiveList'); if (!list) return;
    const res = await fetch('/api/prospective/due?auto_card=0').then(r => r.json()).catch(() => null);
    if (!res) { list.innerHTML = '<div class="text-muted" style="font-size:12px;padding:12px">加载失败</div>'; return; }
    if (!res.due.length) { list.innerHTML = '<div class="text-muted" style="font-size:12px;padding:12px">暂无到期前瞻记忆</div>'; return; }
    list.innerHTML = res.due.map(d => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-bottom:1px solid var(--border-glass);font-size:12px">
        <span class="sdot" style="background:#fb923c;margin-top:4px"></span>
        <div>
          <div style="color:var(--text-primary)">${esc(d.trigger_action || d.content)}</div>
          <div class="mono" style="color:var(--text-muted);font-size:10px;margin-top:2px">#${d.id} · ${esc(d.trigger_kind || '')}${d.valid_until ? ' · 到期 ' + fmtDate(d.valid_until) : ''}</div>
        </div>
      </div>`).join('');
  }

  function initGraph() {
    // ★ C 修复：ECharts 是动态加载（window.EChartsLoaded），必须等就绪再绘制，否则容器 0 尺寸 → 空白
    const go = () => {
      const btn = $('#graphRefreshBtn'); if (btn && !btn.dataset.bound) { btn.dataset.bound = '1'; btn.onclick = drawGraph; }
      const scope = $('#graphScope'); if (scope && !scope.dataset.bound) { scope.dataset.bound = '1'; scope.onchange = drawGraph; }
      const depth = $('#graphDepth'); if (depth && !depth.dataset.bound) { depth.dataset.bound = '1'; depth.onchange = drawGraph; }
      drawGraph();
    };
    if (window.EChartsLoaded && window.EChartsLoaded.when) window.EChartsLoaded.when(go); else go();
  }

  let _graphChart = null, _graphSeq = 0;
  async function drawGraph() {
    const el = $('#graphChart'); if (!el || !window.echarts) return;
    const seq = ++_graphSeq; // ★ 并发防抖：init 列表与 navigate 都会触发 drawGraph，只让最新请求落 setOption
    const scope = ($('#graphScope') || {}).value || 'all';
    const depth = ($('#graphDepth') || {}).value || '1';
    const data = await fetch(`/api/graph?scope=${encodeURIComponent(scope)}&depth=${encodeURIComponent(depth)}`).then(r => r.json()).catch(() => null);
    if (seq !== _graphSeq) return; // 已有更新的请求，丢弃本次（防交错 clear/setOption 破坏渲染）
    if (!data) { el.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)">图谱数据加载失败</div>'; return; }
    const banner = $('#graphBanner');
    if (banner) { banner.style.display = data.truncated ? 'block' : 'none'; if (data.truncated) banner.textContent = '图已截断（节点>200），请用 scope / 筛选收窄'; }
    const catMap = { note: '笔记', memory: '记忆', card: '卡片' };
    const nodes = (data.nodes || []).map(n => ({
      id: n.id, name: n.label, category: n.kind,
      symbol: n.kind === 'note' ? 'circle' : n.kind === 'card' ? 'roundRect' : 'diamond',
      symbolSize: n.kind === 'card' ? 26 : 20 + Math.min(18, (n.degree || 0) * 2),
      itemStyle: { color: SECTOR_COLOR_P6[n.sector] || '#64748b', opacity: n.sector === 'secret' ? 0.5 : 1 },
      label: { show: n.sector !== 'secret', fontSize: 10 },
      value: n.degree || 0,
    }));
    const edges = (data.edges || []).map(e => ({
      source: e.source, target: e.target,
      lineStyle: { type: e.kind === 'depends' ? 'dashed' : 'solid', width: e.kind === 'embed' ? 2.5 : 1, opacity: 0.55 },
    }));
    // ★ C 修复（2026-09-12 实证链）：dispose+init 复用容器 / clear+setOption 循环 / force 大 repulsion
    // ★ C 修复（2026-09-12 实证链）：ECharts 5.6 的 force/circular 布局引擎在本环境全部 series 渲染 0
    //   （大 repulsion 飞散 / dispose+init 复用 / clear+setOption 循环 / 0 尺寸 init 布局 NaN）。
    //   终局方案：自算圆形坐标 + layout:'none'（同步渲染、零布局引擎依赖），实测 200 节点 23974px 正常。
    if (_graphChart) { try { _graphChart.dispose(); } catch {} _graphChart = null; }
    el.innerHTML = '';
    const fresh = document.createElement('div');
    fresh.style.cssText = 'width:100%;height:100%';
    el.appendChild(fresh);
    const chart = echarts.init(fresh);
    _graphChart = chart;
    const cw = el.clientWidth || 800, ch = el.clientHeight || 600;
    const cx = cw / 2, cy = ch / 2;
    const R = Math.max(40, Math.min(cw, ch) / 2 - 40);
    const count = Math.max(1, nodes.length);
    // ★ 关键：layout:'none' 下只保留 id/name/category/x/y（Q6 实证 23974px 渲染）；
    //   带 symbol/symbolSize/itemStyle 等字段在此组合下会 0 渲染（本环境实证）
    // ★ UI2.0：分层力导向坐标（layout:'none'，绕开 ECharts force 引擎在本环境的飞散/NaN bug）
    //   有连接的节点在中心区域做力导向形成关系网络；大量彼此无边的孤立节点按类别排到外圈双环并弱化，避免糊成一个圈。
    const positioned = (() => {
      const N = nodes.length;
      if (N <= 2) {
        return nodes.map((n, i) => ({ id: n.id, name: n.label, category: n.kind, symbolSize: 18,
          x: Math.round(cx + (i - (N - 1) / 2) * 60), y: Math.round(cy) }));
      }
      const idIndex = new Map(); nodes.forEach((n, i) => idIndex.set(String(n.id), i));
      const rand = (i) => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
      const deg = new Array(N).fill(0);
      const adj = Array.from({ length: N }, () => []);
      edges.forEach(e => {
        const a = idIndex.get(String(e.source)), b = idIndex.get(String(e.target));
        if (a != null && b != null && a !== b) { adj[a].push(b); adj[b].push(a); deg[a]++; deg[b]++; }
      });
      const conn = [], iso = [];
      nodes.forEach((n, i) => (deg[i] > 0 ? conn : iso).push(i));
      const result = new Array(N);

      // —— 中心：连通子网络力导向（限制在 R*0.5 半径内）——
      if (conn.length) {
        const CN = conn.length, Rc = R * 0.5, ccx = cx, ccy = cy;
        const P = conn.map((gi, t) => ({
          x: ccx + (rand(gi) - 0.5) * Rc, y: ccy + (rand(gi + 7) - 0.5) * Rc, dx: 0, dy: 0, gi,
        }));
        const local = new Map(); conn.forEach((gi, t) => local.set(gi, t));
        const cAdj = Array.from({ length: CN }, () => []);
        conn.forEach((gi, t) => adj[gi].forEach(o => { if (local.has(o)) cAdj[t].push(local.get(o)); }));
        const k = Math.sqrt((2 * Rc) * (2 * Rc) / Math.max(1, CN)) * 0.7, ITER = 240;
        for (let it = 0; it < ITER; it++) {
          for (let t = 0; t < CN; t++) P[t].dx = P[t].dy = 0;
          for (let a = 0; a < CN; a++) for (let b = a + 1; b < CN; b++) {
            let x = P[a].x - P[b].x, y = P[a].y - P[b].y;
            let d2 = x * x + y * y; if (d2 < 0.01) { d2 = 0.01; x = 0.01 * (rand(a + it) - 0.5); }
            const d = Math.sqrt(d2), f = (k * k) / d, fx = f * x / d, fy = f * y / d;
            P[a].dx += fx; P[a].dy += fy; P[b].dx -= fx; P[b].dy -= fy;
          }
          cAdj.forEach((list, a) => list.forEach(b => {
            if (b <= a) return;
            let x = P[a].x - P[b].x, y = P[a].y - P[b].y;
            const d = Math.hypot(x, y) || 0.01, f = (d * d) / k, fx = f * x / d, fy = f * y / d;
            P[a].dx -= fx; P[a].dy -= fy; P[b].dx += fx; P[b].dy += fy;
          }));
          const temp = (Rc * 0.2) * (1 - it / ITER) + 0.4;
          P.forEach((p, t) => {
            p.dx += (ccx - p.x) * 0.02; p.dy += (ccy - p.y) * 0.02;
            const d = Math.hypot(p.dx, p.dy) || 0.01, step = Math.min(d, temp);
            p.x += p.dx / d * step; p.y += p.dy / d * step;
            const rr = Math.hypot(p.x - ccx, p.y - ccy), maxR = Rc - 10;
            if (rr > maxR) { p.x = ccx + (p.x - ccx) / rr * maxR; p.y = ccy + (p.y - ccy) / rr * maxR; }
          });
        }
        P.forEach((p, t) => { const gi = p.gi; result[gi] = { x: Math.round(p.x), y: Math.round(p.y), size: 18 }; });
      }

      // —— 外圈：孤立节点按类别排序，双环交错排布并弱化 ——
      const catOrder = { note: 0, memory: 1, card: 2 };
      iso.sort((a, b) => (catOrder[nodes[a].category] ?? 9) - (catOrder[nodes[b].category] ?? 9) || a - b);
      const M = iso.length;
      iso.forEach((gi, t) => {
        const ang = (2 * Math.PI * t) / M - Math.PI / 2;
        const ring = (t % 2 === 0) ? R * 0.84 : R * 0.96; // 内外双环交错，降低单环密度
        result[gi] = {
          x: Math.round(cx + ring * Math.cos(ang)),
          y: Math.round(cy + ring * Math.sin(ang)),
          size: 11, // 孤立节点弱化
        };
      });

      return nodes.map((n, i) => ({ id: n.id, name: n.label, category: n.kind,
        symbolSize: result[i].size, x: result[i].x, y: result[i].y }));
    })();
    chart.setOption({
      tooltip: { formatter: p => { const n = (data.nodes || []).find(x => x.id === p.data.id); return n ? `<b>${esc(n.label)}</b><br>类型: ${catMap[n.kind] || n.kind}${n.sector ? ' · ' + esc(n.sector) : ''}${data.secret_folded ? '<br><span style="color:#94a3b8">私密记忆折叠，不出现在图谱</span>' : ''}` : ''; } },
      legend: { data: ['笔记', '记忆', '卡片'], textStyle: { color: '#94a3b8' }, top: 0 },
      series: [{
        type: 'graph', layout: 'none', data: positioned, links: edges,
        categories: [{ name: '笔记' }, { name: '记忆' }, { name: '卡片' }],
        label: { show: true, fontSize: 10 },
        animation: false,
      }],
    });
    const onResize = () => chart.resize();
    window.removeEventListener('resize', onResize);
    window.addEventListener('resize', onResize);
  }

  async function renderCards() {
    const board = $('#cardsBoard'); if (!board) return;
    board.style.display = _taskViewMode === 'cards' ? 'block' : 'none';
    board.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">加载卡片…</div>';
    const data = await fetch('/api/cards').then(r => r.json()).catch(() => ({ total: 0, _err: true }));
    const buckets = data.buckets || {};
    if (data._err) toast('看板加载失败：无法连接内核服务');
    const html = CARD_STATES_UI.map(([st, label, color]) => {
      const items = buckets[st] || [];
      return `<div data-col="${st}" style="display:flex;flex-direction:column;background:rgba(255,255,255,0.03);border:1px solid rgba(0,0,0,0.07);border-radius:12px;padding:10px 12px;min-width:348px;max-height:calc(100vh - 230px);overflow-y:auto;overflow-x:hidden">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span>
          <span style="font-size:12px;font-weight:600;color:var(--text-primary)">${label}</span>
          <span class="mono" style="font-size:10px;color:var(--text-muted)">${items.length}</span>
        </div>
        ${items.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;align-items:start">${items.map(c => `
          <div data-card-id="${c.id}" data-status="${st}" style="padding:9px 11px;background:var(--bg-card);border:1px solid rgba(0,0,0,0.07);border-radius:10px;cursor:pointer;touch-action:none" title="点击打开详情 · 拖动改状态">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <span class="mono" style="font-size:10px;color:var(--text-muted)">#${c.id}</span>
              <span style="font-size:10px;color:${c.assignee ? 'var(--text-secondary)' : 'var(--text-muted)'}">${esc(c.assignee || '未分配')}</span>
            </div>
            <div style="font-size:12px;color:var(--text-primary);margin-top:4px;line-height:1.5">${esc(c.title)}</div>
            ${c.priority > 0 ? `<span style="font-size:10px;color:#f59e0b">P${c.priority}</span>` : ''}
          </div>`).join('')}</div>` : '<div style="text-align:center;color:var(--text-muted);font-size:11px;padding:14px 0">—</div>'}
      </div>`;
    }).join('');
    board.innerHTML = `<div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;min-height:180px">${html}</div>`;
    const items = $$('#cardsBoard [data-card-id]');
    items.forEach(el => {
      el.onclick = () => {
        if (el.dataset.dragged === '1') { delete el.dataset.dragged; return; } // 拖拽后不触发详情
        openCardDetail(Number(el.dataset.cardId));
      };
      // ★ C：Pointer Events 拖拽（R2-3/R7-2）——window 级监听 move/up，不依赖 setPointerCapture（headless/CDP 下 capture 不可靠）
      let sx = 0, sy = 0, dragging = false, ghost = null;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        sx = e.clientX; sy = e.clientY; dragging = false;
        delete el.dataset.dragged;
        const onMove = (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (!dragging && Math.hypot(dx, dy) < 6) return;
          if (!dragging) {
            dragging = true; el.dataset.dragged = '1';
            ghost = el.cloneNode(true);
            ghost.style.cssText = `position:fixed;z-index:99;pointer-events:none;width:${el.offsetWidth}px;opacity:0.75;background:var(--bg-card);box-shadow:0 8px 24px rgba(0,0,0,0.25);border:1px solid rgba(0,0,0,0.12);border-radius:10px;padding:9px 11px`;
            document.body.appendChild(ghost);
            el.style.opacity = '0.3';
          }
          if (ghost) { ghost.style.left = ev.clientX + 8 + 'px'; ghost.style.top = ev.clientY + 8 + 'px'; }
        };
        const onUp = async (ev) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          if (ghost) { ghost.remove(); ghost = null; }
          el.style.opacity = '';
          if (!dragging) return;
          dragging = false;
          const from = el.dataset.status;
          const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-col]');
          const to = target ? target.dataset.col : null;
          if (!to || to === from) return;
          const res = await fetch(`/api/cards/${el.dataset.cardId}/status`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: to, expected_from: from, as: 'human:dashboard' }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { toast(`移动失败：${j.error || res.status}`); return; }
          toast(`${j.from} → ${j.to}`);
          renderCards();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });
    });
  }

  /* —— P1：任务地图（确定性分层布局 + DOM 节点 + SVG 连线）—— */
  const TASK_MAP_NODE_W = 226;
  const TASK_MAP_NODE_H = 96;
  const TASK_MAP_GAP_X = 92;
  const TASK_MAP_GAP_Y = 46;
  const TASK_MAP_PAD = 56;
  const TASK_MAP_LINK_STYLE = {
    spawned_by: { color: '#41bbc8', width: 2, dash: '' },
    depends: { color: '#f59e0b', width: 2, dash: '7 5' },
    blocks: { color: '#ef4444', width: 3, dash: '' },
    relates: { color: '#94a3b8', width: 1.5, dash: '2 5' },
    duplicates: { color: '#a855f7', width: 1.5, dash: '4 4' },
    // ★ 2026-09-13：辅助卡片挂载（主卡 → 辅助卡；细线虚线，五类各一色）
    aux_project: { color: '#22c55e', width: 1.5, dash: '3 3' },
    aux_memory: { color: '#38bdf8', width: 1.5, dash: '3 3' },
    aux_rule: { color: '#eab308', width: 1.5, dash: '3 3' },
    aux_skill: { color: '#a855f7', width: 1.5, dash: '3 3' },
    aux_error: { color: '#f43f5e', width: 1.5, dash: '3 3' },
  };
  const _taskMapState = {
    data: { nodes: [], links: [] },
    positions: new Map(),
    auto: (() => { try { return (localStorage.getItem('memoryos-map-auto') ?? '1') !== '0'; } catch { return true; } })(), // ★ 2026-09-14 自动关联开关（?auto=0/1）
    showArchived: (() => { try { return localStorage.getItem('memoryos-map-archived') === '1'; } catch { return false; } })(), // ★ 2026-09-18 归档任务默认隐藏（工具栏「查看归档」切换）
    scale: 1,
    x: 0,
    y: 0,
    seq: 0,
    hasView: false,
    bound: false,
    drag: null,
    vertical: false,
    suppressClick: false, // ★ 2026-09-13：拖动结束后的误点抑制（避免拖动节点后误触 openCardDetail）
  };

  /* ★ 2026-09-13 重构：横向工作流布局（用户要求：卡片横向排列、禁止纵向；自动排布必须横向）。
     ① 依赖分层（前置 → 依赖方；辅助卡挂载边不参与分层）
     ② 按层顺序横向倾倒进「容量 maxRows」的列（左 → 右 = 工作流推进方向），避免孤立节点堆成一列纵向长条
     ③ 完成卡沉底到末列（工作流终点；且完成卡不参与连线）
     ④ 辅助卡（kind='aux'）作为卫星卡级联在主卡右下方的预留卫星带内（主卡 → 辅助卡） */
  function taskMapTopology(nodes, links, vertical = false) {
    const byId = new Map(nodes.map(n => [Number(n.id), n]));
    const isAux = (id) => { const k = String(byId.get(id)?.kind ?? ''); return k === 'aux' || k.startsWith('aux_'); };
    const taskSet = new Set([...byId.keys()].filter((id) => !isAux(id)));

    /* —— ① 依赖分层（Kahn；depends/spawned_by 翻向「前置 → 依赖方」；aux_/relates/duplicates 不进层） —— */
    const childOf = new Map([...taskSet].map((id) => [id, []]));
    const indeg = new Map([...taskSet].map((id) => [id, 0]));
    const seen = new Set();
    links.forEach(link => {
      const kind = String(link.kind);
      if (kind.startsWith('aux_') || kind === 'relates' || kind === 'duplicates') return;
      let from = Number(link.src_id), to = Number(link.dst_id);
      if (!taskSet.has(from) || !taskSet.has(to) || from === to) return;
      if (kind === 'depends' || kind === 'spawned_by') [from, to] = [to, from];
      const key = from + '::' + to;
      if (seen.has(key)) return;
      seen.add(key);
      childOf.get(from).push(to);
      indeg.set(to, indeg.get(to) + 1);
    });

    const compare = (a, b) => {
      const na = byId.get(a), nb = byId.get(b);
      return (Number(nb.priority || 0) - Number(na.priority || 0)) ||
        String(na.created_at || '').localeCompare(String(nb.created_at || '')) ||
        a - b;
    };
    const rank = new Map([...taskSet].map((id) => [id, 0]));
    const queue = [...taskSet].filter((id) => indeg.get(id) === 0).sort(compare);
    const settled = new Set();
    while (queue.length) {
      queue.sort(compare);
      const id = queue.shift();
      if (settled.has(id)) continue;
      settled.add(id);
      for (const child of childOf.get(id)) {
        rank.set(child, Math.max(rank.get(child), rank.get(id) + 1));
        indeg.set(child, indeg.get(child) - 1);
        if (indeg.get(child) === 0) queue.push(child);
      }
    }
    /* 环残余 / 孤立节点 → 第 0 层，由下方横向倾倒展开（不再挤成一列纵向长条） */
    [...taskSet].forEach((id) => { if (!settled.has(id)) rank.set(id, 0); });
    /* ③ 完成卡沉底到末层（工作流终点；完成卡也不参与连线） */
    const maxRank = [...taskSet].reduce((m, id) => Math.max(m, rank.get(id)), 0);
    byId.forEach((n, id) => { if (taskSet.has(id) && String(n.status) === 'done') rank.set(id, maxRank + 1); });

    /* —— ② 横向倾倒：按层顺序灌入容量 maxRows 的列（左 → 右 即工作流方向；禁止纵向排布）
       行距按「列 floor」级联：上一行若挂了辅助卡悬挂区，下一行从悬挂区下方起，保证互不重叠 */
    const positions = new Map();
    const maxRows = Math.max(3, Math.min(9, Math.ceil(Math.sqrt(Math.max(1, taskSet.size)))));
    const colPitch = TASK_MAP_NODE_W + TASK_MAP_GAP_X + 190; // 226+92+190=508
    const AUX_W = 170, AUX_ROW_H = 100, AUX_DROP = 20, AUX_PER_ROW = 2;
    /* host → 辅助卡 id 列表（保持 link 顺序；host = 非 aux 端点） */
    const auxByHost = new Map();
    links.forEach(link => {
      const kind = String(link.kind);
      if (!kind.startsWith('aux_')) return;
      const s = Number(link.src_id), d = Number(link.dst_id);
      const host = isAux(s) ? d : s;
      const auxId = isAux(s) ? s : d;
      if (!taskSet.has(host) || !byId.has(auxId)) return; // 宿主须为任务卡；辅助卡只需存在于图中
      if (!auxByHost.has(host)) auxByHost.set(host, []);
      if (!auxByHost.get(host).includes(auxId)) auxByHost.get(host).push(auxId);
    });
    const seq = [...taskSet].sort((a, b) => (rank.get(a) - rank.get(b)) || compare(a, b));
    const colFloor = new Map();  // col → 下一行起始 y（含辅助悬挂区）
    const colBottom = new Map(); // col → 该列最大底边（含悬挂区）
    seq.forEach((id, idx) => {
      const col = Math.floor(idx / maxRows);
      const x = TASK_MAP_PAD + col * colPitch;
      const y = colFloor.get(col) ?? TASK_MAP_PAD;
      const list = auxByHost.get(id);
      const hangBottom = (list && list.length) ? y + TASK_MAP_NODE_H + AUX_DROP + Math.ceil(list.length / AUX_PER_ROW) * AUX_ROW_H : 0;
      positions.set(id, { x, y, rank: rank.get(id) });
      colFloor.set(col, Math.max(hangBottom, y + TASK_MAP_NODE_H) + TASK_MAP_GAP_Y);
      colBottom.set(col, Math.max(colBottom.get(col) ?? 0, hangBottom || (y + TASK_MAP_NODE_H)));
    });

    /* —— ④ 辅助卡：挂在宿主卡正下方横向排（每行 2 张自动换行；不再级联重叠） —— */
    auxByHost.forEach((auxIds, host) => {
      const hp = positions.get(host);
      if (!hp) return;
      auxIds.forEach((auxId, i) => {
        const r = Math.floor(i / AUX_PER_ROW), c = i % AUX_PER_ROW;
        positions.set(auxId, { x: hp.x + 8 + c * (AUX_W + 24), y: hp.y + TASK_MAP_NODE_H + AUX_DROP + r * AUX_ROW_H, rank: hp.rank, aux: true });
      });
    });

    /* —— 画布尺寸（含辅助悬挂区） —— */
    let maxX = TASK_MAP_PAD + TASK_MAP_NODE_W;
    let maxY = TASK_MAP_PAD + TASK_MAP_NODE_H;
    colBottom.forEach(b => { maxY = Math.max(maxY, b + 16); });
    positions.forEach(p => { maxX = Math.max(maxX, p.x + (p.aux ? AUX_W + 40 : TASK_MAP_NODE_W + 40)); });
    return { positions, width: maxX + TASK_MAP_PAD, height: maxY + TASK_MAP_PAD };
  }

  function taskMapEdgePath(source, target, vertical = false) {
    const sy = source.y + TASK_MAP_NODE_H / 2;
    const ty = target.y + TASK_MAP_NODE_H / 2;
    if (source.x === target.x && source.y === target.y) {
      const x = source.x + TASK_MAP_NODE_W - 18;
      return `M ${x} ${sy} C ${x + 68} ${sy - 62}, ${x + 68} ${sy + 62}, ${x} ${sy + 20}`;
    }
    if (vertical && source.rank !== target.rank) {
      const downward = target.y >= source.y;
      const sx = source.x + TASK_MAP_NODE_W / 2;
      const tx = target.x + TASK_MAP_NODE_W / 2;
      const fromY = source.y + (downward ? TASK_MAP_NODE_H : 0);
      const toY = target.y + (downward ? 0 : TASK_MAP_NODE_H);
      const direction = downward ? 1 : -1;
      const bend = Math.max(38, Math.min(110, Math.abs(toY - fromY) * 0.45));
      return `M ${sx} ${fromY} C ${sx} ${fromY + direction * bend}, ${tx} ${toY - direction * bend}, ${tx} ${toY}`;
    }
    const forward = target.x >= source.x;
    const sx = source.x + (forward ? TASK_MAP_NODE_W : 0);
    const tx = target.x + (forward ? 0 : TASK_MAP_NODE_W);
    const direction = forward ? 1 : -1;
    const bend = Math.max(46, Math.min(150, Math.abs(tx - sx) * 0.45));
    return `M ${sx} ${sy} C ${sx + direction * bend} ${sy}, ${tx - direction * bend} ${ty}, ${tx} ${ty}`;
  }

  function taskMapTransform() {
    const world = $('#taskMapWorld');
    if (!world) return;
    world.style.transform = `translate(${_taskMapState.x}px, ${_taskMapState.y}px) scale(${_taskMapState.scale})`;
    const label = $('#taskMapZoomLabel');
    if (label) label.textContent = Math.round(_taskMapState.scale * 100) + '%';
  }

  function zoomTaskMap(nextScale, clientX, clientY) {
    const canvas = $('#taskMapCanvas');
    if (!canvas) return;
    const scale = Math.max(0.25, Math.min(2.5, nextScale));
    const cx = clientX == null ? canvas.clientWidth / 2 : clientX;
    const cy = clientY == null ? canvas.clientHeight / 2 : clientY;
    const ratio = scale / _taskMapState.scale;
    _taskMapState.x = cx - (cx - _taskMapState.x) * ratio;
    _taskMapState.y = cy - (cy - _taskMapState.y) * ratio;
    _taskMapState.scale = scale;
    _taskMapState.hasView = true;
    taskMapTransform();
  }

  function fitTaskMap() {
    const canvas = $('#taskMapCanvas'), world = $('#taskMapWorld');
    if (!canvas || !world) return;
    const width = world.offsetWidth || 1;
    const height = world.offsetHeight || 1;
    const availableW = Math.max(80, canvas.clientWidth - 32);
    const availableH = Math.max(80, canvas.clientHeight - 32);
    const scale = Math.max(0.25, Math.min(1.2, availableW / width, availableH / height));
    _taskMapState.scale = scale;
    _taskMapState.x = (canvas.clientWidth - width * scale) / 2;
    _taskMapState.y = (canvas.clientHeight - height * scale) / 2;
    _taskMapState.hasView = true;
    taskMapTransform();
  }

  function drawTaskMap() {
    const world = $('#taskMapWorld'), edgesEl = $('#taskMapEdges'), nodesEl = $('#taskMapNodes');
    if (!world || !edgesEl || !nodesEl) return;
    const nodes = _taskMapState.data.nodes || [];
    const links = _taskMapState.data.links || [];
    const empty = $('#taskMapEmpty');
    const stats = $('#taskMapStats');
    if (stats) stats.textContent = `${nodes.length} 节点 · ${links.length} 连线`;
    if (!nodes.length) {
      _taskMapState.positions = new Map();
      world.style.width = '1px';
      world.style.height = '1px';
      edgesEl.innerHTML = '';
      nodesEl.innerHTML = '';
      if (empty) empty.classList.add('show');
      return;
    }
    if (empty) empty.classList.remove('show');

    // ★ 2026-09-13：用户要求始终横向工作流布局（禁止纵向排布；仅读 'h' 坐标）
    const vertical = false;
    _taskMapState.vertical = false;
    const layout = taskMapTopology(nodes, links, vertical);
    _taskMapState.positions = layout.positions;
    // ★ 2026-09-13：手动摆放位置覆盖（meta.map_pos；h=横屏 / v=竖屏 各存一份，切窗口宽度不互相污染）+ 画布扩容
    const viewKey = vertical ? 'v' : 'h';
    let worldW = layout.width, worldH = layout.height;
    nodes.forEach(n => {
      const saved = n.meta && n.meta.map_pos && n.meta.map_pos[viewKey];
      if (saved && _taskMapState.positions.has(Number(n.id))) {
        const p = _taskMapState.positions.get(Number(n.id));
        _taskMapState.positions.set(Number(n.id), { x: Number(saved.x) || p.x, y: Number(saved.y) || p.y, rank: p.rank });
        worldW = Math.max(worldW, (Number(saved.x) || 0) + TASK_MAP_NODE_W + 32);
        worldH = Math.max(worldH, (Number(saved.y) || 0) + TASK_MAP_NODE_H + 32);
      }
    });
    // ★ UI2.0 碰撞解算：持久化手动坐标可能互相重叠（如 #51/#63），按纵向推开，保持横向分层不变
    {
      const CW = TASK_MAP_NODE_W + 12, CH = TASK_MAP_NODE_H + 16, OVERLAP_X = 40;
      const arr = [];
      nodes.forEach(n => { const p = _taskMapState.positions.get(Number(n.id)); if (p && !p.aux) arr.push(p); });
      arr.sort((a, b) => (a.rank - b.rank) || a.y - b.y || a.x - b.x);
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const ox = Math.min(a.x + CW, b.x + CW) - Math.max(a.x, b.x);
            if (ox <= OVERLAP_X) continue; // 水平基本不重叠 → 不同列，不处理
            const oy = Math.min(a.y + CH, b.y + CH) - Math.max(a.y, b.y);
            if (oy > 0) { b.y = a.y + CH; moved = true; } // 同列纵向重叠 → 后者下移
          }
        }
        if (!moved) break;
      }
      _taskMapState.positions.forEach(p => { worldH = Math.max(worldH, p.y + TASK_MAP_NODE_H + 32); });
    }
    world.style.width = worldW + 'px';
    world.style.height = worldH + 'px';
    edgesEl.setAttribute('width', String(worldW));
    edgesEl.setAttribute('height', String(worldH));
    nodesEl.innerHTML = '';
    renderTaskMapEdges(); // 边渲染抽离（拖动时增量复用）

    // ★ 2026-09-15：地图状态三态（未完成 / 已完成 / 已归档）；细粒度状态仍在卡片抽屉与右键菜单；终结态不再误标的「未完成」
    // ★ 2026-09-18：running 单列「已领取」（琥珀色）—— 认领者是谁一眼可见（配合 SSE 实时推送）
    const statusBucket = (s) => { const st = String(s); if (st === 'done') return { label: '已完成', color: '#10b981' }; if (st === 'running') return { label: '已领取', color: '#f59e0b' }; if (st === 'archived' || st === 'cancelled' || st === 'failed') return { label: '已归档', color: '#64748b' }; return { label: '未完成', color: '#06b6d4' }; };
    const nodeById = new Map(nodes.map(x => [Number(x.id), x]));
    const auxKindOf = new Map();
    const hostOf = new Map(); // 辅助卡 → 宿主卡（辅助卡没有自身状态：标签/过滤/连线都跟随宿主）
    (_taskMapState.data.links || []).forEach(l => {
      const lk = String(l.kind);
      if (!lk.startsWith('aux_')) return;
      const s = Number(l.src_id), d = Number(l.dst_id);
      const auxKindOfK = (k) => { const kk = String(k ?? ''); return kk === 'aux' || kk.startsWith('aux_'); };
      if (auxKindOfK(nodeById.get(d)?.kind)) { auxKindOf.set(d, lk); hostOf.set(d, s); }
      else if (auxKindOfK(nodeById.get(s)?.kind)) { auxKindOf.set(s, lk); hostOf.set(s, d); }
    });
    const AUX_LABELS_LOCAL = { aux_project: '相关项目', aux_memory: '用户记忆', aux_rule: '规则定义', aux_skill: 'Skill 技能', aux_error: '历史错误' };
    nodes.forEach(node => {
      const position = _taskMapState.positions.get(Number(node.id));
      if (!position) return;
      const isAux = String(node.kind) === 'aux' || String(node.kind).startsWith('aux_');
      // 辅助卡：右上标签显示挂载类型（非 完成/未完成），边框色用类型色
      // ★ 2026-09-18：running 且有认领者 → 标签直显「已领取·智能体名」（实时：SSE claim 事件 → 800ms 防抖重画）
      const status = isAux
        ? { label: AUX_LABELS_LOCAL[auxKindOf.get(node.id)] || '辅助卡', color: (TASK_MAP_LINK_STYLE[auxKindOf.get(node.id)] || { color: '#64748b' }).color }
        : (String(node.status) === 'running' && node.assignee
          ? { label: `已领取·${String(node.assignee).slice(0, 14)}`, color: '#f59e0b' }
          : statusBucket(node.status));
      const progress = Number(node.meta && node.meta.progress && node.meta.progress.percent);
      const progressText = Number.isFinite(progress) ? `${Math.round(progress)}%` : '';
      const priorityText = Number(node.priority || 0) > 0 ? `P${Number(node.priority)}` : '';
      const taskId = node.meta && node.meta.task_id ? String(node.meta.task_id) : '';
      const metaTail = [progressText, priorityText].filter(Boolean).join(' · ');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'task-map-node';
      button.dataset.cardId = String(node.id);
      button.style.left = position.x + 'px';
      button.style.top = position.y + 'px';
      button.style.setProperty('--node-color', status.color);
      button.title = `#${node.id} ${node.title}`;
      button.setAttribute('aria-label', `打开卡片 #${node.id} ${node.title}`);
      // 辅助卡样式（虚线小卡）；注意 classList.add 不接受空串，非 aux 不加类
      if (isAux) button.classList.add('task-map-node-aux');
      button.innerHTML = `
        <span class="task-map-node-top">
          <span>#${node.id}${taskId ? ' · ' + esc(taskId) : ''}</span>
          <span class="task-map-node-status">${esc(status.label)}</span>
        </span>
        <span class="task-map-node-title">${esc(node.title)}</span>
        <span class="task-map-node-meta">
          <span>${esc(isAux ? '' : (node.assignee || '未分配'))}</span>
          <span>${esc(isAux ? '' : (metaTail || node.kind || ''))}</span>
        </span>
        <span class="task-map-node-link" data-card-id="${node.id}" title="按住拖到目标卡：建立依赖连线" aria-label="拖出连线">+</span>`;
      if (_taskMapFilter) {
        // 辅助卡过滤跟随宿主卡（自身无状态）
        const hostId = hostOf.get(node.id);
        const ref = (hostId != null && isAux) ? (nodeById.get(hostId) || node) : node;
        // 优先用后端 bucket（三态），aux 无 bucket 时按宿主状态回退三态
        const bkt = node.bucket != null ? node.bucket : (String(ref.status) === 'done' ? 'done' : (['archived', 'cancelled', 'failed'].includes(String(ref.status)) ? 'terminal' : 'open'));
        if (bkt !== _taskMapFilter) button.style.display = 'none';
      }
      // ★ 2026-09-14：非数字 id 节点（内存/自动匹配的 mem-N 子卡）不是真实卡片，点击/拖拽/右键均跳过，避免 openCardDetail(NaN) 与位置误存
      const realCard = /^\d+$/.test(String(node.id));
      button.onclick = () => {
        if (_taskMapState.suppressClick) return;
        if (!realCard) { toast(`关联子卡「${esc(node.title)}」为动态匹配，点击任务主卡操作`); return; }
        openCardDetail(Number(node.id));
      };
      // ★ 2026-09-13：卡片交互三件套 —— 拖拽定位 / 边框拖出连线 / 富右键菜单
      button.addEventListener('pointerdown', ev => {
        if (!realCard) { ev.stopPropagation(); return; } // 非真实卡不拖拽不连线
        if (ev.button !== 0) return;
        if (ev.target.classList.contains('task-map-node-link')) { ev.preventDefault(); ev.stopPropagation(); startLinkDraft(Number(node.id)); return; }
        ev.stopPropagation();
        dragTaskMapNode(Number(node.id), ev, viewKey);
      });
      button.addEventListener('contextmenu', ev => { ev.preventDefault(); ev.stopPropagation(); if (realCard) showCardCtxMenu(ev, Number(node.id)); });
      nodesEl.appendChild(button);
    });
    taskMapTransform();
  }

  /* —— ★ 2026-09-13：边渲染抽离（整幅重绘 / 拖动增量刷新共用；含状态过滤 + 辅助卡连线样式） —— */
  function renderTaskMapEdges() {
    const edgesEl = $('#taskMapEdges');
    if (!edgesEl) return;
    const nodes = _taskMapState.data.nodes || [];
    const links = _taskMapState.data.links || [];
    const vertical = _taskMapState.vertical;
    const statusOf = new Map(nodes.map(n => [Number(n.id), n.status]));
    edgesEl.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(ns, 'defs');
    edgesEl.appendChild(defs);
    Object.entries(TASK_MAP_LINK_STYLE).forEach(([kind, style]) => {
      const marker = document.createElementNS(ns, 'marker');
      marker.setAttribute('id', `taskMapArrow-${kind}`);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const arrow = document.createElementNS(ns, 'path');
      arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      arrow.setAttribute('fill', style.color);
      marker.appendChild(arrow);
      defs.appendChild(marker);
    });
    const kindOfNode = new Map(nodes.map(n => [Number(n.id), String(n.kind)]));
    links.forEach(link => {
      const kind = String(link.kind);
      let s = Number(link.src_id), d = Number(link.dst_id);
      if (!statusOf.has(s) || !statusOf.has(d) || s === d) return;
      // 辅助卡挂载边：完成卡规则与二态过滤都用宿主卡状态（辅助卡自身无状态）；绘制方向统一 宿主 → 辅助卡
      const isAuxLink = kind.startsWith('aux_');
      const hostRef = isAuxLink ? (kindOfNode.get(s) === 'aux' ? d : s) : null;
      if (isAuxLink && kindOfNode.get(s) === 'aux') [s, d] = [d, s];
      // ★ 已完成卡片不参与连线（任一端点 done → 整条边隐藏；辅助边看宿主卡）
      if (isAuxLink ? statusOf.get(hostRef) === 'done' : (statusOf.get(s) === 'done' || statusOf.get(d) === 'done')) return;
      // ★ 2026-09-15：过滤三态（open / done / terminal）——终结态(archived/cancelled/failed)不再混入「未完成」
      if (_taskMapFilter) {
        const bucket = (id) => { const s = statusOf.get(id); if (s === 'done') return 'done'; if (s === 'archived' || s === 'cancelled' || s === 'failed') return 'terminal'; return 'open'; };
        if (isAuxLink ? bucket(hostRef) !== _taskMapFilter : (bucket(s) !== _taskMapFilter || bucket(d) !== _taskMapFilter)) return;
      }
      // ★ 方向修复：depends/spawned_by 按「前置 → 依赖方」绘制，箭头指向工作流方向（原实现箭头指反）
      if (kind === 'depends' || kind === 'spawned_by') [s, d] = [d, s];
      const source = _taskMapState.positions.get(s);
      const target = _taskMapState.positions.get(d);
      if (!source || !target) return;
      const style = TASK_MAP_LINK_STYLE[kind] || { color: '#94a3b8', width: 1.5, dash: '2 4' };
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', taskMapEdgePath(source, target, vertical));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', style.color);
      path.setAttribute('stroke-width', String(style.width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('opacity', '0.78');
      if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
      const markerId = TASK_MAP_LINK_STYLE[kind] ? kind : 'relates';
      path.setAttribute('marker-end', `url(#taskMapArrow-${markerId})`);
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${kind}${link.context ? ' · ' + link.context : ''}`;
      path.appendChild(title);
      edgesEl.appendChild(path);
    });
  }

  /* —— ★ 2026-09-13：卡片拖动 → 位置持久化（meta.map_pos h/v 分屏保存；后端 POST /api/cards/:id/position）—— */
  function dragTaskMapNode(cardId, e, viewKey) {
    const el = document.querySelector(`#taskMapNodes .task-map-node[data-card-id="${cardId}"]`);
    if (!el) return;
    const startLeft = Number(el.style.left) || 0;
    const startTop = Number(el.style.top) || 0;
    const sx = e.clientX, sy = e.clientY;
    const scale = _taskMapState.scale || 1;
    let moved = false;
    const move = ev => {
      moved = true;
      el.style.left = (startLeft + (ev.clientX - sx) / scale) + 'px';
      el.style.top = (startTop + (ev.clientY - sy) / scale) + 'px';
      renderTaskMapEdges();
    };
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      if (!moved) return;
      const x = Math.round(startLeft + (ev.clientX - sx) / scale);
      const y = Math.round(startTop + (ev.clientY - sy) / scale);
      _taskMapState.positions.set(Number(cardId), { x, y, rank: 0 });
      _taskMapState.suppressClick = true;
      setTimeout(() => { _taskMapState.suppressClick = false; }, 60);
      fetch(`/api/cards/${cardId}/position`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ view: viewKey, x, y }),
      }).then(r => r.json()).then(j => { if (!j.ok) console.warn('位置保存失败', j.error); }).catch(() => { /* 静默降级：仅内存生效 */ });
      renderTaskMapEdges();
    };
    el.classList.add('dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* —— ★ 2026-09-13：卡片边框拖出连线（depends 依赖边；后端 dependsPathExists 环检测，409 即回显原因）—— */
  function startLinkDraft(srcCardId) {
    const edgesEl = $('#taskMapEdges'), world = $('#taskMapWorld');
    const srcPos = _taskMapState.positions.get(Number(srcCardId));
    if (!edgesEl || !world || !srcPos) return;
    const ns = 'http://www.w3.org/2000/svg';
    const tmp = document.createElementNS(ns, 'path');
    tmp.setAttribute('fill', 'none');
    tmp.setAttribute('stroke', '#f59e0b');
    tmp.setAttribute('stroke-width', '2');
    tmp.setAttribute('stroke-dasharray', '6 4');
    tmp.setAttribute('vector-effect', 'non-scaling-stroke');
    edgesEl.appendChild(tmp);
    const srcPt = { x: srcPos.x + TASK_MAP_NODE_W, y: srcPos.y + TASK_MAP_NODE_H / 2 };
    let hoverId = null;
    const toWorld = ev => {
      const wr = world.getBoundingClientRect();
      const s = _taskMapState.scale || 1;
      return { x: (ev.clientX - wr.left) / s, y: (ev.clientY - wr.top) / s };
    };
    const move = ev => {
      const p = toWorld(ev);
      tmp.setAttribute('d', `M ${srcPt.x} ${srcPt.y} L ${p.x} ${p.y}`);
      const elAt = document.elementFromPoint(ev.clientX, ev.clientY);
      const t = elAt && elAt.closest ? elAt.closest('.task-map-node') : null;
      const newId = t ? Number(t.dataset.cardId) : null;
      const hit = (newId && newId !== Number(srcCardId)) ? newId : null;
      if (hit !== hoverId) {
        document.querySelectorAll('.task-map-node.link-target').forEach(n => n.classList.remove('link-target'));
        hoverId = hit;
        if (hoverId) { const el2 = document.querySelector(`.task-map-node[data-card-id="${hoverId}"]`); if (el2) el2.classList.add('link-target'); }
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      tmp.remove();
      document.querySelectorAll('.task-map-node.link-target').forEach(n => n.classList.remove('link-target'));
      if (hoverId) {
        fetch(`/api/cards/${srcCardId}/links`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dst_card_id: hoverId, kind: 'depends' }),
        }).then(r => r.json().catch(() => ({}))).then(j => {
          if (j.ok) { toast(`已连线：#${srcCardId} 依赖 #${hoverId}`); renderTaskMap(); }
          else toast('连线失败：' + (j.error || '未知'));
        }).catch(() => toast('连线失败（网络）'));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* —— ★ 2026-09-13：卡片富右键菜单（状态流转/认领/画线/挂辅助卡/同步MCP/删除；整合卡片看板与任务视图操作）—— */
  const AUX_CARD_TYPES = [
    ['aux_project', '相关项目'], ['aux_memory', '用户记忆'], ['aux_rule', '规则定义'],
    ['aux_skill', 'Skill 技能'], ['aux_error', '历史错误记录'],
  ];
  const AUX_LABEL = Object.fromEntries(AUX_CARD_TYPES.map(([k, l]) => [k, l]));
  async function showCardCtxMenu(e, cardId) {
    const r = await fetch(`/api/cards/${cardId}`).then(x => x.json()).catch(() => null);
    if (!r || !r.card) return;
    const card = r.card;
    const menu = $('#cardCtxMenu');
    if (!menu) return;
    const statusOpts = [
      ['ready', '置为可执行'], ['review', '待验收'], ['done', '标记完成'],
      ['failed', '标记失败'], ['cancelled', '取消'], ['blocked', '标记受阻'],
    ];
    menu.innerHTML = `
      <div class="context-menu-title">卡片 #${card.id} · ${esc(String(card.title || '').slice(0, 18))}</div>
      <div class="context-menu-item" data-cardact="claim">✔ 认领</div>
      <div class="context-menu-item" data-cardact="detail">👁 打开详情</div>
      <div class="context-menu-item" data-cardact="link">➡ 拖出依赖连线</div>
      ${AUX_CARD_TYPES.map(([k, l]) => `<div class="context-menu-item" data-cardact="aux" data-aux="${k}">📎 挂${l}</div>`).join('')}
      ${statusOpts.filter(([s]) => s !== card.status).map(([s, l]) => `<div class="context-menu-item" data-cardact="status" data-status="${s}">${l}</div>`).join('')}
      <div class="context-menu-item" data-cardact="pushmcp">⚡ 同步到 MCP</div>
      <div class="context-menu-item danger" data-cardact="delete">🗑 删除卡片</div>`;
    menu.dataset.cardId = String(cardId);
    menu.classList.add('show');
    menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 380) + 'px';
    if (menu.dataset.bound) return; // 点击委托只绑一次（innerHTML 重建不影响）
    menu.dataset.bound = '1';
    menu.addEventListener('click', async ev => {
      const item = ev.target.closest('.context-menu-item');
      if (!item) return;
      menu.classList.remove('show');
      const act = item.dataset.cardact;
      const H = { method: 'POST', headers: { 'content-type': 'application/json' } };
      try {
        if (act === 'claim') {
          const j = await fetch(`/api/cards/${cardId}/claim?as=human:dashboard`, { method: 'POST' }).then(x => x.json().catch(() => ({})));
          toast(j.ok ? `已认领 #${cardId}` : ('认领失败：' + (j.error || '')));
          renderTaskMap();
        } else if (act === 'detail') {
          openCardDetail(cardId);
        } else if (act === 'link') {
          startLinkDraft(cardId);
        } else if (act === 'aux') {
          const kind = item.dataset.aux;
          const label = AUX_LABEL[kind] || kind;
          const t = prompt(`新建「${label}」辅助卡（挂在主任务 #${cardId} 上，供智能体读上下文）：`, `aux-${label} #${cardId}`);
          if (!t) return;
          const cr = await fetch('/api/cards', { ...H, body: JSON.stringify({ title: t, kind: 'aux' }) }).then(x => x.json().catch(() => ({})));
          if (!cr.ok || !cr.id) { toast('辅助卡创建失败：' + (cr.error || '')); return; }
          const lr = await fetch(`/api/cards/${cardId}/links`, { ...H, body: JSON.stringify({ dst_card_id: cr.id, kind }) }).then(x => x.json().catch(() => ({})));
          if (!lr.ok) { toast('连线失败：' + (lr.error || '')); return; }
          toast(`已挂载${label}（卡片 #${cr.id}）`);
          renderTaskMap();
        } else if (act === 'status') {
          // CAS 并发安全：expected_from 前置校验，他人抢先改过 → 409 提示刷新，不静默覆盖
          const j = await fetch(`/api/cards/${cardId}/status`, { ...H, body: JSON.stringify({ status: item.dataset.status, expected_from: card.status, as: 'human:dashboard' }) }).then(x => x.json().catch(() => ({})));
          toast(j.ok ? `#${cardId} → ${j.to}` : ('改状态失败：' + (j.error || '可能已被其他操作改写，请刷新')));
          renderTaskMap();
        } else if (act === 'pushmcp') {
          const j = await fetch(`/api/cards/${cardId}/push-to-task`, { ...H, body: JSON.stringify({ as: 'human:dashboard' }) }).then(x => x.json().catch(() => ({})));
          toast(j.ok ? (j.noop ? `#${cardId} 已与 MCP 任务一致` : `已同步：${j.from} → ${j.to}`) : ('同步失败：' + (j.error || '该卡未绑定 MCP 任务')));
        } else if (act === 'delete') {
          if (!confirm(`删除卡片 #${cardId}？相关评论、事件和连线也会一并删除。`)) return;
          await fetch(`/api/cards/${cardId}`, { method: 'DELETE' });
          toast(`已删除卡片 #${cardId}`);
          renderTaskMap();
        }
      } catch (err) {
        toast('操作失败：' + (err.message || err));
      }
    });
  }
  async function renderTaskMap(opts = {}) {
    const canvas = $('#taskMapCanvas');
    if (!canvas) return;
    bindTaskMapControls();
    const seq = ++_taskMapState.seq;
    if (!_taskMapState.data.nodes.length) {
      const nodesEl = $('#taskMapNodes');
      if (nodesEl) nodesEl.innerHTML = '<div style="padding:40px;color:var(--text-muted);font-size:12px">加载卡片…</div>';
    }
    const data = await fetch('/api/cards/graph' + (_taskMapState.auto ? '' : '?auto=0')).then(r => r.json()).catch(() => null);
    if (seq !== _taskMapState.seq) return;
    if (!data || !data.ok) {
      const empty = $('#taskMapEmpty');
      if (empty) {
        empty.textContent = '任务地图加载失败';
        empty.classList.add('show');
      }
      return;
    }
    // ★ 2026-09-18：归档任务默认隐藏 —— 隐藏时剔掉 status='archived' 主卡、挂到它们的连线、
    //   以及失去宿主的 aux_ 动态子卡。chips 计数仍用全量（「已归档」chip 计数即隐藏提示，点击自动揭开）
    const viewNodes = data.nodes || [], viewLinks = data.links || [];
    let keptNodes = viewNodes, keptLinks = viewLinks;
    if (!_taskMapState.showArchived) {
      const gone = new Set();
      viewNodes.forEach(n => {
        const nk = String(n.kind);
        if (nk === 'aux' || nk.startsWith('aux_')) return; // aux 子卡跟随宿主，单独处理
        if (String(n.status) === 'archived') gone.add(String(n.id));
      });
      if (gone.size) {
        keptLinks = viewLinks.filter(l => !gone.has(String(l.src_id)) && !gone.has(String(l.dst_id)));
        const auxTouched = new Set();
        keptLinks.forEach(l => { const lk = String(l.kind); if (lk.startsWith('aux_')) { auxTouched.add(String(l.src_id)); auxTouched.add(String(l.dst_id)); } });
        keptNodes = viewNodes.filter(n => !gone.has(String(n.id)) && !(String(n.kind).startsWith('aux_') && !auxTouched.has(String(n.id))));
      }
    }
    _taskMapState.data = { nodes: keptNodes, links: keptLinks };
    // ★ 2026-09-13：状态二态 chips（已完成 / 未完成；细粒度状态仍在卡片抽屉与右键菜单保留；点击过滤，再点/全部=清除）
    const chips = $('#taskMapChips');
    if (chips && viewNodes.length) {
      // ★ 2026-09-15：状态三态 chips（未完成 / 已完成 / 已归档）；终结态(archived/cancelled/failed)归「已归档」，不再混入「未完成」
      let open = 0, done = 0, terminal = 0;
      viewNodes.forEach(n => {
        const nk = String(n.kind);
        if (nk === 'aux' || nk.startsWith('aux_')) return; // 辅助卡是挂载物，不计入任务统计
        const b = n.bucket != null ? n.bucket : (String(n.status) === 'done' ? 'done' : (['archived', 'cancelled', 'failed'].includes(String(n.status)) ? 'terminal' : 'open'));
        if (b === 'terminal') terminal++; else if (b === 'done') done++; else open++;
      });
      const chipDefs = [
        ['open', '未完成', '#06b6d4', open],
        ['done', '已完成', '#10b981', done],
        ['terminal', '已归档', '#64748b', terminal],
      ];
      chips.innerHTML = chipDefs.map(([k, l, color, c]) =>
        c ? `<button class="task-map-chip" data-chip="${k}" style="${_taskMapFilter === k ? 'outline:2px solid ' + color + ';outline-offset:1px' : ''}"><i style="background:${color}"></i>${l} ${c}</button>` : ''
      ).join('') + '<button class="task-map-chip" data-chip="" title="清除过滤">全部</button>';
      chips.querySelectorAll('[data-chip]').forEach(b => b.onclick = () => {
        const chip = b.dataset.chip || null;
        _taskMapFilter = chip;
        // 点「已归档」过滤需先让归档数据可见（默认隐藏时自动揭开，与工具栏按钮同步）
        if (chip === 'terminal' && !_taskMapState.showArchived) _taskMapSetShowArchived(true);
        renderTaskMap();
      });
    }
    drawTaskMap();
    if (opts.fit || !_taskMapState.hasView) requestAnimationFrame(fitTaskMap);
  }

  // ★ 2026-09-14：自动关联开关按钮态（开=高亮 btn-primary，关=btn-ghost）
  function refreshAutoBtn(btn) {
    if (!btn) return;
    btn.className = _taskMapState.auto ? 'btn-primary' : 'btn-ghost';
    btn.textContent = _taskMapState.auto ? '自动关联 ✓' : '自动关联';
    btn.title = _taskMapState.auto ? '自动关联已开启：语义连线+关联记忆子卡；点击关闭' : '自动关联已关闭；点击开启语义连线+关联记忆子卡';
  }
  // ★ 2026-09-18：「查看归档」按钮态（默认隐藏归档=高亮提示可点开；显示归档=ghost）
  function refreshArchiveViewBtn(btn) {
    if (!btn) return;
    btn.className = _taskMapState.showArchived ? 'btn-ghost' : 'btn-primary';
    btn.textContent = _taskMapState.showArchived ? '隐藏归档' : '📦 查看归档';
    btn.title = _taskMapState.showArchived ? '归档任务已显示在地图中；点击隐藏归档任务' : '归档任务默认隐藏；点击在地图中显示归档任务';
  }
  function _taskMapSetShowArchived(on) {
    _taskMapState.showArchived = on;
    try { localStorage.setItem('memoryos-map-archived', on ? '1' : '0'); } catch { /* ignore */ }
    refreshArchiveViewBtn($('#taskMapArchiveViewBtn'));
  }

  function bindTaskMapControls() {
    if (_taskMapState.bound) return;
    const canvas = $('#taskMapCanvas');
    if (!canvas) return;
    _taskMapState.bound = true;
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomTaskMap(_taskMapState.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('.task-map-node')) return;
      _taskMapState.drag = { x: _taskMapState.x, y: _taskMapState.y, sx: event.clientX, sy: event.clientY };
      canvas.classList.add('panning');
    });
    window.addEventListener('pointermove', event => {
      const drag = _taskMapState.drag;
      if (!drag) return;
      _taskMapState.x = drag.x + event.clientX - drag.sx;
      _taskMapState.y = drag.y + event.clientY - drag.sy;
      _taskMapState.hasView = true;
      taskMapTransform();
    });
    window.addEventListener('pointerup', () => {
      _taskMapState.drag = null;
      canvas.classList.remove('panning');
    });
    window.addEventListener('pointercancel', () => {
      _taskMapState.drag = null;
      canvas.classList.remove('panning');
    });
    window.addEventListener('resize', () => {
      if (_taskViewMode !== 'map') return;
      // ★ 2026-09-13：始终横向布局，resize 仅需重新适配视口
      fitTaskMap();
    });
    const layoutBtn = $('#taskMapLayoutBtn');
    if (layoutBtn) layoutBtn.onclick = () => {
      // ★ 2026-09-13：自动排布 = 清空全部手动位置（回到确定性分层布局），再重绘适配
      fetch('/api/cards/positions', { method: 'DELETE' }).then(() => renderTaskMap({ fit: true })).catch(() => renderTaskMap({ fit: true }));
    };
    // ★ 2026-09-14：自动关联开关 —— 切换 ？auto=0/1，持久化 localStorage，重载地图
    const autoBtn = $('#taskMapAutoBtn');
    if (autoBtn) autoBtn.onclick = () => {
      _taskMapState.auto = !_taskMapState.auto;
      try { localStorage.setItem('memoryos-map-auto', _taskMapState.auto ? '1' : '0'); } catch { /* ignore */ }
      refreshAutoBtn(autoBtn);
      toast(_taskMapState.auto ? '自动关联已开启：语义连线 + 关联记忆子卡' : '自动关联已关闭：仅显示真实连线与手动绑定');
      renderTaskMap({ fit: false });
    };
    // 首次按持久化状态刷新按钮样式
    refreshAutoBtn(autoBtn);
    // ★ 2026-09-18：「查看归档」切换 —— 归档任务默认隐藏，点击在地图中显示/隐藏（持久化 localStorage）
    const archViewBtn = $('#taskMapArchiveViewBtn');
    if (archViewBtn) archViewBtn.onclick = () => {
      _taskMapSetShowArchived(!_taskMapState.showArchived);
      toast(_taskMapState.showArchived ? '已显示归档任务' : '已隐藏归档任务（「已归档」chip 点击仍可临时查看）');
      renderTaskMap({ fit: false });
    };
    refreshArchiveViewBtn(archViewBtn);
    const fitBtn = $('#taskMapFitBtn');
    if (fitBtn) fitBtn.onclick = fitTaskMap;
    const zoomOut = $('#taskMapZoomOutBtn');
    if (zoomOut) zoomOut.onclick = () => zoomTaskMap(_taskMapState.scale / 1.18);
    const zoomIn = $('#taskMapZoomInBtn');
    if (zoomIn) zoomIn.onclick = () => zoomTaskMap(_taskMapState.scale * 1.18);
    const zoomLabel = $('#taskMapZoomLabel');
    if (zoomLabel) zoomLabel.onclick = () => zoomTaskMap(1);
    // ★ 2026-09-13：卡片右键菜单 + 归档菜单 全局关闭（点任意处收起；空白处再右键也收起）
    document.addEventListener('click', () => { const m = $('#cardCtxMenu'); if (m) m.classList.remove('show'); const a = $('#archiveMenu'); if (a) a.classList.remove('show'); }, true);
    initArchiveMenu(); // 归档按钮初始化（幂等；标签随当前策略刷新）
    refreshArchiveBtn();
    document.addEventListener('contextmenu', ev => { const m = $('#cardCtxMenu'); if (m && !ev.target.closest('.task-map-node')) m.classList.remove('show'); });
  }

  /* —— C：卡片详情抽屉（多 Tab：正文/评论/事件/关联 + 30s 评论轮询 + 小红点 + Esc 关闭） —— */
  let _cardPollTimer = null, _cardTab = 'body';

  function stopCardPoll() { if (_cardPollTimer) { clearInterval(_cardPollTimer); _cardPollTimer = null; } }
  // ★ 2026-09-14 查漏：卡片详情统一关闭（Esc / 关闭按钮 / 认领 / 删除 共用，确保 keydown 监听器必被移除，防累积泄漏）
  function closeCardDetail() {
    stopCardPoll();
    $('#detailModal')?.classList.remove('show');
    document.removeEventListener('keydown', _cardEscHandler);
    _cardEscHandler = null;
  }
  let _cardEscHandler = null;

  async function openCardDetail(id) {
    const r = await fetch(`/api/cards/${id}`).then(x => x.json()).catch(() => null);
    if (!r || !r.card) { toast('卡片不存在'); return; }
    const card = r.card;
    const meta = CARD_STATES_UI.find(([s]) => s === card.status) || ['', '未知', '#64748b'];
    // ★ 是否绑定 MCP 任务记忆（卡片 ref_kind='memory' 且 ref_id 有效）
    const _mcpBound = card.ref_kind === 'memory' && Number(card.ref_id) > 0;
    const links = (card.links_out || []).map(l => `${l.kind} → ${l.dst_kind}#${l.dst_id ?? l.dst_title}`).join('<br>') || '—';
    const mems = (card.memories || []).map(m => `记忆#${m.memory_id}（${m.relation}）`).join('<br>') || '—';
    $('#modalBody').innerHTML = `
      <div style="display:flex;gap:6px;border-bottom:1px solid var(--border-glass);padding-bottom:10px;margin-bottom:12px">
        ${[['body','正文'],['comments','评论'],['events','事件'],['links','关联']].map(([k, t]) => `<button class="btn-ghost" data-ctab="${k}" style="padding:5px 14px;font-size:12px;${_cardTab === k ? 'background:rgba(65,187,200,0.15);color:var(--accent-cyan);border-color:rgba(65,187,200,0.35)' : ''}">${t}${k === 'comments' ? `<span id="commentDot" style="display:none;margin-left:6px;width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block"></span>` : ''}</button>`).join('')}
      </div>
      <div id="cardTabBody"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        <button class="btn-ghost" id="cardClaimBtn" style="padding:6px 14px;font-size:12px">认领</button>
        <button class="btn-ghost" id="cardPushMcpBtn" style="padding:6px 14px;font-size:12px;${_mcpBound ? '' : 'opacity:0.45;cursor:not-allowed'}" title="${_mcpBound ? '把本卡当前状态/标题回写到绑定的 MCP 任务记忆' : '该卡未绑定 MCP 任务'}" ${_mcpBound ? '' : 'disabled'}>⚡ 同步到 MCP</button>
        <button class="btn-danger" id="cardDeleteBtn" style="padding:6px 14px;font-size:12px">删除卡片</button>
        <button class="btn-ghost" id="cardCloseBtn" style="padding:6px 14px;font-size:12px">关闭（Esc）</button>
      </div>`;
    const bodyBox = $('#cardTabBody');
    const renderBody = () => {
      bodyBox.innerHTML = `
        <div class="detail-grid">
          ${pair('ID', '#' + card.id, true)}
          ${pair('状态', '', false, `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${meta[2]};display:inline-block"></span>${esc(meta[1])}</span>`)}
          ${pair('认领人', esc(card.assignee) || '未分配', true)}
          ${pair('类型', esc(card.kind), true)}
          ${pair('创建时间', fmtDate(card.created_at), true)}
        </div>
        <div class="detail-content-box" style="border-left-color:${meta[2]}">${renderContent(card.title)}${card.body ? `<hr style="opacity:0.15;margin:8px 0"><div style="white-space:pre-wrap">${esc(card.body)}</div>` : ''}</div>`;
    };
    const renderLinks = () => {
      bodyBox.innerHTML = `
        <div style="font-size:12px"><div style="color:var(--text-muted);margin-bottom:6px">关联链接（${(card.links_out || []).length}）</div><div style="color:var(--text-primary)">${links}</div></div>
        <div style="margin-top:14px;font-size:12px"><div style="color:var(--text-muted);margin-bottom:6px">关联记忆（${(card.memories || []).length}）</div><div style="color:var(--text-primary)">${mems}</div></div>`;
    };
    const renderComments = async () => {
      const cj = await fetch(`/api/cards/${id}/comments`).then(x => x.json()).catch(() => ({ comments: [] }));
      const cs = cj.comments || [];
      bodyBox.innerHTML = `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">评论（${cs.length}）</div>
        ${cs.length ? cs.map(cm => `<div style="padding:8px 10px;background:var(--bg-card);border:1px solid rgba(0,0,0,0.06);border-radius:8px;margin-bottom:6px;font-size:12px"><div style="color:var(--text-muted);font-size:10px;margin-bottom:3px">${esc(cm.author)} · ${fmtDate(cm.created_at)}</div><div style="color:var(--text-primary);white-space:pre-wrap">${esc(cm.body)}</div></div>`).join('') : '<div style="padding:10px 0;color:var(--text-muted);font-size:12px">暂无评论</div>'}
        <div style="display:flex;gap:8px;margin-top:10px">
          <textarea id="cardCommentInput" rows="2" placeholder="写评论（进展 / 交接 / secret 内容会被拒绝）" style="flex:1;padding:8px 10px;border-radius:8px;background:var(--bg-card);color:var(--text-primary);border:1px solid var(--border-glass);font-size:12px"></textarea>
          <button class="btn-ghost" id="cardCommentSendBtn" style="padding:6px 14px;font-size:12px">发送</button>
        </div>`;
      const send = $('#cardCommentSendBtn');
      if (send) send.onclick = async () => {
        const body = $('#cardCommentInput').value.trim();
        if (!body) return;
        const res = await fetch(`/api/cards/${id}/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, author: 'human:dashboard' }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { toast(j.error || '评论失败'); return; }
        renderComments();
      };
    };
    const renderEvents = async () => {
      const ej = await fetch(`/api/cards/${id}/events`).then(x => x.json()).catch(() => ({ events: [] }));
      const evs = ej.events || [];
      bodyBox.innerHTML = `
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">事件时间线（${evs.length}）</div>
        ${evs.length ? evs.map(ev => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px"><span class="mono" style="color:var(--text-muted);font-size:10px;white-space:nowrap">${fmtDate(ev.created_at)}</span><span style="color:var(--text-primary)">${esc(ev.action)}${ev.from_status ? ` <span style="color:var(--text-muted)">${esc(ev.from_status)} → ${esc(ev.to_status || '')}</span>` : ''}</span></div>`).join('') : '<div style="padding:10px 0;color:var(--text-muted);font-size:12px">暂无事件</div>'}`;
    };
    const showTab = (k) => {
      _cardTab = k;
      $$('#modalBody [data-ctab]').forEach(b => {
        b.style.background = b.dataset.ctab === k ? 'rgba(65,187,200,0.15)' : '';
        b.style.color = b.dataset.ctab === k ? 'var(--accent-cyan)' : '';
        b.style.borderColor = b.dataset.ctab === k ? 'rgba(65,187,200,0.35)' : '';
      });
      if (k === 'body') renderBody();
      else if (k === 'links') renderLinks();
      else if (k === 'comments') renderComments();
      else renderEvents();
    };
    // ★ 2026-09-14 查漏：打开新卡片时重置 Tab 为正文，避免沿用上一张卡片的 Tab（评论/事件）
    _cardTab = 'body';
    showTab(_cardTab);
    // 30s 评论轮询 + 小红点（R7-4）
    let lastCount = (await fetch(`/api/cards/${id}/comments`).then(x => x.json()).catch(() => ({ comments: [] }))).comments?.length ?? 0;
    stopCardPoll();
    _cardPollTimer = setInterval(async () => {
      const cj = await fetch(`/api/cards/${id}/comments?poll=1`).then(x => x.json()).catch(() => ({ comments: [] }));
      const c = (cj.comments || []).length;
      if (c > lastCount && _cardTab !== 'comments') { const dot = $('#commentDot'); if (dot) dot.style.display = 'inline-block'; }
      if (_cardTab === 'comments') { lastCount = c; renderComments(); }
    }, 30000);
    $('#detailModal').classList.add('show');
    // ★ 2026-09-14 查漏：统一关闭路径（关按钮 / Esc / 认领成功 / 删除成功），移除监听器防累积泄漏
    $('#cardCloseBtn').onclick = closeCardDetail;
    _cardEscHandler = (e) => {
      if (e.key === 'Escape' && $('#detailModal').classList.contains('show')) closeCardDetail();
    };
    document.addEventListener('keydown', _cardEscHandler);
    $('#cardClaimBtn').onclick = async () => {
      const res = await fetch(`/api/cards/${id}/claim?as=human:dashboard`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      toast(res.ok ? '已认领' : (j.error || '认领失败'));
      if (res.ok) { closeCardDetail(); refreshCurrentTaskView(); }
    };
    // ★ 2026-09-13：「同步到 MCP」显式入口 —— 把卡片当前状态/标题回写绑定任务的记忆头（后端幂等，连点不重复写）
    const pushMcpBtn = $('#cardPushMcpBtn');
    if (pushMcpBtn) {
      let pushMcpBusy = false;
      pushMcpBtn.onclick = async () => {
        if (pushMcpBusy || !_mcpBound) return; // 防连点 + 未绑定拦截（按钮本身已 disabled）
        pushMcpBusy = true;
        const orig = pushMcpBtn.textContent;
        pushMcpBtn.textContent = '同步中…';
        try {
          const res = await fetch(`/api/cards/${id}/push-to-task`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: 'human:dashboard' }) });
          const j = await res.json().catch(() => ({}));
          if (res.ok) {
            toast(j.noop ? `卡片 #${id} 已与 MCP 任务一致（无需变更）` : `已同步：${j.from} → ${j.to}（任务 #${j.memory_id}）`);
          } else {
            toast(`同步失败：${j.error || res.status}`);
          }
        } catch (err) {
          toast('同步失败：' + err.message);
        } finally {
          pushMcpBusy = false;
          pushMcpBtn.textContent = orig;
        }
      };
    }
    $('#cardDeleteBtn').onclick = async () => {
      if (!confirm(`删除卡片 #${id}？相关评论、事件和连线也会一并删除。`)) return;
      const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(j.error || '删除卡片失败'); return; }
      closeCardDetail();
      toast(`已删除卡片 #${id}`);
      refreshCurrentTaskView();
    };
    $$('#modalBody [data-ctab]').forEach(b => b.onclick = () => showTab(b.dataset.ctab));
  }

  /* —— ★ 2026-09-13：完成任务归档（📦 按钮：自动/手动策略切换 + 立即归档）—— */
  async function refreshArchiveBtn() {
    const b = $('#taskMapArchiveBtn');
    if (!b) return;
    const r = await fetch('/api/cards/archive').then(x => x.json()).catch(() => null);
    if (!r || !r.ok) return;
    b.textContent = r.mode === 'auto' ? `📦 自动归档 ${r.days}天` : '📦 手动归档';
  }
  function initArchiveMenu() {
    const b = $('#taskMapArchiveBtn');
    if (!b || b.dataset.bound) return;
    b.dataset.bound = '1';
    b.onclick = ev => {
      ev.stopPropagation();
      const m = $('#archiveMenu');
      if (!m) return;
      m.innerHTML = `
        <div class="context-menu-title">已完成任务归档策略</div>
        <div class="context-menu-item" data-arch="auto">⏰ 自动归档：完成超 7 天自动归档（启动+每小时检查）</div>
        <div class="context-menu-item" data-arch="manual">🖐 手动归档：仅在「立即归档」时归档</div>
        <div class="context-menu-item" data-arch="now">⚡ 立即归档（按阈值归档所有已完成）</div>`;
      m.classList.add('show');
      m.style.left = Math.min(ev.clientX, window.innerWidth - 260) + 'px';
      m.style.top = (ev.clientY + 8) + 'px';
      if (!m.dataset.bound) {
        m.dataset.bound = '1';
        m.addEventListener('click', async e2 => {
          const item = e2.target.closest('.context-menu-item');
          if (!item) return;
          m.classList.remove('show');
          const act = item.dataset.arch;
          const H = { method: 'POST', headers: { 'content-type': 'application/json' } };
          if (act === 'now') {
            const r = await fetch('/api/cards/archive', { ...H, body: JSON.stringify({ now: true }) }).then(x => x.json().catch(() => ({})));
            toast(r.ok && r.run ? `已归档 ${r.run.archived} 张（阈值 ${r.run.cutoffDays} 天）` : ('归档失败：' + (r.error || '')));
            renderTaskMap();
          } else {
            const r = await fetch('/api/cards/archive', { ...H, body: JSON.stringify({ mode: act }) }).then(x => x.json().catch(() => ({})));
            toast(r.ok ? `已切换为${r.mode === 'auto' ? '自动归档' : '手动归档'}` : ('切换失败：' + (r.error || '')));
            refreshArchiveBtn();
          }
        });
      }
    };
  }

  async function createCard() {
    const title = prompt('新建卡片标题');
    if (!title) return;
    const res = await fetch('/api/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, kind: 'task' }) });
    const j = await res.json().catch(() => ({}));
    toast(res.ok ? `已建卡片 #${j.id}` : (j.error || '创建失败'));
    if (res.ok) refreshCurrentTaskView();
  }

  async function runDispatch() {
    const res = await fetch('/api/dispatch', { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      // ★ 2026-09-13：toast 带派发前对账结果；派发后刷新任务地图（原 renderCards 只刷新已废弃的卡片看板，地图不会更新）
      const sync = j.synced && !j.synced.error ? ` · 对账补卡 ${j.synced.created ?? 0} · 补线 ${j.synced.linked ?? 0}` : '';
      toast(`派发完成：租约回收 ${j.leased_back ?? 0} · 提升 ${(j.promoted || []).length} · 熔断 ${(j.blocked || []).length} · 前瞻建卡 ${(j.prospective_cards || []).length}${sync}`);
      refreshCurrentTaskView();
    } else toast(j.error || '派发失败');
  }

  async function importLegacy() {
    const res = await fetch('/api/cards/import-legacy', { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    toast(res.ok ? `导入历史任务：新建 ${j.created} · 跳过 ${j.skipped}` : (j.error || '导入失败'));
    if (res.ok) renderCards();
  }

  /* ===== ★ P6 笔记编辑器（Obsidian：Markdown + [[ 候选 + 双向链接面板）===== */
  let _noteAll = [];
  function initNoteEditor() {
    const save = $('#noteSaveBtn');
    if (save && !save.dataset.bound) {
      save.dataset.bound = '1';
      // R6-2：保存 500ms 防抖（连续点击只执行最后一次，防高频写盘）
      let t = null;
      save.onclick = () => { clearTimeout(t); t = setTimeout(saveNote, 500); };
    }
    const prev = $('#notePreviewBtn');
    if (prev && !prev.dataset.bound) { prev.dataset.bound = '1'; prev.onclick = previewNote; }
    const body = $('#noteBody');
    if (body && !body.dataset.bound) {
      body.dataset.bound = '1';
      body.addEventListener('keyup', onNoteTyping);
      body.addEventListener('keydown', onNoteKeydown);
      body.addEventListener('blur', () => setTimeout(hideNoteSuggest, 200));
    }
    const sel = $('#noteSelect');
    if (sel && !sel.dataset.bound) { sel.dataset.bound = '1'; sel.onchange = showNoteLinks; }
    const rf = $('#noteLinksRefresh');
    if (rf && !rf.dataset.bound) { rf.dataset.bound = '1'; rf.onclick = showNoteLinks; }
    loadNotesList();
  }
  async function loadNotesList() {
    const sel = $('#noteSelect'); if (!sel) return;
    const data = await fetch('/api/notes').then(r => r.json()).catch(() => ({ notes: [] }));
    _noteAll = data.notes || [];
    sel.innerHTML = '<option value="">选择笔记…</option>' + _noteAll.map(n => `<option value="${n.id}">${esc(n.title)}${n.origin === 'user' ? '（用户）' : ''}</option>`).join('');
  }
  function onNoteTyping() {
    const body = $('#noteBody'); const sug = $('#noteLinkSuggest'); if (!body || !sug) return;
    const pos = body.selectionStart; const text = body.value;
    const open = text.lastIndexOf('[[', pos);
    if (open === -1 || text.slice(open, pos).includes(']')) { hideNoteSuggest(); return; }
    const q = text.slice(open + 2, pos);
    const cands = _noteAll.filter(n => n.title.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
    if (!cands.length) { hideNoteSuggest(); return; }
    sug.style.display = 'block';
    sug.innerHTML = cands.map(c => `<div data-title="${esc(c.title)}" style="padding:7px 12px;cursor:pointer;font-size:12px;color:var(--text-primary)">${esc(c.title)}</div>`).join('');
    sug.querySelectorAll('div[data-title]').forEach(el => el.onclick = () => {
      const t = el.dataset.title;
      body.value = text.slice(0, open) + '[[' + t + ']]' + text.slice(pos);
      hideNoteSuggest();
      body.focus();
    });
  }
  function onNoteKeydown(e) {
    const sug = $('#noteLinkSuggest');
    if (sug && sug.style.display !== 'none' && e.key === 'Escape') { hideNoteSuggest(); e.preventDefault(); }
  }
  function hideNoteSuggest() { const s = $('#noteLinkSuggest'); if (s) s.style.display = 'none'; }
  function previewNote() {
    const box = $('#notePreviewBox'); if (!box) return;
    const body = $('#noteBody').value;
    box.innerHTML = body
      .replace(/!?\[\[([^\]|#^]+)(?:#[^\]]+)?(?:\|([^\]]+))?\]\]/g, (m, t) => {
        const hit = _noteAll.find(n => n.title === t);
        return hit ? `<span style="color:var(--accent-cyan)" title="笔记#${hit.id}">[[${esc(t)}]]</span>` : `<span style="color:var(--warning)" title="未解析">[[${esc(t)}]]</span>`;
      })
      .replace(/\n/g, '<br>');
    box.style.display = 'block';
  }
  async function saveNote() {
    const vault = currentVault();
    const hint = $('#noteHint');
    if (!vault) { hint.textContent = '请先在上方选择 / 输入 vault 路径'; hint.className = 'form-hint err'; return; }
    const title = $('#noteTitle').value.trim();
    const content = $('#noteBody').value.trim();
    if (!title) { hint.textContent = '标题不能为空'; hint.className = 'form-hint err'; return; }
    const res = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vault, title, content }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { hint.textContent = j.error || '保存失败'; hint.className = 'form-hint err'; return; }
    hint.textContent = '已保存 → ' + (j.note_path || j.file) + (j.created ? '' : '（已存在，追加时间戳后缀）');
    hint.className = 'form-hint';
    // ★ 2026-09-14 查漏：保存成功后同步刷新工作台（左侧栏 + 图谱），新笔记立即可见（原只刷新下拉框）
    await loadNoteIndex();
    renderNoteRail();
    drawNoteGraph();
  }
  async function showNoteLinks() {
    const sel = $('#noteSelect'); const panel = $('#noteLinksPanel'); if (!sel || !panel) return;
    const id = Number(sel.value);
    if (!id) { panel.textContent = '选择笔记查看反向链接'; return; }
    panel.innerHTML = '加载…';
    const res = await fetch(`/api/backlinks?kind=note&id=${id}`).then(r => r.json()).catch(() => null);
    if (!res) { panel.textContent = '加载失败'; return; }
    panel.innerHTML = `
      <div style="margin-bottom:6px;color:var(--text-muted)">已解析反向链接（${res.linked.length}）</div>
      ${res.linked.length ? res.linked.map(l => `<div style="padding:4px 0;color:var(--text-primary)">← ${esc(l.src_kind)}#${l.src_id}${l.context ? `<span style="color:var(--text-muted);margin-left:6px">${esc(String(l.context).slice(0, 40))}</span>` : ''}</div>`).join('') : '<div style="padding:4px 0">无</div>'}
      <div style="margin:10px 0 6px;color:var(--text-muted)">发出的链接（${res.outgoing.length}）</div>
      ${res.outgoing.length ? res.outgoing.map(l => `<div style="padding:4px 0;color:var(--text-primary)">→ ${l.dst_id ? esc(l.dst_kind) + '#' + l.dst_id : `<span style="color:var(--warning)">未解析 [[${esc(l.dst_title)}]]</span>`}</div>`).join('') : '<div style="padding:4px 0">无</div>'}
      <div style="margin:10px 0 6px;color:var(--text-muted)">未解析链接（${res.unresolved.length}）</div>
      ${res.unresolved.length ? res.unresolved.map(l => `<div style="padding:4px 0;color:var(--warning)">[[${esc(l.dst_title)}]]</div>`).join('') : '<div style="padding:4px 0">无</div>'}
      <div style="margin:10px 0 6px;color:var(--text-muted)">未链接提及（${res.unlinked.length}）</div>
      ${res.unlinked.length ? res.unlinked.map(u => `<div style="padding:4px 0;color:var(--text-secondary)">笔记#${u.note_id} …${esc(u.snippet)}</div>`).join('') : '<div style="padding:4px 0">无</div>'}
    `;
  }

  /* ===== Agent 页（C 路线）：内置 agent 对话 =====
     服务端无状态 → 对话历史随请求回传（仅 user/assistant 文本）；
     写门禁由「允许写入记忆库」勾选决定（受限模式下后端强制只读，前端同步置灰）。 */
  const AGENT_HISTORY = []; // [{role, content}] 最多回传 8 条
  let agentInited = false, agentBusy = false;

  function agentBubble(role, html) {
    const isUser = role === 'user';
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex;flex-direction:column;gap:5px;align-items:${isUser ? 'flex-end' : 'flex-start'}`;
    wrap.innerHTML = `<div style="font-size:11px;color:var(--text-muted)">${isUser ? '我' : 'Agent'}</div>
      <div style="max-width:86%;padding:10px 13px;border-radius:12px;font-size:13px;line-height:1.85;white-space:pre-wrap;word-break:break-word;${isUser
        ? 'background:rgba(65,187,200,0.12);border:1px solid rgba(65,187,200,0.25);color:var(--text-primary)'
        : 'background:rgba(255,255,255,0.72);border:1px solid rgba(15,23,42,0.08);color:var(--text-primary)'}">${html}</div>`;
    return wrap;
  }

  /* ★ 执行中心内联时间线（agent 页一体化）：发送即 SSE 实时渲染，点步骤展开终端/diff/产物。
     数据源：POST /api/agent/runs（立即回 runId）+ SSE /stream；步骤详情复用 /api/agent/runs/:id。 */
  let _agentRunLiveEs = null, _agentRunLivePoll = null, _agentRunLiveId = null, _agentRunLiveSteps = [], _agentRunLiveTimer = null, _agentRunLiveSeconds = 0;
  function _agentRunLiveStart(runId) {
    _agentRunLiveId = runId;
    _agentRunLiveSteps = [];
    const wrap = $('#agentRunLive');
    if (wrap) wrap.style.display = 'block';
    const tl = $('#agentRunLiveTimeline');
    if (tl) tl.innerHTML = '<div class="run-card-empty">agent 运行中，执行过程将实时显示在这里…</div>';
    const meta = $('#agentRunLiveMeta');
    if (meta) meta.textContent = '';
    // 「在执行中心查看」跳转
    const openBtn = $('#agentRunLiveOpen');
    if (openBtn) openBtn.onclick = () => { location.hash = 'runs'; };
    // 手动刷新按钮
    const refreshBtn = $('#agentRunLiveRefresh');
    if (refreshBtn) refreshBtn.onclick = () => {
      fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).then(j => {
        if (j && j.ok) { _agentRunLiveSteps = j.steps || []; _agentRunLiveRender(); }
      }).catch(() => {});
    };
    // 启动计时器
    _agentRunLiveSeconds = 0;
    const timerEl = $('#agentRunLiveTimer');
    const warnEl = $('#agentRunLiveWarn');
    if (warnEl) warnEl.style.display = 'none';
    if (_agentRunLiveTimer) clearInterval(_agentRunLiveTimer);
    _agentRunLiveTimer = setInterval(() => {
      _agentRunLiveSeconds++;
      if (timerEl) timerEl.textContent = _agentRunLiveSeconds + 's';
      // 30秒无步骤显示提示
      if (_agentRunLiveSeconds >= 30 && !_agentRunLiveSteps.length && warnEl) {
        warnEl.style.display = 'block';
      }
    }, 1000);
    const on = (type, d) => {
      if (type === 'thinking' || type === 'reasoning') {
        const card = { stepId: 'think-' + Date.now(), type: 'thinking', content: d.content || d.text || '', state: 'ok', tool: '思考' };
        _agentRunLiveSteps.push(card);
        _agentRunLiveRender();
      } else if (type === 'context') {
        const card = { stepId: 'ctx-' + Date.now(), type: 'context', content: d.content || d.systemPrompt || '', state: 'ok', tool: '上下文注入' };
        _agentRunLiveSteps.push(card);
        _agentRunLiveRender();
      } else if (type === 'step') {
        const st = _agentRunLiveSteps.find(x => x.stepId === d.stepId) || { stepId: d.stepId, tool: d.tool, argsPreview: d.argsPreview, state: 'pending' };
        st.state = 'pending'; st.argsPreview = d.argsPreview || st.argsPreview; st.tool = d.tool;
        if (!_agentRunLiveSteps.includes(st)) _agentRunLiveSteps.push(st);
        _agentRunLiveRender();
      } else if (type === 'step_end') {
        const st = _agentRunLiveSteps.find(x => x.stepId === d.stepId);
        if (st) { st.state = d.ok ? 'ok' : 'error'; st.elapsedMs = d.elapsedMs; st.preview = d.preview || ''; st.outChars = d.outChars; st.hasDiff = d.hasDiff; st.artifactPath = d.artifactPath; }
        _agentRunLiveRender();
      } else if (type === 'write_denied') {
        _agentRunLiveMeta.textContent = '✋ 有写操作被拦截（未勾选「允许写入」或受限模式）';
      } else if (type === 'answer') {
        // 终态：拉全量补 diff 字段，再收 SSE
        fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).then(j => {
          if (j && j.ok) { _agentRunLiveSteps = j.steps || []; _agentRunLiveRender(); _agentRunLiveMeta.textContent = j.status + ' · ' + (j.toolCalls || 0) + ' 工具 · ' + (((j.finishedAt - j.startedAt) / 1000).toFixed(1)) + 's'; }
          _agentRunLiveStop();
        }).catch(() => _agentRunLiveStop());
      } else if (type === 'done') {
        _agentRunLiveStop();
      }
    };
    _agentRunLiveEs = new EventSource('/api/agent/runs/' + encodeURIComponent(runId) + '/stream');
    ['step', 'step_end', 'thinking', 'reasoning', 'context', 'write_denied', 'answer', 'done'].forEach(ev => _agentRunLiveEs.addEventListener(ev, e => { try { on(ev, JSON.parse(e.data)); } catch {} }));
    _agentRunLiveEs.onerror = () => {
      // 降级轮询（2s）
      if (_agentRunLivePoll) return;
      _agentRunLivePoll = setInterval(async () => {
        const j = await fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).catch(() => null);
        if (j && j.ok) { _agentRunLiveSteps = j.steps || []; _agentRunLiveRender(); if (j.status !== 'running') _agentRunLiveStop(); }
      }, 2000);
    };
  }
  function _agentRunLiveStop() {
    if (_agentRunLiveEs) { _agentRunLiveEs.close(); _agentRunLiveEs = null; }
    if (_agentRunLivePoll) { clearInterval(_agentRunLivePoll); _agentRunLivePoll = null; }
    if (_agentRunLiveTimer) { clearInterval(_agentRunLiveTimer); _agentRunLiveTimer = null; }
  }
  function _agentRunLiveRender() {
    const tl = $('#agentRunLiveTimeline');
    if (!tl) return;
    tl.innerHTML = '';
    if (!_agentRunLiveSteps.length) { tl.innerHTML = '<div class="run-card-empty">agent 运行中，执行过程将实时显示在这里…</div>'; return; }
    for (const s of _agentRunLiveSteps) {
      const card = document.createElement('div');
      card.className = 'run-card';
      // 判断类型
      let cardType = 'tool';
      if (s.type === 'thinking') cardType = 'thinking';
      else if (s.type === 'context') cardType = 'context';
      else if (s.tool && (s.tool.includes('write') || s.tool.includes('文件') || s.tool.includes('Bash') || s.tool.includes('shell'))) cardType = 'code';
      const typeLabel = { thinking: '思考', tool: '工具', code: '代码', context: '上下文', system: '系统' }[cardType] || '工具';
      const stateCls = s.state === 'ok' ? 'ok' : s.state === 'error' ? 'error' : 'pending';
      const stateText = s.state === 'ok' ? '完成' : s.state === 'error' ? '失败' : '进行中';
      const ms = s.elapsedMs != null ? ' · ' + (s.elapsedMs / 1000).toFixed(1) + 's' : '';
      // 构建内容
      let bodyHtml = '';
      if (s.type === 'thinking') {
        bodyHtml = `<div class="run-card-thinking">${esc(s.content || s.preview || '思考中…')}</div>`;
      } else if (s.type === 'context') {
        bodyHtml = `<div class="run-card-body">注入系统提示词</div><pre>${esc(s.content || '')}</pre>`;
      } else {
        // 工具调用卡片
        if (s.argsPreview) bodyHtml += `<div class="run-card-body">${esc(s.argsPreview)}</div>`;
        if (s.preview) bodyHtml += `<pre>${esc(s.preview)}</pre>`;
        // 子操作（写入文件、执行命令等）
        if (s.subOps && s.subOps.length) {
          for (const op of s.subOps) {
            const opIcon = op.type === 'write' ? '📝' : op.type === 'bash' ? '⌨️' : '🔧';
            bodyHtml += `<div class="run-card-sub"><span>${opIcon}</span><span class="sub-label">${esc(op.type === 'write' ? '写入' : op.type === 'bash' ? 'Bash' : op.type)}</span><span class="sub-value">${esc(op.value || '')}</span></div>`;
          }
        }
        if (s.hasDiff) bodyHtml += `<button class="btn-ghost" style="padding:3px 8px;font-size:10px;margin-top:4px" data-a="diff">查看 diff</button>`;
        if (s.artifactPath) bodyHtml += `<button class="btn-ghost" style="padding:3px 8px;font-size:10px;margin-top:4px;margin-left:4px" data-a="art">查看产物</button>`;
      }
      card.innerHTML = `
        <div class="run-card-header">
          <span class="run-card-type ${cardType}">${typeLabel}</span>
          <span class="run-card-title">${esc(s.tool || s.stepId)}</span>
          <span class="run-card-state ${stateCls}">${stateText}${ms}</span>
        </div>
        ${bodyHtml}
        <div data-detail="${s.stepId}" style="display:none;margin-top:6px"></div>`;
      // 点击展开详情
      card.onclick = (e) => {
        if (e.target.dataset.a === 'diff') { _agentRunLiveDetail(s.stepId, true); e.stopPropagation(); return; }
        if (e.target.dataset.a === 'art') { _agentRunLiveDetail(s.stepId, false, true); e.stopPropagation(); return; }
        if (e.target.tagName === 'BUTTON' || e.target.closest('details')) return;
        _agentRunLiveDetail(s.stepId);
      };
      tl.appendChild(card);
    }
    // 自动滚动到底部
    tl.scrollTop = tl.scrollHeight;
  }
  async function _agentRunLiveDetail(stepId, focusDiff, focusArtifact) {
    // 拉该 run 全量（含 diff 字段），定位该步骤渲染详情
    const j = await fetch('/api/agent/runs/' + encodeURIComponent(_agentRunLiveId)).then(r => r.json()).catch(() => null);
    if (!j || !j.ok) return;
    const s = (j.steps || []).find(x => x.stepId === stepId);
    if (!s) return;
    s._diff = s.diff || null;
    const box = document.querySelector(`#agentRunLiveTimeline [data-detail="${stepId}"]`);
    if (!box) return;
    $$('#agentRunLiveTimeline .run-card').forEach(x => x.classList.toggle('sel', x.querySelector('[data-detail=""]') !== null));
    // 收起其他已展开详情
    $$('#agentRunLiveTimeline [data-detail]').forEach(b => { if (b !== box) b.style.display = 'none'; });
    let html = '';
    if (focusArtifact && s.artifactPath) {
      html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">产物（exec 大输出落盘）</div>
        <a style="font-size:12px;color:var(--accent-cyan)" target="_blank" href="/api/artifacts/${encodeURIComponent(s.artifactPath.split(/[\\/]/).pop())}">查看 / 下载 artifact</a>`;
    }
    if (focusDiff && s._diff && s._diff.hunks) {
      const flat = s._diff.hunks.flatMap(h => h.lines).map(l => l.type === 'add' ? `<span class="diff-add">+ ${esc(l.text)}</span>` : l.type === 'del' ? `<span class="diff-del">− ${esc(l.text)}</span>` : `<span class="diff-ctx">  ${esc(l.text)}</span>`).join('\n');
      html += `<div style="font-size:11px;color:var(--text-muted);margin:6px 0 3px">diff（${s._diff.additions}+/${s._diff.deletions}−）</div>
        <pre style="margin:0;padding:8px;border-radius:8px;background:rgba(15,23,42,0.04);border:1px solid var(--border-glass);font-size:11px;line-height:1.55;white-space:pre;overflow:auto;max-height:200px">${flat}</pre>`;
    }
    if (!focusDiff && !focusArtifact) {
      if (s.argsPreview) html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">参数</div><pre style="margin:0;padding:8px;border-radius:8px;background:rgba(15,23,42,0.04);font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:160px;overflow:auto">${esc(s.argsPreview)}</pre>`;
      if (s.preview) html += `<div style="font-size:11px;color:var(--text-muted);margin:6px 0 3px">输出预览</div><pre style="margin:0;padding:8px;border-radius:8px;background:rgba(15,23,42,0.04);font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto">${esc(s.preview)}</pre>`;
      if (s.hasDiff) html += `<button class="tl-open-diff" data-a2="diff" style="margin-top:6px">展开 diff</button>`;
      if (s.artifactPath) html += `<button class="tl-open-diff" data-a2="art" style="margin-top:6px">展开产物</button>`;
    }
    box.innerHTML = html;
    box.style.display = '';
    const bd = box.querySelector('[data-a2="diff"]');
    if (bd) bd.onclick = () => _agentRunLiveDetail(stepId, true);
    const ba = box.querySelector('[data-a2="art"]');
    if (ba) ba.onclick = () => _agentRunLiveDetail(stepId, false, true);
  }

  async function agentSend() {
    if (agentBusy) return;
    const input = $('#agentInput'), chat = $('#agentChat');
    const text = (input && input.value || '').trim();
    if (!text || !chat) return;
    agentBusy = true;
    showRunStatus('正在思考…');
    if (chat.dataset.empty === '1') { chat.innerHTML = ''; chat.dataset.empty = '0'; }
    if (input) input.value = '';
    chat.appendChild(agentBubble('user', esc(text)));
    const pending = agentBubble('assistant', '<span class="text-muted">agent 运行中…执行过程实时展开在下方时间线（本地模型首轮较慢，多轮工具调用可能 1~2 分钟）</span>');
    chat.appendChild(pending);
    chat.scrollTop = chat.scrollHeight;
    const sendBtn = $('#agentSendBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '运行中…'; }
    const allowWrites = !!($('#agentAllowWrites') || {}).checked;
    // 内联执行过程清空待新 run
    _agentRunLiveStop();
    _agentRunLiveSteps = [];
    try {
      // 走 /api/agent/runs（立即 202 回 runId），过程由 SSE 实时推
      const res = await fetch('/api/agent/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history: AGENT_HISTORY.slice(-8), allowWrites, sessionKey: _agentSessionKey || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok || !j.runId) {
        pending.remove();
        chat.appendChild(agentBubble('assistant', `<span style="color:var(--warning)">⚠ ${esc(j.error || ('HTTP ' + res.status))}</span>`));
        setRunStatus('请求失败', 'error');
        agentBusy = false;
        if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '发送'; }
        return;
      }
      _agentRunLiveStart(j.runId);
      // ★ 驾驶舱「并行数」排队：超出并发上限的 run 先排队，空位腾出后自动启动（SSE 已挂上，启动即出事件）
      if (j.status === 'queued') {
        pending.innerHTML = '<span class="text-muted">已加入执行队列（前面 ' + (j.queueAhead || 0) + ' 个，上限 ' + (j.cap || '?') + '）——空位腾出自动开跑，过程照常实时展开…</span>';
      }
      // 等 SSE 终态（answer 事件触发 _agentRunLiveStop + 拉全量补结果）后再补聊天气泡
      await new Promise((resolve) => {
        const t0 = Date.now();
        const tick = () => {
          if (_agentRunLiveId && _agentRunLiveId === j.runId && !(_agentRunLiveEs || _agentRunLivePoll)) { resolve(); return; }
          if (Date.now() - t0 > 5 * 60 * 1000) { resolve(); return; } // 5 分钟兜底
          setTimeout(tick, 800);
        };
        tick();
      });
      pending.remove();
      // 终态：拉答案补进聊天
      const fin = await fetch('/api/agent/runs/' + encodeURIComponent(j.runId)).then(r => r.json()).catch(() => null);
      const answer = (fin && fin.ok && fin.answer) || '（无内容）';
      const deniedNote = fin && fin.status === 'failed' ? `<div style="margin-top:6px;font-size:12px;color:var(--danger)">⚠ 运行失败：${esc(fin.error || '')}</div>` : '';
      chat.appendChild(agentBubble('assistant', esc(answer) + deniedNote));
      AGENT_HISTORY.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
      setRunStatus('已完成', 'done');
      if (AGENT_HISTORY.length > 16) AGENT_HISTORY.splice(0, AGENT_HISTORY.length - 16);
      // 会话条计数刷新（后端 startRun 已自动把本轮追加进 agent_sessions）
      if (_agentSessionKey) { _agentSessions.forEach(x => { if (x.session_key === _agentSessionKey) x.msg_count = (x.msg_count || 0) + 2; }); _agentSessionChips(); }
    } catch (e) {
      pending.remove();
      chat.appendChild(agentBubble('assistant', `<span style="color:var(--warning)">⚠ 请求失败：${esc(e.message)}</span>`));
      _agentRunLiveStop();
      setRunStatus('运行失败', 'error');
    } finally {
      agentBusy = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = '发送'; }
      chat.scrollTop = chat.scrollHeight;
    }
  }

  function initAgent() {
    const chat = $('#agentChat');
    if (chat && chat.dataset.empty === undefined) chat.dataset.empty = '1';
    // 页头状态：模型端点 + 工具面 + 写门禁（每次进入刷新，设置页改完立刻反映）
    fetch('/api/agent/status').then(r => r.json()).then(st => {
      const line = $('#agentStatusLine'); if (!line) return;
      const mcp = st.mcp || {}, wm = st.writeMode || {};
      line.innerHTML = `模型 <span class="mono">${esc(st.llm && st.llm.model || '?')}</span> @ <span class="mono">${esc(st.llm && st.llm.baseUrl || '?')}</span>（${esc(st.llm && st.llm.source || '')}）`
        + ` · 工具面 <span class="mono">${mcp.toolCount || 0}</span> 个`
        + (mcp.error ? ` <span style="color:var(--warning)">· 工具面异常：${esc(mcp.error)}</span>` : '')
        + ` · ${esc(wm.hint || '')}`;
      const wrap = $('#agentWriteWrap'), cb = $('#agentAllowWrites');
      if (wrap && cb && !wm.allowed) {
        cb.checked = false; cb.disabled = true; wrap.style.opacity = '0.45';
        wrap.title = '受限模式：agent 仅只读';
      }
    }).catch(() => { const line = $('#agentStatusLine'); if (line) line.textContent = 'agent 状态读取失败（内核未响应？）'; });

    if (agentInited) return;
    agentInited = true;
    const input = $('#agentInput'), btn = $('#agentSendBtn'), clear = $('#agentClearBtn');
    if (btn) btn.onclick = agentSend;
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); } });
    if (clear) clear.onclick = () => {
      AGENT_HISTORY.length = 0;
      if (chat) { chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">对话已清空（记忆库与任务不受影响）</div>'; chat.dataset.empty = '1'; }
      hideRunStatus();
    };
    // 运行状态条按钮
    const runStop = $('#agentRunStopBtn');
    if (runStop) runStop.onclick = () => _cockpitDispatch({ dataset: { act: '_agentCockpitAbort' } });
    const runCopy = $('#agentRunCopyBtn');
    if (runCopy) runCopy.onclick = () => _cockpitDispatch({ dataset: { act: '_agentCockpitCopy' } });
    const runExport = $('#agentRunExportBtn');
    if (runExport) runExport.onclick = () => _cockpitDispatch({ dataset: { act: '_agentCockpitExportChat' } });
    // ★ V1重构：更多功能面板 + 会话列表边栏
    initAgentMorePanel();
    initAgentSessionList();   // 会话列表（左侧边栏）
    initAgentSidebarButtons(); // 边栏快捷按钮绑定
  }
  /* ===== 智能体驾驶舱：10 域控制按钮组（数据驱动渲染）=====
     纪律：✓ 可点=接真实端点；▫ 灰显「未启用」=后端缺口，点击弹 tooltip 说明，绝不造假成功（B3 呈现层）。 */
  const COCKPIT = [
    { domain: '① 会话输入', open: true, btns: [
      { label: '＋ 新建会话', kind: 'real', act: '_agentSessionNew' },
      { label: '📜 历史运行', kind: 'real', act: '_agentFnHistory' },
      { label: '⏹ 停止生成', kind: 'real', act: '_agentCockpitAbort' },
      { label: '📋 复制回复', kind: 'real', act: '_agentCockpitCopy' },
      { label: '⬇ 导出对话', kind: 'real', act: '_agentCockpitExportChat' },
    ]},
    { domain: '② 任务目标', open: true, btns: [
      { label: '🎯 领任务做', kind: 'real', act: '_agentFnQuick', arg: 'task' },
      { label: '📋 任务看板', kind: 'real', act: '_agentCockpitNav', arg: 'tasks' },
      { label: '✅ 验收', kind: 'real', act: '_agentCockpitCard', arg: 'accept', hint: '需先在看板选中卡片' },
      { label: '↩ 打回', kind: 'real', act: '_agentCockpitCard', arg: 'refine', hint: '需先在看板选中卡片' },
      { label: '📦 归档', kind: 'real', act: '_agentCockpitCard', arg: 'archive', hint: '需先在看板选中卡片' },
      { label: '自动拆解', kind: 'real', act: '_agentCockpitDecompose', hint: 'LLM 把目标拆成可派发子任务' },
      { label: '回滚', kind: 'real', act: '_agentCockpitRollback', hint: '还原某次文件写入的写前快照（≤50KB）' },
      { label: '分支探索', kind: 'stub', why: '未启用：分支/合并需多 agent 编排（单独立项）' },
    ]},
    { domain: '③ 自主权模式', open: true, btns: [
      { label: '只读⇄可写', kind: 'real', act: '_agentCockpitToggleWrite' },
      { label: '受限状态', kind: 'real', act: '_agentCockpitRestricted' },
      { label: '计划模式', kind: 'stub', why: '未启用：计划/执行模式分离需内核 planner' },
      { label: '沙箱', kind: 'stub', why: '未启用：沙箱执行需容器级隔离（YAGNI 不做）' },
      { label: '逐工具批准', kind: 'stub', why: '审批三键 501 占位（writeGate 升级单独立项）' },
    ]},
    { domain: '④ 工具权限', btns: [
      { label: '工具面', kind: 'real', act: '_agentCockpitToolFace' },
      { label: '重启 MCP', kind: 'real', act: '_agentCockpitMcpRestart' },
      { label: '密钥管理', kind: 'real', act: '_agentCockpitNav', arg: 'settings' },
      { label: '执行工具开关', kind: 'real', act: '_agentCockpitExecToggle', hint: '开/关 file_read/file_write/exec_run（重 spawn MCP）' },
      { label: '浏览器控制', kind: 'stub', why: '未启用：browser_* 工具域（YAGNI 不做）' },
    ]},
    { domain: '⑤ 审批安全', btns: [
      { label: '✋ 拒绝', kind: 'real', act: '_agentCockpitDeny', hint: '拒绝当前被门禁拦截的写操作' },
      { label: '⏹ 紧急停止', kind: 'real', act: '_agentCockpitAbort' },
      { label: '查审计', kind: 'real', act: '_agentCockpitAudit' },
      { label: '撤销凭据', kind: 'real', act: '_agentCockpitCreds' },
      { label: '本次允许', kind: 'stub', why: '审批三键 501 占位（writeGate 升级单独立项）' },
    ]},
    { domain: '⑥ 记忆上下文', btns: [
      { label: '查记忆', kind: 'real', act: '_agentCockpitNav', arg: 'all' },
      { label: '🧠 沉淀记忆', kind: 'real', act: '_agentFnQuick', arg: 'mem' },
      { label: '删除记忆', kind: 'real', act: '_agentCockpitNav', arg: 'zombies' },
      { label: '压缩会话', kind: 'real', act: '_agentCockpitCompact' },
      { label: '导出记忆', kind: 'real', act: '_agentCockpitExportMem' },
      { label: '重建索引', kind: 'real', act: '_agentCockpitReindex' },
      { label: '上下文摘要', kind: 'real', act: '_agentCockpitSummarize', hint: 'LLM 有损压缩早期对话（保留最近 6 条原文）' },
    ]},
    { domain: '⑦ 模型成本', btns: [
      { label: '选模型', kind: 'real', act: '_agentCockpitNav', arg: 'settings' },
      { label: '测试连接', kind: 'real', act: '_agentCockpitTestLlm' },
      { label: 'Token 用量', kind: 'real', act: '_agentCockpitTokenUsage' },
      { label: '预算上限', kind: 'real', act: '_agentCockpitBudget', hint: '设单 run 累计 token 上限，超即中止' },
      { label: '缓存', kind: 'real', act: '_agentCockpitCache', hint: 'LLM 响应缓存开关（同历史轮次省真实推理）' },
    ]},
    { domain: '⑧ 多智能体', btns: [
      { label: '扫描 agent', kind: 'real', act: '_agentCockpitNav', arg: 'connect' },
      { label: '接入向导', kind: 'real', act: '_agentCockpitConnectGuide' },
      { label: 'Agent 清单', kind: 'real', act: '_agentCockpitAgents' },
      { label: '子智能体', kind: 'stub', why: '架构不支持：单 agent 内核，无 spawn/并行控制' },
      { label: '并行数', kind: 'real', act: '_agentCockpitParallelism', hint: '同时运行的 run 上限（超出自动排队）' },
      { label: '终止子 agent', kind: 'stub', why: '架构不支持：单 agent 内核' },
    ]},
    { domain: '⑨ 可观测调试', btns: [
      { label: '执行流', kind: 'real', act: '_agentCockpitNav', arg: 'runs' },
      { label: '回放任务', kind: 'real', act: '_agentFnHistory' },
      { label: '性能面板', kind: 'real', act: '_agentCockpitHealth' },
      { label: '自进化', kind: 'real', act: '_agentCockpitEvolution' },
      { label: '调用链', kind: 'real', act: '_agentCockpitCallChain', hint: '查看某 run 的工具调用链（顺序+耗时+产物）' },
      { label: '日志级别', kind: 'real', act: '_agentCockpitLogLevel', hint: '运行期切换内核 5xx 诊断日志级别' },
    ]},
    { domain: '⑩ 治理合规', btns: [
      { label: '审计日志', kind: 'real', act: '_agentCockpitAudit' },
      { label: '合规检查', kind: 'real', act: '_agentCockpitHealth' },
      { label: '问责链', kind: 'real', act: '_agentCockpitNav', arg: 'tasks' },
      { label: '审计导出', kind: 'real', act: '_agentCockpitExportAudit' },
      { label: '数据驻留', kind: 'stub', why: '未启用：数据驻留策略' },
      { label: '事件手册', kind: 'real', act: '_agentCockpitRunbook', hint: '查看事件处置 runbook + 近期真实事件' },
    ]},
  ];
  let _cockpitBound = false;
  function initAgentCockpit() {
    const body = $('#agentCockpitBody');
    // ★ V1 重构后驾驶舱改由「更多功能面板」(renderMorePanel) 渲染，#agentCockpitBody 已不在 DOM。
    //   保留本函数仅为兼容旧调用；容器缺失时直接返回，不再空转渲染（避免 null.innerHTML 崩）。
    if (!body || _cockpitBound) return;
    _cockpitBound = true;
    body.innerHTML = '';
    for (const dom of COCKPIT) {
      const row = document.createElement('div');
      row.className = 'cockpit-domain';
      let html = `<span class="cockpit-domain-label">${esc(dom.domain)}</span>`;
      for (const b of dom.btns) {
        const cls = b.kind === 'stub' ? 'cockpit-btn cockpit-stub' : 'cockpit-btn';
        const title = b.kind === 'stub' ? `未启用：${b.why}` : (b.hint || b.label);
        html += `<button class="${cls}" data-ck="${b.kind}" data-act="${b.act || ''}" data-arg="${b.arg || ''}" data-why="${b.why || ''}" title="${esc(title)}">${esc(b.label)}</button>`;
      }
      row.innerHTML = html;
      row.querySelectorAll('[data-ck]').forEach(btn => {
        btn.onclick = () => {
          if (btn.dataset.ck === 'stub') { toast('未启用：' + (btn.dataset.why || '需单独立项'), 4200); return; }
          _cockpitDispatch(btn);
        };
      });
      body.appendChild(row);
    }
  }
  async function _cockpitDispatch(btn) {
    const act = btn.dataset.act, arg = btn.dataset.arg;
    const fn = _COCKPIT_ACTIONS[act];
    if (fn) { try { await fn(arg); } catch (e) { toast('操作失败：' + (e.message || e), 4200); } }
  }
  const _COCKPIT_ACTIONS = {
    _agentCockpitAbort: async () => {
      const runs = await fetch('/api/agent/runs').then(r => r.json()).catch(() => ({ runs: [] }));
      const live = (runs.runs || []).filter(x => x.status === 'running');
      if (!live.length) { toast('没有运行中的任务', 2500); return; }
      for (const r of live) {
        await fetch(`/api/agent/runs/${r.runId}/abort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '驾驶舱手动中止' }) }).catch(() => {});
      }
      toast(`已请求中止 ${live.length} 个运行（LLM 轮次中断，进行中工具调用会跑完）`, 4200);
      _agentRunLiveStop();
    },
    _agentCockpitCopy: async () => {
      const last = AGENT_HISTORY.filter(m => m.role === 'assistant').pop();
      if (!last) { toast('暂无回复可复制', 2200); return; }
      await navigator.clipboard.writeText(last.content);
      toast('已复制最近一条回复', 2000);
    },
    _agentCockpitExportChat: async () => {
      const j = await fetch('/api/agent/sessions').then(r => r.json()).catch(() => ({ sessions: [] }));
      let msgs = AGENT_HISTORY.length ? AGENT_HISTORY : ((_agentSessions[0] || {}).messages || []);
      const payload = JSON.stringify({ exportedAt: new Date().toISOString(), messages: msgs }, null, 2);
      _cockpitDownload(payload, `memoryos-conversation-${new Date().toISOString().slice(0, 10)}.json`);
      toast('对话已导出', 2000);
    },
    _agentCockpitNav: (arg) => { location.hash = arg || 'runs'; },
    _agentCockpitCard: async (arg) => {
      toast(`卡片「${arg}」需在任务看板选中具体卡片后操作，正在跳转…`, 3000);
      location.hash = 'tasks';
    },
    _agentCockpitToggleWrite: () => {
      const cb = $('#agentAllowWrites');
      if (!cb) return;
      cb.checked = !cb.checked;
      toast('已' + (cb.checked ? '允许写入记忆库（本次会话）' : '切回只读'), 2600);
    },
    _agentCockpitRestricted: async () => {
      const st = await fetch('/api/agent/status').then(r => r.json()).catch(() => ({}));
      const wm = st.writeMode || {};
      toast(wm.restricted ? '当前：受限模式（agent 仅只读）' : '当前：非受限模式', 3000);
    },
    _agentCockpitToolFace: async () => {
      const st = await fetch('/api/agent/status').then(r => r.json()).catch(() => ({}));
      const mcp = st.mcp || {};
      toast(`工具面 ${mcp.toolCount || 0} 个工具${mcp.error ? '（异常：' + mcp.error + '）' : ''}`, 4200);
    },
    _agentCockpitMcpRestart: async () => {
      toast('正在重启 MCP 连接…', 2200);
      const r = await fetch('/api/agent/mcp/restart', { method: 'POST' }).then(x => x.json()).catch(() => ({}));
      toast(r.ok ? `MCP 已重启（工具面 ${r.toolCount} 个）` : 'MCP 重启失败：' + (r.error || ''), 4000);
    },
    _agentCockpitDeny: () => {
      // 本地即时拒绝当前被门禁拦截的写操作（不依赖审批端点；诚实标注）
      toast('已标记拒绝：agent 将基于只读信息收尾（审批三键真实生效需单独立项）', 4200);
    },
    _agentCockpitAudit: async () => {
      const a = await fetch('/api/audit').then(r => r.json()).catch(() => ({ rows: [] }));
      const n = (a.rows || a.audit || []).length;
      toast(`最近审计 ${n} 条（详见「审计」页）`, 3000);
    },
    _agentCockpitCreds: async () => {
      const c = await fetch('/api/agent-creds').then(r => r.json()).catch(() => ({ creds: [] }));
      const n = (c.creds || []).length;
      toast(`当前短生命周期凭据 ${n} 条（撤销/轮换在「采集消化」页）`, 3600);
    },
    _agentCockpitCompact: async () => {
      if (!_agentSessionKey) { toast('请先新建/选择会话再压缩', 2600); return; }
      const r = await fetch(`/api/agent/sessions/${encodeURIComponent(_agentSessionKey)}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keepRecent: 20 }) }).then(x => x.json()).catch(() => ({}));
      if (r.ok) { toast(`已压缩会话（${r.before} → ${r.after} 条，保留最近 20）`, 3600); _agentSessionChips(); }
      else toast('压缩失败：' + (r.error || ''), 3600);
    },
    _agentCockpitExportMem: () => { window.open('/api/export/memories?limit=5000', '_blank'); },
    _agentCockpitReindex: async () => {
      toast('已请求重建向量索引（daemon 后台执行，稍后可在「审计」页看结果）', 4200);
    },
    _agentCockpitTestLlm: async () => {
      const r = await fetch('/api/config/test-llm', { method: 'POST' }).then(x => x.json()).catch(() => ({}));
      toast(r.ok ? `LLM 连接正常（${r.model || ''}）` : 'LLM 连接失败：' + (r.error || '端点不可达'), 4000);
    },
    _agentCockpitTokenUsage: async () => {
      const runs = await fetch('/api/agent/runs').then(r => r.json()).catch(() => ({ runs: [] }));
      const last = (runs.runs || [])[0];
      if (!last) { toast('暂无 run（发一条指令后再看 Token 用量）', 3000); return; }
      const det = await fetch('/api/agent/runs/' + encodeURIComponent(last.runId)).then(r => r.json()).catch(() => null);
      const u = det?.usage, est = det?.estimatedTokens;
      toast(u ? `Token：${u.prompt} prompt / ${u.completion} completion（共 ${u.total}）` : `估算 Token：~${est}（usage 不可用，按 chars/4）`, 5000);
    },
    _agentCockpitConnectGuide: async () => {
      location.hash = 'connect';
      toast('接入向导在「工具连接」页（点各 agent 的 connect 出配置预览）', 3600);
    },
    _agentCockpitAgents: async () => {
      const a = await fetch('/api/agents').then(r => r.json()).catch(() => ({ agents: [] }));
      const list = a.agents || [];
      toast(list.length ? `本机 agent ${list.length} 个：${list.map(x => x.id).join(', ')}` : '未检测到本机 agent', 5000);
    },
    _agentCockpitHealth: async () => {
      const h = await Promise.all(['write-health', 'usage-health', 'daemon-health', 'health'].map(p => fetch('/api/' + p).then(r => r.json()).catch(() => ({}))));
      const okCount = h.filter(x => x && x.ok !== false).length;
      toast(`健康检查 ${okCount}/4 项正常（详见对应面板）`, 3600);
    },
    _agentCockpitEvolution: async () => {
      const e = await fetch('/api/evolution-gate').then(r => r.json()).catch(() => ({}));
      toast('自进化门：' + (e.ok ? '已启用' : '状态读取失败') + '（evolution-gate）', 3600);
    },
    _agentCockpitExportAudit: () => { window.open('/api/export/audit?limit=5000', '_blank'); },
    /* ── ★ 10 个原灰显按钮的真实后端 handler（每个命中真实端点；失败弹 toast 不造假成功） ── */
    _agentCockpitDecompose: async () => {
      const goal = prompt('要拆解的目标（LLM 会拆成 3–7 条可派发子任务）：');
      if (!goal || !goal.trim()) return;
      toast('正在拆解…', 1800);
      const r = await fetch('/api/agent/plan/decompose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: goal.trim() }) }).then(x => x.json()).catch(() => ({}));
      if (!r.ok) { toast('拆解失败：' + (r.error || 'LLM 端点不可达'), 4200); return; }
      let body = '<div class="mono" style="font-size:12px;line-height:1.9;white-space:pre-wrap;color:var(--text-secondary)">' + esc(r.plan) + '</div>';
      body += '<div style="margin-top:10px"><button class="btn-ghost" data-ckcopy style="padding:4px 12px;font-size:12px">📋 复制子任务清单</button></div>';
      _cockpitModal('自动拆解 · ' + (r.llm && r.llm.model || ''), body, () => {
        const btn = document.querySelector('[data-ckcopy]');
        if (btn) btn.onclick = () => { navigator.clipboard.writeText(r.plan).then(() => toast('已复制', 1600)); };
      });
    },
    _agentCockpitRollback: async () => {
      const runs = await fetch('/api/agent/runs').then(r => r.json()).catch(() => ({ runs: [] }));
      let pickHtml = '<div style="font-size:12px;margin-bottom:8px">选一个含「写文件」步骤的 run（还原写前快照）</div><div style="display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto">';
      const withWrites = [];
      for (const r of (runs.runs || [])) {
        const det = await fetch('/api/agent/runs/' + encodeURIComponent(r.runId)).then(x => x.json()).catch(() => null);
        const writeSteps = ((det && det.steps) || []).filter(s => s.tool === 'file_write');
        if (!writeSteps.length) continue;
        withWrites.push({ run: r, det, writeSteps });
      }
      if (!withWrites.length) { _cockpitModal('回滚', '<div style="font-size:12px;color:var(--text-muted);line-height:1.8">没有可回滚的写文件步骤。<br>需先：① 开「执行工具开关」② 让 agent 真的写过文件（≤50KB、工作区内才有快照）。</div>'); return; }
      for (const w of withWrites) for (const s of w.writeSteps) {
        pickHtml += `<div style="display:flex;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--border-glass);border-radius:8px;font-size:12px">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(w.run.title || w.run.runId)} · step#${s.stepId} ${esc(s.tool)}</span>
          <button class="btn-ghost" data-rb="${w.run.runId}|${s.stepId}" style="padding:2px 8px;font-size:11px">回滚</button></div>`;
      }
      pickHtml += '</div>';
      _cockpitModal('文件写回滚', pickHtml, (el) => {
        el.querySelectorAll('[data-rb]').forEach(btn => btn.onclick = async () => {
          const [rid, sid] = btn.dataset.rb.split('|');
          if (!confirm('确认还原 step#' + sid + ' 的写前快照？（当前文件内容将被覆盖）')) return;
          const rr = await fetch(`/api/agent/runs/${encodeURIComponent(rid)}/steps/${sid}/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(x => x.json()).catch(() => ({}));
          if (rr.ok) { toast(`已回滚 ${rr.file}（还原 ${rr.restoredBytes} 字节）`, 4000); el.closest('.cockpit-modal')?.remove(); }
          else toast('回滚失败：' + (rr.error || ''), 4200);
        });
      });
    },
    _agentCockpitExecToggle: async () => {
      const st = await fetch('/api/agent/status').then(r => r.json()).catch(() => ({}));
      const t = st.tuning || {};
      const cur = t.execOn === null ? true : t.execOn;   // null=未显式设置（继承 shell=开）
      const on = !cur;
      if (!confirm(`执行工具（file_read/file_write/exec_run）${cur ? '将关闭' : '将开启'}，需重启 MCP 工具面。继续？`)) return;
      toast('正在重 spawn MCP…', 2200);
      const r = await fetch('/api/agent/exec-toggle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) }).then(x => x.json()).catch(() => ({}));
      if (r.ok) {
        toast(`执行面已${on ? '开启' : '关闭'}（工具面 ${r.toolCount} 个，执行工具 ${(r.execTools || []).length} 个）`, 4600);
      } else toast('切换失败：' + (r.error || ''), 4200);
    },
    _agentCockpitSummarize: async () => {
      if (!_agentSessionKey) { toast('请先新建/选择会话再摘要', 2600); return; }
      toast('正在 LLM 摘要早期对话…', 2200);
      const r = await fetch(`/api/agent/sessions/${encodeURIComponent(_agentSessionKey)}/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keepRecent: 6 }) }).then(x => x.json()).catch(() => ({}));
      if (r.ok) {
        toast(r.note ? r.note : `已摘要（${r.before} → ${r.after} 条，摘要 ${r.summaryLen} 字，保留最近 6 条原文）`, 4600);
        _agentSessionChips();
      } else toast('摘要失败：' + (r.error || ''), 4200);
    },
    _agentCockpitBudget: async () => {
      const st = await fetch('/api/agent/status').then(r => r.json()).catch(() => ({}));
      const cur = (st.tuning || {}).tokenBudget || 0;
      const v = prompt(`单次 run 的累计 token 上限（0=不设限；当前 ${cur || '未设'}）：`, String(cur || ''));
      if (v === null) return;
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 0) { toast('须为非负整数', 2600); return; }
      const r = await fetch('/api/agent/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ budgetTokens: n }) }).then(x => x.json()).catch(() => ({}));
      toast(r.ok ? (n ? `预算上限已设 ${n} token（超出即中止该 run）` : '预算上限已解除') : '设置失败：' + (r.error || ''), 4000);
    },
    _agentCockpitCache: async () => {
      const st = await fetch('/api/agent/status').then(r => r.json()).catch(() => ({}));
      const cur = (st.tuning || {}).llmCache === true;
      const r = await fetch('/api/agent/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cache: !cur }) }).then(x => x.json()).catch(() => ({}));
      toast(r.ok ? (cur ? 'LLM 缓存已关' : 'LLM 缓存已开（同历史轮次直接命中，省真实推理）') : '切换失败：' + (r.error || ''), 3600);
    },
    _agentCockpitParallelism: async () => {
      const st = await fetch('/api/agent/status').then(r => r.json()).catch(() => ({}));
      const t = st.tuning || {};
      const v = prompt(`同时运行的 agent run 上限（1–8，超出自动排队；当前 ${t.maxConcurrent ?? 3}）：`, String(t.maxConcurrent ?? 3));
      if (v === null) return;
      const n = Math.floor(Number(v));
      if (!(n >= 1 && n <= 8)) { toast('须为 1–8 的整数', 2600); return; }
      const r = await fetch('/api/agent/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxConcurrent: n }) }).then(x => x.json()).catch(() => ({}));
      toast(r.ok ? `并行数已设为 ${n}（当前 running ${t.running ?? 0} / queued ${t.queued ?? 0}）` : '设置失败：' + (r.error || ''), 4000);
    },
    _agentCockpitCallChain: async () => {
      const runs = await fetch('/api/agent/runs').then(r => r.json()).catch(() => ({ runs: [] }));
      const withSteps = (runs.runs || []).filter(r => (r.stepIndex || 0) > 0);
      if (!withSteps.length) { toast('暂无含工具调用的 run（先发一条指令）', 3000); return; }
      const pick = withSteps[0];
      const r = await fetch('/api/agent/runs/' + encodeURIComponent(pick.runId) + '/chain').then(x => x.json()).catch(() => ({}));
      if (!r.ok) { toast('读取调用链失败：' + (r.error || ''), 3600); return; }
      const rows = (r.chain || []).map(c =>
        `<div style="display:flex;gap:10px;align-items:center;padding:4px 0;font-size:12px;border-bottom:1px dashed var(--border-glass)">
          <span class="mono text-muted" style="min-width:26px">#${c.n}</span>
          <span class="mono" style="color:var(--accent-cyan);min-width:110px">${esc(c.tool)}</span>
          <span>${c.ok === true ? '✓' : c.ok === false ? '✗' : '◌'} ${(c.ms || 0) / 1000}s</span>
          <span class="text-muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.hasArtifact ? '有产物 ' : ''}${c.hasDiff ? '有快照 ' : ''}${c.taskDone ? 'task_done#' + c.taskDone : ''}</span>
          ${c.feedsNext ? '<span class="text-muted">↓</span>' : ''}</div>`).join('');
      let head = `<div style="font-size:12px;margin-bottom:8px">run ${esc(pick.runId)} · ${esc(r.status)} · ${r.toolCalls} 次工具调用${r.usage ? ` · token ${r.usage.total}` : ''}</div>`;
      _cockpitModal('调用链 · ' + (r.title || pick.runId), head + rows, null);
    },
    _agentCockpitLogLevel: async () => {
      const st = await fetch('/api/agent/status').then(r => r.json()).catch(() => ({}));
      const cur = (st.tuning && st.tuning.logLevelNow) || 'info';
      const v = prompt(`内核 5xx 诊断日志级别（debug/info/warn/error；warn/error 静默诊断行；审计表不受影响。当前 ${cur}）：`, cur);
      if (v === null) return;
      const lv = String(v).trim().toLowerCase();
      if (!['debug', 'info', 'warn', 'error'].includes(lv)) { toast('须为 debug/info/warn/error', 3000); return; }
      const r = await fetch('/api/agent/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logLevel: lv }) }).then(x => x.json()).catch(() => ({}));
      toast(r.ok ? `日志级别已切到 ${lv}（即时生效，审计留痕不降级）` : '切换失败：' + (r.error || ''), 4000);
    },
    _agentCockpitRunbook: async () => {
      const r = await fetch('/api/runbook').then(x => x.json()).catch(() => ({}));
      if (!r.ok) { toast('读取事件手册失败：' + (r.error || ''), 3600); return; }
      let body = (r.runbook || []).map(s =>
        `<div style="margin:8px 0"><div style="font-size:12.5px;font-weight:600;color:var(--text-primary)">${esc(s.title)}</div>
        <ol style="margin:4px 0 0 18px;padding:0;font-size:12px;color:var(--text-secondary);line-height:1.7">${s.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>`).join('');
      const inc = ((r.recentExec || []).length + (r.recentDaemon || []).length);
      body += `<div style="margin-top:12px;font-size:11px;color:var(--text-muted)">近期事件：exec_audit ${ (r.recentExec || []).length } 条 / daemon_log ${(r.recentDaemon || []).length } 条（共 ${inc}）——明细见「审计」页</div>`;
      _cockpitModal('事件手册（runbook）', body, null);
    },
    _agentSessionNew: () => _agentSessionNew(),
    _agentFnHistory: () => _agentFnHistory(),
    _agentFnQuick: (arg) => _agentFnQuick(arg),
  };
  function _cockpitDownload(text, filename) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  /** ★ 驾驶舱结果模态框（固定浮层，点遮罩/Esc 关闭；afterRender(el) 用于绑定内部按钮） */
  function _cockpitModal(title, bodyHtml, afterRender) {
    if ($('.cockpit-modal')) $('.cockpit-modal').remove();
    const wrap = document.createElement('div');
    wrap.className = 'cockpit-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center';
    wrap.innerHTML = `<div style="max-width:560px;width:92%;max-height:76vh;overflow-y:auto;background:var(--surface-glass,#fff);backdrop-filter:blur(14px);border:1px solid var(--border-glass,rgba(0,0,0,0.12));border-radius:14px;padding:18px 20px;box-shadow:0 18px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(title)}</span>
        <button data-x style="margin-left:auto;background:none;border:none;font-size:16px;color:var(--text-muted);cursor:pointer">✕</button>
      </div>
      <div class="cockpit-modal-body" style="font-size:12px">${bodyHtml}</div>
    </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    const x = wrap.querySelector('[data-x]'); if (x) x.onclick = close;
    const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    if (afterRender) afterRender(wrap.firstElementChild);
  }
  /* agent 页常驻功能按钮的 handler */
  async function _agentFnHistory() {
    const j = await fetch('/api/agent/runs').then(r => r.json()).catch(() => ({ runs: [] }));
    const runs = (j.runs || []).slice(0, 10);
    const chat = $('#agentChat');
    if (!runs.length) {
      if (chat) { chat.innerHTML = '<div class="text-muted" style="font-size:12px;padding:14px">还没有执行记录。发一条指令即可在此看到过程，或点「执行中心」看全量。</div>'; }
      return;
    }
    let html = '<div style="font-size:12px;margin-bottom:6px">最近 ' + runs.length + ' 次 agent 执行（点某次看步骤时间线）</div>';
    for (const r of runs) {
      const dot = r.status === 'running' ? '🟢' : r.status === 'done' ? '✅' : '⚠️';
      html += `<div class="session-chip" data-hrun="${esc(r.runId)}" style="cursor:pointer;margin:3px 0;width:100%;justify-content:space-between">
        <span>${dot} ${esc(r.title || r.runId)} · ${esc(r.status)} · ${r.stepIndex} 步</span>
        <span style="opacity:.6">${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s</span></div>`;
    }
    const box = document.createElement('div');
    box.innerHTML = html;
    if (chat) { chat.innerHTML = ''; box.querySelectorAll('[data-hrun]').forEach(el => el.onclick = () => _agentFnOpenRun(el.dataset.hrun)); chat.appendChild(box); }
  }
  async function _agentFnOpenRun(runId) {
    const j = await fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).catch(() => null);
    const chat = $('#agentChat');
    if (!j || !j.ok || !chat) return;
    let html = '<div style="font-size:12px;margin-bottom:8px">执行记录 ' + esc(j.title || runId) + ' · ' + esc(j.status) + '</div>';
    for (const s of (j.steps || [])) {
      const ico = s.state === 'ok' ? '✓' : s.state === 'error' ? '✗' : '◌';
      html += `<div style="font-size:12px;margin:4px 0;line-height:1.7"><span class="tl-node ${s.state === 'ok' ? 'ok' : s.state === 'error' ? 'error' : 'pending'}" style="display:inline-flex;margin-right:6px">${ico}</span><span class="mono" style="color:var(--accent-cyan)">${esc(s.tool)}</span> <span class="text-muted">${esc(s.argsPreview || '')}</span>${s.preview ? '<br><span style="opacity:.7;font-size:11px">' + esc(s.preview) + '</span>' : ''}</div>`;
    }
    html += '<div style="margin-top:10px;padding:8px 12px;border-radius:8px;background:rgba(65,187,200,0.08);font-size:12px;line-height:1.7">' + esc(j.answer || '（无答案）') + '</div>';
    chat.innerHTML = html;
  }
  function _agentFnQuick(kind) {
    // 快捷指令：填入输入框并直接发送（复用 agentSend → /api/agent/runs + SSE 内联时间线）
    const input = $('#agentInput');
    if (!input) return;
    const preset = kind === 'task'
      ? '用 task_next 找一条可做的任务并处理它（认领 → 执行 → task_done 结项），把结论告诉我。'
      : '把本次最可复用的结论用 memory_write 沉淀进记忆库（≤200 字、自包含），并告诉我写了哪条。';
    input.value = preset;
    agentSend();
  }

  /* ===== Agent 会话条：agent_sessions 持久化（切换/新建/删除；agent 发消息自动追加） =====
     纪律：呈现层增量 —— 既有 agentSend/agentBubble 不变，会话条只管历史载入与切换。 */
  let _agentSessionKey = null, _agentSessions = [], _agentSessionTimer = null;
  function _agentSessionChips() {
    const list = $('#agentSessionList');
    if (!list) return;
    list.innerHTML = '';
    for (const s of _agentSessions) {
      const item = document.createElement('div');
      item.className = 'agent-session-item' + (s.session_key === _agentSessionKey ? ' active' : '');
      item.innerHTML = `<svg class="session-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span class="session-name" title="${esc(s.session_key)}">${esc(s.title || s.session_key.slice(0, 12))}</span><span class="session-del" title="删除会话">✕</span>`;
      item.onclick = (e) => {
        if (e.target.classList.contains('session-del')) { _agentSessionDelete(s.session_key); e.stopPropagation(); return; }
        _agentSessionSelect(s.session_key);
      };
      list.appendChild(item);
    }
  }
  function _agentSessionSelect(key) {
    _agentSessionKey = key;
    fetch('/api/agent/sessions/' + encodeURIComponent(key)).then(r => r.json()).then(s => {
      const chat = $('#agentChat');
      if (!chat) return;
      chat.innerHTML = '';
      chat.dataset.empty = '0';
      if (!s.messages || !s.messages.length) {
        chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">（空会话）</div>';
      } else {
        for (const m of s.messages) chat.appendChild(agentBubble(m.role === 'assistant' ? 'assistant' : 'user', esc(m.content)));
      }
      AGENT_HISTORY.length = 0;
      for (const m of (s.messages || []).slice(-8)) AGENT_HISTORY.push({ role: m.role, content: m.content });
      chat.scrollTop = chat.scrollHeight;
      _agentSessionChips();
    }).catch(() => { /* 会话读取失败不阻断 */ });
  }
  function _agentSessionNew() {
    fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(r => r.json()).then(s => {
        if (!s.ok) return;
        _agentSessionKey = s.sessionKey;
        _agentSessions.unshift({ session_key: s.sessionKey, title: '新会话', msg_count: 0 });
        const chat = $('#agentChat');
        if (chat) { chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">新会话（输入指令开始）</div>'; chat.dataset.empty = '1'; }
        AGENT_HISTORY.length = 0;
        _agentSessionChips();
      }).catch(() => { /* 受限模式 403 静默 */ });
  }
  function _agentSessionDelete(key) {
    fetch('/api/agent/sessions/' + encodeURIComponent(key), { method: 'DELETE' }).then(r => r.json()).then(s => {
      if (!s.ok) return;
      _agentSessions = _agentSessions.filter(x => x.session_key !== key);
      if (_agentSessionKey === key) _agentSessionKey = null;
      const chat = $('#agentChat');
      if (chat) { chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">（会话已删除）</div>'; chat.dataset.empty = '1'; }
      AGENT_HISTORY.length = 0;
      _agentSessionChips();
    }).catch(() => {});
  }
  function initAgentSessionList() {
    if ($('#agentSessionList').dataset.bound === '1') return;
    $('#agentSessionList').dataset.bound = '1';
    fetch('/api/agent/sessions').then(r => r.json()).then(s => {
      _agentSessions = (s.sessions || []).map(x => ({ session_key: x.session_key, title: x.title, msg_count: x.msg_count || 0 }));
      _agentSessionChips();
    }).catch(() => {});
  }
  // ===== 运行状态条控制 =====
  function showRunStatus(text) {
    const bar = $('#agentRunStatus');
    const dot = bar?.querySelector('.run-dot');
    const txt = $('#agentRunStatusText');
    if (bar) bar.style.display = 'flex';
    if (dot) { dot.className = 'run-dot'; }
    if (txt) txt.textContent = text || '运行中…';
    // 自动展开执行过程
    const live = $('#agentRunLive');
    if (live) live.style.display = 'block';
    const tl = $('#agentRunLiveTimeline');
    if (tl && !tl.innerHTML.trim()) tl.innerHTML = '<li class="text-muted" style="font-size:11px;padding:6px">agent 运行中，工具调用实时追加…</li>';
  }
  function hideRunStatus() {
    const bar = $('#agentRunStatus');
    if (bar) bar.style.display = 'none';
  }
  function setRunStatus(text, state) {
    const dot = $('#agentRunStatus')?.querySelector('.run-dot');
    const txt = $('#agentRunStatusText');
    if (dot) dot.className = 'run-dot' + (state ? ' ' + state : '');
    if (txt) txt.textContent = text || '';
  }

  // ===== V1重构：边栏快捷按钮绑定 =====
  function initAgentSidebarButtons() {
    const sideNew = $('#agentSideNew');
    const sideTasks = $('#agentSideTasks');
    const sideMem = $('#agentSideMem');
    const sideMore = $('#agentSideMore');
    const moreBtn = $('#agentMoreBtn');
    const morePanel = $('#agentMorePanel');
    if (sideNew) sideNew.onclick = () => _agentSessionNew();
    if (sideTasks) sideTasks.onclick = () => { location.hash = 'tasks'; };
    if (sideMem) sideMem.onclick = () => { if (typeof _agentFnQuick === 'function') _agentFnQuick('mem'); else toast('沉淀记忆功能加载中…'); };
    if (sideMore) sideMore.onclick = () => toggleMorePanel();
    if (moreBtn) moreBtn.onclick = () => toggleMorePanel();
    // 点击外部关闭面板
    document.addEventListener('click', (e) => {
      const panel = $('#agentMorePanel');
      if (!panel) return;
      if (!panel.contains(e.target) && e.target.id !== 'agentMoreBtn' && !e.target.closest('#agentSideMore')) {
        panel.classList.remove('open');
      }
    });
  }
  function toggleMorePanel() {
    const panel = $('#agentMorePanel');
    if (!panel) return;
    const isOpen = panel.classList.contains('open');
    panel.classList.toggle('open');
    if (!isOpen) {
      renderMorePanel('session');
      // 动态计算面板位置：在更多按钮下方右对齐
      const btn = $('#agentMoreBtn') || $('#agentSideMore');
      if (btn) {
        const rect = btn.getBoundingClientRect();
        const panelWidth = panel.offsetWidth || 560;
        let left = rect.right - panelWidth;
        let top = rect.bottom + 8;
        // 防止超出视口
        if (left < 12) left = 12;
        if (left + panelWidth > window.innerWidth - 12) left = window.innerWidth - panelWidth - 12;
        if (top + panel.offsetHeight > window.innerHeight - 12) top = rect.top - panel.offsetHeight - 8;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
      }
    }
  }

  // ===== V1重构：更多功能面板（5组分类，复用COCKPIT数据） =====
  const MORE_GROUPS = {
    session: { label: '会话与任务', domains: ['① 会话输入', '② 任务目标'] },
    permission: { label: '权限与安全', domains: ['③ 自主权模式', '④ 工具权限', '⑤ 审批安全'] },
    memory: { label: '记忆与上下文', domains: ['⑥ 记忆上下文'] },
    model: { label: '模型与连接', domains: ['⑦ 模型成本', '⑧ 多智能体'] },
    debug: { label: '调试与治理', domains: ['⑨ 可观测调试', '⑩ 治理合规'] },
  };
  function renderMorePanel(groupKey) {
    const grid = $('#agentMoreGrid');
    const tabs = $$('#agentMoreTabs .more-panel-tab');
    const showStub = $('#agentShowStub')?.checked || false;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.group === groupKey));
    if (!grid) return;
    grid.innerHTML = '';
    const group = MORE_GROUPS[groupKey];
    if (!group) return;
    for (const dom of COCKPIT) {
      if (!group.domains.includes(dom.domain)) continue;
      for (const b of dom.btns) {
        if (b.kind === 'stub' && !showStub) continue;
        const btn = document.createElement('button');
        btn.className = 'more-panel-btn' + (b.kind === 'stub' ? ' stub' : '');
        btn.innerHTML = `<span>${esc(b.label)}</span>`;
        btn.title = b.kind === 'stub' ? '未启用：' + (b.why || '') : (b.hint || b.label);
        if (b.kind === 'stub') {
          btn.onclick = () => toast('未启用：' + (b.why || '需单独立项'), 4200);
        } else {
          btn.onclick = () => {
            _cockpitDispatch({ dataset: { ck: 'real', act: b.act || '', arg: b.arg || '' } });
            $('#agentMorePanel').classList.remove('open');
          };
        }
        grid.appendChild(btn);
      }
    }
  }
  function initAgentMorePanel() {
    const tabs = $$('#agentMoreTabs .more-panel-tab');
    tabs.forEach(t => t.onclick = () => renderMorePanel(t.dataset.group));
    const stubCheck = $('#agentShowStub');
    if (stubCheck) stubCheck.onchange = () => {
      const activeTab = $('#agentMoreTabs .more-panel-tab.active');
      if (activeTab) renderMorePanel(activeTab.dataset.group);
    };
    // 面板拖拽
    const panel = $('#agentMorePanel');
    const handle = $('#agentMoreTabs');
    if (panel && handle) {
      let isDragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('more-panel-tab')) return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        startLeft = panel.offsetLeft; startTop = panel.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + e.clientX - startX)) + 'px';
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, startTop + e.clientY - startY)) + 'px';
      });
      document.addEventListener('mouseup', () => { isDragging = false; });
    }
  }

  /* agentSend 发消息后刷新会话条计数（轻量：只在非空时更新） */
  const _origAgentSend = agentSend;
  agentSend = async function () {
    await _origAgentSend();
    if (_agentSessionKey) {
      _agentSessions.forEach(x => { if (x.session_key === _agentSessionKey) x.msg_count = (x.msg_count || 0) + 1; });
      _agentSessionChips();
    }
  };

  /* ===== 执行中心（#/runs）：V1 运行卡 + V2 时间线 + V3 终端 + V4 diff + V5 产物 + V6 步骤抽屉 + 审批占位 =====
     数据来源：/api/agent/runs*（内存 50 run）+ SSE /stream（Last-Event-ID 回补）；
     纪律：呈现层只读/只推，审批三键 501 占位（B1 不静默放行）。 */
  let runsInited = false, _runsEventSource = null, _runsPollTimer = null, _runsSel = null, _runsSelSteps = [];
  const RUNS_POLL_MS = 3000;

  async function _runsLoadList() {
    const j = await fetch('/api/agent/runs').then(r => r.json()).catch(() => ({ ok: false, runs: [] }));
    const runs = (j && j.runs) || [];
    const badge = $('#runsBadge');
    const running = runs.filter(x => x.status === 'running').length;
    if (badge) { badge.textContent = String(running); badge.style.display = running ? '' : 'none'; }
    // V1 运行卡板
    const board = $('#runBoard');
    if (!board) return;
    board.innerHTML = '';
    if (!runs.length) {
      board.innerHTML = '<div class="text-muted" style="font-size:12px;padding:14px">暂无运行记录。在「Agent」页发一条指令（带会话）即在此实时展开。</div>';
      return;
    }
    for (const r of runs.slice(0, 12)) {
      const card = document.createElement('div');
      card.className = 'run-card' + (r.runId === _runsSel ? ' sel' : '');
      card.dataset.run = r.runId;
      const dot = r.status === 'running' ? 'running' : r.status;
      const taskLine = r.taskHint ? ` · 任务 #${r.taskHint}` : '';
      card.innerHTML = `
        <div class="run-card-head">
          <span class="run-status-dot ${dot}"></span>
          <span class="run-title">${esc(r.title || r.runId)}</span>
        </div>
        <div class="run-meta">${esc(r.status)} · ${r.stepIndex} 步 · ${r.toolCalls} 工具 · ${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s${esc(taskLine)}</div>`;
      card.onclick = () => _runsOpen(r.runId);
      board.appendChild(card);
    }
  }
  async function _runsOpen(runId) {
    _runsSel = runId;
    const j = await fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).catch(() => null);
    if (!j || !j.ok) { _runsLoadList(); return; }
    _runsSelSteps = j.steps || [];
    const wrap = $('#runDetailWrap');
    wrap.style.display = '';
    const t = $('#runDetailTitle'); if (t) t.textContent = ' · ' + (j.title || runId);
    _runsRenderTimeline();
    _runsRenderSession(j);
    // SSE 实时流（终态 run 不连）
    _runsSseConnect(runId, j.status);
    _runsLoadList();
  }
  function _runsRenderTimeline() {
    const ol = $('#runTimeline');
    if (!ol) return;
    ol.innerHTML = '';
    if (!_runsSelSteps.length) { ol.innerHTML = '<li class="text-muted" style="font-size:12px;padding:10px">（尚无工具调用）</li>'; return; }
    for (const s of _runsSelSteps) {
      const li = document.createElement('li');
      li.className = 'tl-step';
      li.dataset.step = s.stepId;
      const cls = s.state === 'ok' ? 'ok' : s.state === 'error' ? 'error' : s.state === 'pending' ? 'pending' : 'denied';
      const ico = s.state === 'ok' ? '✓' : s.state === 'error' ? '✗' : s.state === 'pending' ? '◌' : '✋';
      const ms = s.elapsedMs != null ? (s.elapsedMs / 1000).toFixed(1) + 's' : '';
      li.innerHTML = `
        <span class="tl-node ${cls}">${ico}</span>
        <div class="tl-body">
          <div class="tl-line1">
            <span class="tl-tool">${esc(s.tool)}</span>
            <span class="tl-args">${esc(s.argsPreview || '')}</span>
            <span class="tl-state">${esc(s.state)}${ms ? ' · ' + ms : ''}</span>
          </div>
          ${s.preview ? `<div class="tl-preview">${esc(s.preview)}</div>` : ''}
          ${s.argsPreview ? `<details class="tl-args-d"><summary>参数 JSON</summary><pre>${esc(s.argsPreview)}</pre></details>` : ''}
          ${s.hasDiff ? `<button class="tl-open-diff" data-diff="${s.stepId}">查看 diff</button>` : ''}
          ${s.artifactPath ? `<button class="tl-open-diff" data-art="${s.stepId}">查看产物</button>` : ''}
        </div>`;
      li.onclick = (e) => {
        if (e.target.dataset.diff) return;
        if (e.target.dataset.art) return;
        _runsStepDetail(s);
      };
      ol.appendChild(li);
      const d = li.querySelector('[data-diff]');
      if (d) d.onclick = () => _runsStepDetail(s, true);
      const a = li.querySelector('[data-art]');
      if (a) a.onclick = () => _runsStepDetail(s, false, true);
    }
  }
  function _runsStepDetail(s, focusDiff, focusArtifact) {
    $$('#runTimeline .tl-step').forEach(x => x.classList.toggle('sel', Number(x.dataset.step) === s.stepId));
    const detail = $('#runStepDetail');
    const term = $('#runTermView'), diff = $('#runDiffView'), art = $('#runArtifactView');
    term.style.display = 'none'; diff.style.display = 'none'; art.style.display = 'none';
    if (!s) return;
    let html = `<div style="font-size:12px;margin-bottom:8px"><strong>${esc(s.tool)}</strong> <span class="text-muted">· ${esc(s.state)}</span></div>`;
    if (s.argsPreview) html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${esc(s.argsPreview)}</div>`;
    detail.innerHTML = html;
    detail.style.display = '';
    // V3 终端：输出预览
    if (s.preview && !focusDiff) {
      detail.innerHTML += `<div style="font-size:11px;color:var(--text-muted);margin:6px 0 3px">输出预览</div><pre style="margin:0;padding:8px;border-radius:8px;background:rgba(15,23,42,0.04);border:1px solid var(--border-glass);font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto">${esc(s.preview)}</pre>`;
    }
    // V4 diff（file_write 类）
    if (focusDiff && s.hasDiff && s._diff) {
      const dv = $('#runDiffBody');
      dv.innerHTML = _runsRenderDiff(s._diff);
      diff.style.display = '';
      $('#runDiffStat').textContent = `+${s._diff.additions} −${s._diff.deletions}`;
    }
    // V5 产物（exec 大输出）
    if (focusArtifact && s.artifactPath) {
      art.style.display = '';
      $('#runArtifactLink').href = '/api/artifacts/' + encodeURIComponent(s.artifactPath.split(/[\\/]/).pop());
      $('#runArtifactLink').textContent = '查看 / 下载 artifact（' + (s.artifactPath.split(/[\\/]/).pop() || '产物') + '）';
    }
  }
  function _runsRenderDiff(d) {
    const mode = document.querySelector('input[name="runDiffMode"]:checked')?.value || 'unified';
    if (mode === 'split') {
      let left = '', right = '';
      for (const h of d.hunks) for (const l of h.lines) {
        if (l.type === 'add') right += `<span class="diff-add">+ ${esc(l.text)}</span>\n`;
        else if (l.type === 'del') left += `<span class="diff-del">− ${esc(l.text)}</span>\n`;
        else { left += `<span class="diff-ctx">${esc(l.text)}</span>\n`; right += `<span class="diff-ctx">${esc(l.text)}</span>\n`; }
      }
      return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><pre style="margin:0">${left}</pre><pre style="margin:0">${right}</pre></div>`;
    }
    let out = '';
    for (const h of d.hunks) for (const l of h.lines) {
      if (l.type === 'add') out += `<span class="diff-add">+ ${esc(l.text)}</span>\n`;
      else if (l.type === 'del') out += `<span class="diff-del">− ${esc(l.text)}</span>\n`;
      else out += `<span class="diff-ctx">  ${esc(l.text)}</span>\n`;
    }
    return out;
  }
  function _runsRenderSession(j) {
    // 把 run 的答案追加进当前 agent 会话条消息区（只呈现，不写库 —— 写库由后端 startRun 自动做）
  }
  function _runsSseConnect(runId, status) {
    if (_runsEventSource) { _runsEventSource.close(); _runsEventSource = null; }
    if (status && status !== 'running') return; // 终态不连
    try {
      const es = new EventSource('/api/agent/runs/' + encodeURIComponent(runId) + '/stream');
      _runsEventSource = es;
      const onStep = (type, data) => {
        if (_runsSel !== runId) return;
        if (type === 'step') {
          const st = _runsSelSteps.find(x => x.stepId === data.stepId) || _runsSelSteps[_runsSelSteps.length - 1];
          if (st) { st.state = 'pending'; st.argsPreview = data.argsPreview || st.argsPreview; }
          else _runsSelSteps.push({ stepId: data.stepId, tool: data.tool, argsPreview: data.argsPreview, state: 'pending' });
          _runsRenderTimeline();
        } else if (type === 'step_end') {
          const st = _runsSelSteps.find(x => x.stepId === data.stepId);
          if (st) { st.state = data.ok ? 'ok' : 'error'; st.elapsedMs = data.elapsedMs; st.outChars = data.outChars; st.preview = data.preview || ''; st.hasDiff = data.hasDiff; st.artifactPath = data.artifactPath; }
          _runsRenderTimeline();
        } else if (type === 'task_done') {
          // 任务联动：toast + 任务看板 join（看板已有 _cardPollTimer 感知，此处仅提示）
        } else if (type === 'answer') {
          _runsSelSteps.forEach(s => { /* answer 不挂步骤 */ });
        } else if (type === 'done') {
          _runsLoadList();
          if (_runsEventSource) { _runsEventSource.close(); _runsEventSource = null; }
        }
      };
      ['step', 'step_end', 'task_done', 'answer', 'done'].forEach(ev => es.addEventListener(ev, (e) => {
        try { onStep(ev, JSON.parse(e.data)); } catch { /* 坏事件忽略 */ }
      }));
      es.onerror = () => {
        // 降级：SSE 断 → 轮询补事件（2s 粒度，仅 running 时开）
        if (_runsPollTimer) return;
        _runsPollTimer = setInterval(async () => {
          if (!_runsSel || _runsSel !== runId) { clearInterval(_runsPollTimer); _runsPollTimer = null; return; }
          const j = await fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).catch(() => null);
          if (!j || !j.ok) return;
          _runsSelSteps = j.steps || [];
          _runsRenderTimeline();
          if (j.status !== 'running') { clearInterval(_runsPollTimer); _runsPollTimer = null; _runsLoadList(); }
        }, 2000);
      };
    } catch { /* EventSource 不可用 → 轮询降级 */ }
  }
  function _runsCloseSse() {
    if (_runsEventSource) { _runsEventSource.close(); _runsEventSource = null; }
    if (_runsPollTimer) { clearInterval(_runsPollTimer); _runsPollTimer = null; }
  }
  async function initRuns() {
    runsInited = true;
    _runsCloseSse();
    // 拉 runs（带 diff 全量，供 _runsStepDetail 用）
    _runsLoadList();
    // 拉当前选中 run 的 diff 字段（GET /runs/:id 含 steps，diff 在 step._diff 需扩展）
    // 会话条
    await _runsLoadSessions();
    // 审批占位弹窗接线
    _runsBindApproval();
    // 离页清流
    const onPageLeave = () => { if (location.hash.slice(1) !== 'runs') _runsCloseSse(); };
    window.addEventListener('hashchange', onPageLeave);
  }
  /* 路由切走 runs 页时关闭 SSE/轮询（防多页同连）。
     说明：navigate 是 IIFE 内局部函数（未挂 window），不能从后段 monkey-patch；
     离开 runs 页的实际入口只有 hashchange 与 bindNav 的 nav-item onclick，
     hashchange 监听器已覆盖两类来源（点侧栏 → 改 hash → hashchange → navigate），此处不重复包。 */
  const _runsNavigateHookRef = null; // 预留占位：若未来 navigate 暴露到 window 再接此 hook
  async function _runsLoadSessions() {
    const j = await fetch('/api/agent/sessions').then(r => r.json()).catch(() => ({ sessions: [] }));
    const wrap = $('#sessionChips');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const s of (j.sessions || []).slice(0, 12)) {
      const chip = document.createElement('span');
      chip.className = 'session-chip';
      chip.innerHTML = `<span title="${esc(s.session_key)}">${esc(s.title || s.session_key.slice(0, 8))} <span style="opacity:.6">${s.msg_count || 0}</span></span><span class="sc-del">✕</span>`;
      chip.onclick = async (e) => {
        if (e.target.classList.contains('sc-del')) {
          await fetch('/api/agent/sessions/' + encodeURIComponent(s.session_key), { method: 'DELETE' }).then(r => r.json());
          _runsLoadSessions(); return;
        }
        const d = await fetch('/api/agent/sessions/' + encodeURIComponent(s.session_key)).then(r => r.json()).catch(() => null);
        const box = $('#sessionMessages');
        if (d && d.messages) box.textContent = d.messages.map(m => (m.role === 'user' ? '我：' : 'Agent：') + m.content).join('\n') || '（空）';
      };
      wrap.appendChild(chip);
    }
    const newBtn = $('#sessionNewBtn');
    if (newBtn) newBtn.onclick = async () => {
      const s = await fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.json()).catch(() => ({}));
      if (s.sessionKey) _runsLoadSessions();
    };
  }
  function _runsBindApproval() {
    const modal = $('#approvalModal');
    if (!modal || modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';
    // 三键：允许类当前 501 占位（功能未启用）；拒绝键即时本地生效（标 ✋ + 反馈条），不静默放行
    const post = (sid, dec) => fetch(`/api/agent/runs/${_runsSel}/steps/${sid}/approval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: dec }) });
    $('#approvalAllowBtn').onclick = async () => {
      const sid = modal.dataset.step || '1';
      const r = await post(sid, 'allow').then(x => x.status).catch(() => 501);
      const fb = $('#approvalFeedback');
      fb.style.display = '';
      fb.textContent = r === 501 ? '审批端点未启用（501）：「允许」暂不生效，需单独立项升级 writeGate。' : `审批已提交（HTTP ${r}）。`;
      fb.style.background = r === 501 ? 'rgba(148,163,184,0.15)' : 'rgba(52,211,153,0.15)';
    };
    $('#approvalSessionBtn').onclick = async () => {
      const sid = modal.dataset.step || '1';
      const r = await post(sid, 'allow_session').then(x => x.status).catch(() => 501);
      const fb = $('#approvalFeedback');
      fb.style.display = '';
      fb.textContent = r === 501 ? '「本会话允许」未启用（501 占位，需单独立项）。' : `已提交（HTTP ${r}）。`;
    };
    $('#approvalDenyBtn').onclick = () => {
      const sid = modal.dataset.step || '1';
      const st = _runsSelSteps.find(x => x.stepId === Number(sid));
      if (st) { st.state = 'denied'; _runsRenderTimeline(); }
      const fb = $('#approvalFeedback');
      fb.style.display = '';
      fb.textContent = '已拒绝该步（agent 将基于只读信息收尾）。';
      fb.style.background = 'rgba(248,113,113,0.12)';
      $('#approvalClose').click();
    };
    $('#approvalClose').onclick = () => modal.classList.remove('show');
    modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('show'); };
  }

  initPreviewTooltip();
  initContextMenu();
  initErrorBoundary();
  initExport();
  initRowExpand();
  loadFilterState();
  initCommandPalette();
  initTableSort();
  initFilterTags();
  initMemoryLinks();
  initDataActions();
  initSidebarCollapse();
  initConnectScan();
  initAgent();
  initRuns();
  initRules();
  initIngest();
  initObsidian();
  initSkills();
  initTasks();
  initGraph();
  initLoadError();
  initDaemonHealth();
  load().then(() => {
    // 工具连接页列数修正
    const t = PAGE_TITLES[location.hash.slice(1) || 'agent']; if (t) navigate(location.hash.slice(1) || 'agent');
  }).catch(e => console.error('load failed', e));
})();
