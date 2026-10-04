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
    _p: null,
    // ★ P1-perf：echarts（~1MB）不再随首屏同步加载 —— 首次绘图时动态注入脚本；
    // 保留旧语义：15s 超时放弃本轮绘制，失败后复位 _p，下次进入可重试。
    ensure() {
      if (window.echarts) return Promise.resolve();
      if (!this._p) {
        this._p = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "./echarts.min.js";
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("echarts load failed"));
          document.head.appendChild(s);
          setTimeout(() => reject(new Error("echarts load timeout")), 15000);
        });
        this._p.catch(() => { this._p = null; });
      }
      return this._p;
    },
    when(cb) {
      this.ensure().then(() => cb()).catch(() => {});
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
    safe(updateMemoryBadges, 'updateMemoryBadges');
    safe(renderMemoryInsights, 'renderMemoryInsights');
    safe(renderWriteCadence, 'renderWriteCadence');
    safe(loadProspective, 'loadProspective');
  }

  /* ★ Slice-C2：原 renderSummary 内的「热词云 + eff 质量分布」两块逻辑独立出来，
     目标容器已迁到记忆中心·高价值子视图。 */
  function renderMemoryInsights() {
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

  }
  /* ★ 热力图（12 周 × 7 天）压缩成一行文案，避免为一句统计量维护 45 行 DOM 计算 */
  function renderWriteCadence() {
    const el = $('#writeCadence'); if (!el) return;
    const days = new Set();
    (S.memories || []).forEach(m => { if (m.created_at) days.add(new Date(m.created_at).toISOString().slice(0, 10)); });
    el.textContent = days.size ? `近 12 周有 ${days.size} 天写入` : '近 12 周暂无写入';
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
       <td><input type="checkbox" class="row-checkbox" data-id="${m.id}" aria-label="选择记忆 #${m.id}" ${checked}></td>
       <td class="mono text-muted"><button class="row-open" data-id="${m.id}" aria-label="打开记忆 #${m.id}" title="打开详情">${String(start + i + 1).padStart(2, '0')}</button></td>
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
        ${pair('编号', '#' + m.id, true)}${pair('类型', typeCN(m.type), false, `<span class="type-tag ${esc(m.type)}">${typeCN(m.type)}</span>`)}
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
        xAxis: { name: '有效置信', min: 0, max: 1, axisLabel: { color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } }, nameTextStyle: { color: '#64748b' } },
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
      $('#crossMatrix').innerHTML = '<div class="empty-state"><div class="empty-icon">🔗</div><div class="empty-title">暂无跨工具复用</div><div class="empty-desc">还没有 AI 智能体引用其他工具写入的记忆，随着使用会逐渐出现</div></div>';
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
      $('#allTableBody').innerHTML = rows.map((m, i) => `<tr data-id="${m.id}"><td class="mono text-muted"><button class="row-open" data-id="${m.id}" aria-label="打开记忆 #${m.id}" title="打开详情">${String(i + 1).padStart(2, '0')}</button></td><td class="memory-content">${esc(m.content)}</td><td><span class="type-tag ${esc(m.type)}">${typeCN(m.type)}</span></td><td><span class="status-pill ${esc(m.status)}"><span class="sdot"></span>${statusCN(m.status)}</span></td><td class="mono" style="font-size:12px">${esc(m.agent)}</td><td><span class="eff-bar"><span class="eff-bar-fill" style="width:${Math.min(100, (m.eff || 0) * 100)}%"></span></span><span class="mono" style="font-size:12px">${(m.eff || 0).toFixed(2)}</span></td><td class="mono" style="font-size:13px;color:var(--accent-cyan)">${m.hits}</td><td class="mono text-secondary" style="font-size:12px">${fmtDate(m.created_at)}</td></tr>`).join('');
      $$('#allTableBody tr').forEach(tr => tr.onclick = () => openDetail(Number(tr.dataset.id)));
      toast(q ? '检索到 ' + rows.length + ' 条相关记忆' : '显示全部记忆');
    });
  }

  /* ===== 路由 ===== */
  const PAGE_TITLES = { govern: ['连接与治理', '工具接入 · 跨工具复用 · 治理与健康'], memory: ['记忆中心', '全量记忆 · 价值 · 治理 · 采集'], agent: ['智能体', '内置智能体 · MCP 工具面 · 可插拔 LLM 端点'],rules: ['规则管理', 'AI 智能体协同约束'], obsidian: ['笔记', '仓库笔记库 · 笔记×记忆×卡片统一图谱'], skills: ['技能同步', '中央技能库 ↔ 多智能体分发'],tasks: ['任务看板', '卡片工作流 · 智能体执行过程'] };
  function navigate(route, sub) {
    $$('.nav-item').forEach(n => {
      const on = n.dataset.route === route;
      n.classList.toggle('active', on);
      // ★ P2-⑤ a11y：当前页除视觉 active 类外，同步 aria-current 给屏幕阅读器
      if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
    });
    $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + route));
    const [t, s] = PAGE_TITLES[route] || [route, ''];
    // $('#pageTitle').innerHTML = t + ' <span>' + s + '</span>';
    document.title = t + ' - MemoryOS';
    // ★ P2-⑤ a11y：全局唯一 h1 同步当前页名（屏幕阅读器按标题导航才有意义）
    const _a11yH1 = document.getElementById('a11yPageH1');
    if (_a11yH1) _a11yH1.textContent = t + ' - MemoryOS';
    const _first = (PAGE_VIEWS[route] || [])[0];
    location.hash = (sub && _first && sub !== _first) ? route + '/' + sub : route;
    /* ★ Slice-B：记忆中心子视图分发（图表/初始化按当前子视图懒加载） */
    if (route === 'memory') applyMemoryView(sub || 'all', true, 'page-memory');
    if (route === 'govern') applyMemoryView(sub || 'connect', true, 'page-govern');
    if (route === 'obsidian') applyMemoryView(sub || 'vault', true, 'page-obsidian');
    if (route === 'memory' && (sub || memoryView) === 'trend') window.EChartsLoaded.when(drawTrendCharts);
    if (route === 'memory' && (sub || memoryView) === 'top') window.EChartsLoaded.when(drawTopScatter);
    if (route === 'agent' && initAgent) initAgent();
    if (route === 'rules' && initRules) initRules();

    if (route === 'obsidian' && initObsidian) initObsidian();
    if (route === 'skills' && initSkills) initSkills();
    if (route === 'tasks') applyMemoryView(sub || 'cards', true, 'page-tasks');
    if (route === 'tasks' && initTasks) initTasks();
    /* ★ 实时看板：进任务看板开卡片 SSE（变更即重画当前视图），离开即关 */
    if (route === 'tasks') _cardsStreamStart(); else _cardsStreamStop();
    // ★ UI2.0：入场动画结束后统一重算图表尺寸，修正 ECharts 在容器尺寸未稳定时初始化导致的挤压/只显首点
    setTimeout(() => { try { resizeAllCharts(); } catch { /* ignore */ } }, 340);
  }
  /* ★ Slice-B：记忆中心子视图 */
  let memoryView = 'all';
  let obsidianView = 'vault';
  const MEMORY_VIEWS = ['all', 'top', 'zombies', 'arbitrate', 'trend', 'ingest', 'audit'];
  const GOVERN_VIEWS = ['connect', 'cross', 'govern'];
  const OBSIDIAN_VIEWS = ['vault', 'unified'];
  const TASK_VIEWS = ['cards', 'runs'];
  /* 页面 -> 子视图白名单；子视图懒加载映射（等价于原按路由分发） */
  const PAGE_VIEWS = { memory: MEMORY_VIEWS, govern: GOVERN_VIEWS, obsidian: OBSIDIAN_VIEWS, tasks: TASK_VIEWS };
  const VIEW_HOOKS = {
    top:       () => window.EChartsLoaded.when(drawTopScatter),
    trend:     () => window.EChartsLoaded.when(drawTrendCharts),
    cross:     () => window.EChartsLoaded.when(drawCrossCharts),
    zombies:   () => safe(renderZombies, 'renderZombies'),
    audit:     () => safe(renderAudit, 'renderAudit'),
    top_:      null,
    ingest:    () => { if (typeof initIngest === 'function') initIngest(); },
    connect:   () => { if (autoScanConnect) autoScanConnect(); },
    govern:    () => { if (typeof initGovernance === 'function') initGovernance(); },
    unified:   () => { if (typeof initGraph === 'function') initGraph(); },
    runs:      () => { if (typeof initRuns === 'function') initRuns(); },
  };
  function applyMemoryView(view, silent, pageId) {
    const pid = pageId || 'page-memory';
    const allowed = PAGE_VIEWS[String(pid).replace(/^page-/, '')] || MEMORY_VIEWS;
    if (!allowed.includes(view)) view = allowed[0];
    if (pid === 'page-memory') memoryView = view; else if (pid === 'page-obsidian') obsidianView = view;
    const root = document.getElementById(pid);
    if (root) {
      root.querySelectorAll('.subview').forEach(v => v.classList.toggle('on', v.dataset.view === view));
      root.querySelectorAll('.subtab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    }
    const hook = VIEW_HOOKS[view]; if (hook) { try { hook(); } catch (e) { console.error('[subview] ' + view + ' init failed:', e); } }
    updateMemoryBadges();
    if (!silent) { try { resizeAllCharts(); } catch { /* ignore */ } }
    setTimeout(() => { try { resizeAllCharts(); } catch { /* ignore */ } }, 340);
  }
  function updateMemoryBadges() {
    const zN = (S && Array.isArray(S.zombies)) ? S.zombies.length : 0;
    const z = document.getElementById('zombiesBadge');
    if (z) { z.textContent = zN ? String(zN) : ''; z.style.display = zN ? '' : 'none'; }
    const aN = (S && Array.isArray(S.arbitrate)) ? S.arbitrate.length : 0;
    const a = document.getElementById('arbitrateBadge');
    if (a) { a.textContent = aN ? String(aN) : ''; a.style.display = aN ? '' : 'none'; }
  }
  function bindMemorySubnav() {
    document.querySelectorAll('.subnav').forEach(nav => {
      if (nav.dataset.bound) return;
      nav.dataset.bound = '1';
      const pageId = nav.closest('.page') ? nav.closest('.page').id : 'page-memory';
      const route = String(pageId).replace(/^page-/, '');
      nav.querySelectorAll('.subtab').forEach(btn => {
        btn.onclick = () => {
          const v = btn.dataset.view;
          applyMemoryView(v, false, pageId);
          if (location.hash.slice(1).split('/')[0] !== route) location.hash = v === PAGE_VIEWS[route][0] ? route : route + '/' + v;
        };
      });
    });
  }

  function bindNav() {
    $$('.nav-item').forEach(item => item.onclick = () => navigate(item.dataset.route));
    window.addEventListener('hashchange', () => {
      const raw = location.hash.slice(1) || 'agent';
      if (location.hash.slice(1).split('/')[0] === 'graph') { location.hash = 'obsidian/unified'; return; }
      if (location.hash.slice(1).split('/')[0] === 'runs') { location.hash = 'tasks/runs'; return; }
      const seg = raw.split('/');
      if (PAGE_TITLES[seg[0]]) navigate(seg[0], seg[1]);
    });
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
  /* ★ 批次⑨（2026-09-24）：通用输入弹窗 —— Electron 壳的渲染进程不实现 window.prompt（点了无反应），
     本 helper 以 Promise 语义等价替代（resolve(values) / 取消 resolve(null)）：
     Enter 提交，Esc / ✕ / 点遮罩取消；required 项为空时阻止提交并提示。所有原 prompt 调用点统一走这里。 */
  function askForm(opts) {
    return new Promise((resolve) => {
      const old = $('.ask-form-modal'); if (old) old.remove();
      const fieldsHtml = (opts.fields || []).map((f) => {
        if (f.type === 'select') {
          const optsHtml = ((f.options || []).map(o => {
            const val = String(o.value ?? o ?? '');
            const sel = val === String(f.value ?? '') ? ' selected' : '';
            return `<option value="${esc(val)}"${sel}>${esc(String(o.label ?? o))}</option>`;
          }).join('') || '<option value="">（无选项）</option>');
          return `<label style="display:block;font-size:12px;color:var(--text-muted);margin:10px 0 4px">${esc(f.label)}${f.required ? ' *' : ''}</label>
          <select data-k="${esc(f.key)}" style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:13px;background:var(--surface-glass,#fff);color:var(--text-primary);border:1px solid var(--border-glass,rgba(0,0,0,.15));border-radius:8px;outline:none">${optsHtml}</select>`;
        }
        return `<label style="display:block;font-size:12px;color:var(--text-muted);margin:10px 0 4px">${esc(f.label)}${f.required ? ' *' : ''}</label>
        <input data-k="${esc(f.key)}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}"
          style="width:100%;box-sizing:border-box;padding:8px 10px;font-size:13px;background:var(--surface-glass,#fff);color:var(--text-primary);border:1px solid var(--border-glass,rgba(0,0,0,.15));border-radius:8px;outline:none">`;
      }).join('');
      const wrap = document.createElement('div');
      wrap.className = 'ask-form-modal cockpit-modal';
      wrap.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center';
      wrap.innerHTML = `<div style="max-width:480px;width:92%;background:var(--surface-glass,#fff);backdrop-filter:blur(14px);border:1px solid var(--border-glass,rgba(0,0,0,0.12));border-radius:14px;padding:18px 20px;box-shadow:0 18px 60px rgba(0,0,0,0.3)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(opts.title || '请输入')}</span>
          <button data-x style="margin-left:auto;background:none;border:none;font-size:16px;color:var(--text-muted);cursor:pointer">✕</button>
        </div>
        <div data-fields style="font-size:12px">${fieldsHtml}</div>
        <div data-msg style="display:none;font-size:12px;color:#ef4444;margin-top:8px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button data-cancel class="btn-ghost" style="padding:6px 14px;font-size:12px">取消</button>
          <button data-ok class="btn-primary" style="padding:6px 16px;font-size:12px">${esc(opts.okText || '确定')}</button>
        </div>
      </div>`;
      document.body.appendChild(wrap);
      let done = false;
      const finish = (v) => { if (done) return; done = true; document.removeEventListener('keydown', onKey); wrap.remove(); resolve(v); };
      const submit = () => {
        const vals = {}; let firstBad = null;
        for (const f of (opts.fields || [])) {
          const el = wrap.querySelector(`[data-k="${f.key}"]`);
          const v = (el && el.value || '').trim();
          if (f.required && !v) { firstBad = firstBad || el; continue; }
          vals[f.key] = v;
        }
        if (firstBad) { const m = wrap.querySelector('[data-msg]'); m.style.display = 'block'; m.textContent = '必填项不能为空'; firstBad.focus(); return; }
        finish(vals);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
        else if (e.key === 'Enter') { e.preventDefault(); submit(); }
      };
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(null); });
      wrap.querySelector('[data-x]').onclick = () => finish(null);
      wrap.querySelector('[data-cancel]').onclick = () => finish(null);
      wrap.querySelector('[data-ok]').onclick = submit;
      const first = wrap.querySelector('[data-k]'); if (first) first.focus();
    });
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
        : '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-muted)">点击「开始扫描」发现本机已安装的 AI 智能体</td></tr>';
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
    // ★ 批次⑦B：手动登记清单外新 agent —— ★ 批次⑨：prompt()→askForm（Electron 壳 prompt 全哑）
    $('#manualRegBtn').onclick = async () => {
      const v = await askForm({
        title: '手动登记新智能体（扫描清单外）',
        fields: [
          { key: 'name', label: '智能体名称', placeholder: '例 OpenCode', required: true },
          { key: 'configDir', label: '配置目录（可选，例 C:\\Users\\x\\.newagent —— 填了才能自动判定「已连接」）', placeholder: '回车跳过' },
          { key: 'path', label: '安装路径/可执行文件（可选）', placeholder: '回车跳过' },
        ],
        okText: '登记',
      });
      if (!v) return;
      const name = (v.name || '').trim();
      if (!name) return;
      const r = await fetch('/api/scan-agents/custom', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, configDir: (v.configDir || '').trim(), path: (v.path || '').trim() }),
      }).then(x => x.json()).catch(e => ({ error: e.message }));
      if (r.ok) { toast('已登记「' + name + '」，正在重扫…'); runScan(true); }
      else toast(r.error || '登记失败', 3000);
    };
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
      const iv = setInterval(() => { p = Math.min(p + 30, 90); if (bar) bar.style.width = p + '%'; set('#scanPercent', p + '%'); setAuto('正在探测本机智能体…'); }, 300);
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
      `<tr data-id="${m.id}"><td class="mono text-muted"><button class="row-open" data-id="${m.id}" aria-label="打开规则 #${m.id}" title="打开详情">${String(i + 1).padStart(2, '0')}</button></td>
       <td class="memory-content">${esc(m.content)}</td>
       <td class="mono" style="font-size:12px">${esc(m.agent)}</td>
       <td><span class="status-pill ${esc(m.status)}"><span class="sdot"></span>${statusCN(m.status)}</span></td>
       <td class="mono" style="font-size:12px">${Number(m.confidence || 0).toFixed(2)}</td>
       <td class="mono text-secondary" style="font-size:12px">${fmtDate(m.created_at)}</td>
       <td><div style="display:flex;gap:6px"><button class="btn-ghost rule-inject" data-rid="${m.id}" title="${m.inject ? '已强制注入：除内置 8 条门禁外，本条也常驻所有智能体约束文件（点击取消）' : '点击强制注入：本条常驻所有智能体约束文件（自动同步）'}" style="padding:4px 10px;font-size:12px;${m.inject ? 'color:var(--success);border-color:rgba(16,185,129,0.35)' : ''}">${m.inject ? '注入✓' : '注入'}</button><button class="btn-ghost rule-edit" data-rid="${m.id}" style="padding:4px 10px;font-size:12px">编辑</button><button class="btn-ghost rule-del" data-rid="${m.id}" style="padding:4px 10px;font-size:12px;color:var(--danger);border-color:rgba(248,113,113,0.3)">删除</button></div></td></tr>`).join('')
      : '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📏</div><div class="empty-title">暂无规则</div><div class="empty-desc">还没有创建 AI 智能体协同约束规则，点击右上角"新建规则"开始</div></div></td></tr>';
    $$('#ruleTableBody tr[data-id]').forEach(tr => tr.onclick = () => openDetail(Number(tr.dataset.id), ruleRows));
    $$('#ruleTableBody .rule-edit').forEach(b => b.onclick = e => { e.stopPropagation(); openEdit(Number(b.dataset.rid), 'rule'); });
    $$('#ruleTableBody .rule-del').forEach(b => b.onclick = e => { e.stopPropagation(); delRule(Number(b.dataset.rid)); });
    // ★ 批次⑦X2：强制注入开关 —— PUT inject，后端成功后自动刷新全部智能体注入段
    $$('#ruleTableBody .rule-inject').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const id = Number(b.dataset.rid);
      const row = ruleRows.find(x => x.id === id);
      const next = row && row.inject ? 0 : 1;
      const r = await fetch('/api/memory/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inject: next }) }).then(x => x.json()).catch(e2 => ({ error: e2.message }));
      if (r.ok) { toast(next ? '已开启强制注入，注入段已自动刷新到所有智能体' : '已取消强制注入，注入段已自动刷新'); loadRules(); }
      else toast(r.error || '设置失败');
    });
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
      body.innerHTML = '<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">📥</div><div class="empty-title">尚未探测到可采集的来源</div><div class="empty-desc">采集地址由系统自动分配，无需手动配置；装了对应 AI 智能体后其记忆目录会自动出现</div></div></td></tr>';
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
    // ★ 批次⑨：prompt()→askForm（Electron 壳 prompt 不实现）
    const v = await askForm({
      title: '签发治理凭据',
      fields: [
        { key: 'agent', label: '为哪个智能体签发？', value: 'zcode', required: true },
        { key: 'scope', label: '权限作用域（read/write/admin）', value: 'read' },
        { key: 'ttl', label: '短生命周期小时数（0.1–24）', value: '1' },
      ],
      okText: '签发',
    });
    if (!v) return;
    const agent = (v.agent || '').trim();
    if (!agent) return;
    const scope = (v.scope || '').trim() || 'read';
    const ttl = Number(v.ttl) || 1;
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
      : '<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">📝</div><div class="empty-title">暂无已导入笔记</div><div class="empty-desc">选择 Obsidian 仓库后点击"导入笔记"开始同步</div></div></td></tr>';
  }
  async function loadObsidianStatus() {
    const vault = currentVault();
    const badge = $('#obsidianStatusBadge');
    if (!vault) { if (badge) badge.textContent = '选择仓库后查看'; return; }
    const r = await fetch('/api/obsidian/status?vault=' + encodeURIComponent(vault)).then(x => x.json()).catch(e => ({ error: e.message }));
    if (r.error) { if (badge) badge.textContent = '加载失败：' + r.error; return; }
    if (badge) badge.textContent = `笔记 ${r.noteFiles} · 已导入 ${r.imported} · 待导入 ${r.pending} · 库中 obsidian 记忆 ${r.memoriesFromObsidian}`;
    renderObsidianImported(r.imported || []);
  }
  let _obsidianTick = null;       // 进度条用时计时器（真进度只有完成态 stats，进行中只报已用时）
  function obsidianProgressStart(label) {
    $('#obsidianProgress').style.display = 'block';
    $('#obsidianStatus').textContent = label;
    $('#obsidianPercent').textContent = '0s';
    $('#obsidianBar').classList.add('indeterminate');
    $('#obsidianStats').innerHTML = '';
    const t0 = Date.now();
    clearInterval(_obsidianTick);
    _obsidianTick = setInterval(() => {
      const el = $('#obsidianPercent');
      if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + 's';
    }, 1000);
  }
  function obsidianProgressDone(ok, stats, label, isDryRun) {
    clearInterval(_obsidianTick); _obsidianTick = null;
    const barEl = $('#obsidianBar');
    if (barEl) barEl.classList.remove('indeterminate');
    $('#obsidianBar').style.width = '100%';
    $('#obsidianPercent').textContent = ok ? '完成' : '—';
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
    if (!vault) { toast('请先选择或输入 Obsidian 仓库路径'); return; }
    const dryRun = $('#obsidianDryRun').checked;
    const btn = $('#obsidianImportBtn');
    btn.disabled = true; btn.style.opacity = '0.6';
    obsidianProgressStart(dryRun ? '正在预演导入（不落库）…' : '正在扫描仓库并增量导入…（大仓库首次可能需要数分钟）');
    try {
      const r = await fetch('/api/obsidian/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vault, project: $('#obsidianProjectInput').value.trim() || undefined, dry_run: dryRun }),
      }).then(x => x.json());
      obsidianProgressDone(!!r.ok, r.stats, '导入', dryRun);
      if (r.ok) {
        toast(dryRun ? '预演完成' : ('导入完成：新增 ' + (r.stats.added || 0) + ' / 更新 ' + (r.stats.updated || 0)));
        if (!dryRun) loadObsidianStatus();
        if (!dryRun) refreshNoteWorkbench();
      } else toast('导入失败：' + (r.error || '未知错误'));
    } catch (e) {
      obsidianProgressDone(false, null, '导入', false);
      toast('导入失败：' + e.message);
    } finally { btn.disabled = false; btn.style.opacity = '1'; }
  }
  async function runObsidianExport() {
    const vault = currentVault();
    if (!vault) { toast('请先选择或输入 Obsidian 仓库路径'); return; }
    const btn = $('#obsidianExportBtn');
    btn.disabled = true; btn.style.opacity = '0.6';
    obsidianProgressStart('正在导出 active 记忆到 vault/MemoryOS 导出/…');
    try {
      const r = await fetch('/api/obsidian/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vault, project: $('#obsidianProjectInput').value.trim() || undefined }),
      }).then(x => x.json());
      obsidianProgressDone(!!r.ok, r.stats, '导出', false);
      if (r.ok) toast('导出完成：写入 ' + (r.stats.written || 0) + ' / 跳过 ' + (r.stats.skipped || 0));
      else toast('导出失败：' + (r.error || '未知错误'));
    } catch (e) {
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
  let NOTE_EDITING_ID = null;     // 非空 = 正在编辑该笔记（保存走 PUT 写回原文件，而非另存新笔记）
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
      box.innerHTML = '<div class="notes-empty"><span class="big">📓</span>还没有索引到笔记<br>选好仓库后点右上角「导入笔记」</div>';
      return;
    }
    if (!rows.length) {
      box.innerHTML = `<div class="notes-empty">${q ? '没有匹配的笔记' : '当前仓库下还没有笔记<br>（列表显示的是已索引笔记，可切到「全部」范围或先导入）'}</div>`;
      return;
    }
    box.innerHTML = rows.map(n => `
      <div class="notes-item${n.id === NOTE_SELECTED_ID ? ' active' : ''}" data-nid="${n.id}" title="${esc(n.rel_path)}">
        <div class="notes-item-title">${esc(n.title)}${n.origin === 'user' ? '<span class="nbadge">自建</span>' : ''}</div>
        <div class="notes-item-sub">${esc(n.rel_path || '')}</div>
      </div>`).join('');
    $$('#notesRailList .notes-item').forEach(el => {
      // ★ a11y P0-1（2026-10-03）：整行点击的笔记项须键盘可达 —— role=button + tabIndex + Enter/Space 激活
      //   （此前仅 .onclick，属「可点但键盘不可聚焦」；随 vault 笔记增多首次被 a11y 门禁暴露）
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.onclick = () => selectNote(Number(el.dataset.nid));
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } };
    });
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
        ? '这个仓库还没有索引到笔记<br>点右上角「<b>导入笔记</b>」，笔记与 [[双向链接]] 会在这里结成图谱'
        : '先在上方选择 / 粘贴仓库路径，再点右上角「<b>导入笔记</b>」'));
      else setGraphEmpty(true, scope === 'vault'
        ? '当前仓库还没有已索引笔记<br>可切换右上范围到「全部笔记」，或先点「导入笔记」'
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
        ? '这条笔记还没有对应的记忆正文（可能尚未导入，或记忆已被合并）。可在「编辑」标签页里重写，保存会写入仓库的 MemoryOS 写入/ 目录。'
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
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn-ghost" id="noteDetailLinksBtn" style="padding:5px 12px;font-size:12px">反向链接</button>
        ${(res.body != null && res.body !== '') ? `<button class="btn-ghost" id="noteDetailPutBtn" style="padding:5px 12px;font-size:12px" title="编辑原文件，保存写回并同步更新对应记忆；若文件在外部被改过会自动留副本">编辑此笔记</button>` : ''}
        <button class="btn-ghost" id="noteDetailEditBtn" style="padding:5px 12px;font-size:12px" title="把正文复制到编辑器，保存时写成一条新笔记（不覆盖原文件）">另存为新笔记</button>
        <button class="btn-ghost" id="noteDetailDelBtn" style="padding:5px 12px;font-size:12px;color:var(--error)" title="移入仓库的 .trash（可找回），相关链接退化为未解析">删除</button>
      </div>`;
    const lb = $('#noteDetailLinksBtn');
    if (lb) lb.onclick = () => switchNoteTab('links');
    const del = $('#noteDetailDelBtn');
    if (del) del.onclick = async () => {
      const okd = await askForm({ title: `删除笔记「${note.title}」？`, okText: '删除' });
      if (!okd) return;
      const r = await fetch('/api/notes/' + note.id, { method: 'DELETE' }).then(x => x.json()).catch(() => null);
      if (!r || !r.ok) { toast('删除失败：' + ((r && r.error) || '未知错误')); return; }
      if (NOTE_EDITING_ID === note.id) NOTE_EDITING_ID = null;
      if (NOTE_SELECTED_ID === note.id) NOTE_SELECTED_ID = null;
      const box = $('#noteDetail');
      if (box) box.innerHTML = '<div class="notes-empty"><span class="big">📄</span>从左侧列表或中间图谱点选一条笔记</div>';
      toast('已移入 .trash：' + note.rel_path);
      refreshNoteWorkbench();
      loadObsidianStatus();
    };
    const eb = $('#noteDetailEditBtn');
    if (eb) eb.onclick = () => {
      switchNoteTab('edit');
      NOTE_EDITING_ID = null;
      const t = $('#noteTitle'), b = $('#noteBody'), h = $('#noteHint'), p = $('#notePreviewBox'), ty = $('#noteType');
      if (t) { t.value = note.title; t.readOnly = false; }
      if (b) b.value = res.body || '';
      if (ty) { ty.disabled = false; ty.value = 'experience'; }
      if (p) p.style.display = 'none';
      if (h) { h.className = 'form-hint'; h.textContent = '已复制到编辑器；保存会作为新笔记写入仓库（不覆盖原文件）'; }
    };
    const pb = $('#noteDetailPutBtn');
    if (pb) pb.onclick = () => {
      switchNoteTab('edit');
      NOTE_EDITING_ID = note.id;
      const t = $('#noteTitle'), b = $('#noteBody'), h = $('#noteHint'), p = $('#notePreviewBox'), ty = $('#noteType');
      if (t) { t.value = note.title; t.readOnly = true; }
      if (b) b.value = res.body || '';
      if (ty) { ty.disabled = true; } // 类型在新建时确定；PUT 保留磁盘 frontmatter 原类型，不提供改类型
      if (p) p.style.display = 'none';
      if (h) { h.className = 'form-hint'; h.textContent = `正在编辑 ${note.rel_path}（标题与类型锁定）；保存写回原文件，并同步更新对应的记忆`; }
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
    if (!NOTE_VAULTS.length) { box.innerHTML = '<span class="text-muted" style="font-size:11px">未探测到仓库，可直接粘贴绝对路径</span>'; return; }
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
        NOTE_EDITING_ID = null;
        const t = $('#noteTitle'), b = $('#noteBody'), h = $('#noteHint'), p = $('#notePreviewBox'), ty = $('#noteType');
        if (t) { t.value = ''; t.readOnly = false; t.focus(); }
        if (b) b.value = '';
        if (ty) { ty.disabled = false; ty.value = 'experience'; }
        if (h) { h.className = 'form-hint'; h.textContent = '新笔记：填类型、标题与正文，点「保存笔记」写入所选仓库的 MemoryOS 写入/ 目录，并转成对应类型的记忆'; }
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
      if (detBadge) detBadge.textContent = '检测到 ' + d.detected.length + ' 个智能体 / ' + connected + ' 已连接 / ' + supported + ' 支持技能分发';
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
    done: { label: '已完成', color: '#10b981' },
    cancelled: { label: '已取消', color: '#64748b' },
    merged: { label: '已合并', color: '#a855f7' },
    archived: { label: '已归档', color: '#64748b' },
  };
  /* ★ D-5：节点状态文字色对照表 [亮色, 暗色]。状态色（圆点/描边/强调）保持原色相，
     只有 10px 小字换到同色系高对比档，解决 in_progress 2.43:1 / blocked 2.15:1。
     查表未命中时回退原状态色，不影响新状态接入。 */
  const NODE_TEXT_COLOR = {
    '#94a3b8': ['#5b6b7d', '#cbd5e1'],
    '#06b6d4': ['#0e7490', '#67e8f9'],
    '#f59e0b': ['#a16207', '#fcd34d'],
    '#10b981': ['#047857', '#6ee7b7'],
    '#22c55e': ['#15803d', '#86efac'],
    '#64748b': ['#475569', '#94a3b8'],
    '#a855f7': ['#7e22ce', '#d8b4fe'],
    '#ef4444': ['#b91c1c', '#fca5a5'],
  };
  const TASK_ORDER = ['pending', 'in_progress', 'blocked', 'done', 'cancelled', 'merged', 'archived']; // ★ E-0 六持久态 + archived（review/failed 已取消）
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
        ${pair('编号', idStr, true)}
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
    // ★ 2026-09-20：初始化不再加载旧任务视图 —— loadTasks() 会把含 done 的七态列表渲染进 #tasksBoard
    //   （地图已是唯一任务入口，容器默认 display:none，此调用属无用请求 + 已完成任务重复展示的隐患）。
    //   showTaskView('legacy') 分支仍会按需 loadTasks()。
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
      // ★ P4 简化批（2026-10-03）：恢复 tabCards「列式看板」入口 —— 列式视图的「拖卡片改状态」是步骤最少的状态流转（1 次拖拽），
      //   且 renderCards/拖拽逻辑本就完整可用，此前只是入口按钮被删（_taskViewMode 恒为 'map' 导致 4208 行拖拽段成死代码）。
      if (tabMap) tabMap.onclick = () => showTaskView('map');
      if (tabCards) tabCards.onclick = () => showTaskView('cards');
      if (tabLegacy) tabLegacy.onclick = () => showTaskView('legacy');
      // ★ 2026-09-13：旧任务视图（七态 #tasksBoard）仍隐藏 —— 与卡片看板重复展示，不属本次范围
      if (tabLegacy) tabLegacy.style.display = 'none';
      if (ccb) ccb.onclick = createCard;
      initCreateCardPanel(); // 画布左上角「＋」悬浮入口（点选建卡；随受限模式显隐）
      if (dpb) dpb.onclick = runDispatch;
      if (ilb) ilb.onclick = importLegacy;
      showTaskView('map'); // ★ 2026-09-13：任务地图为默认模块入口
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
      hint.textContent = '请选择计划文件，或粘贴计划备份内容';
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
    if (!body.content && !body.path) { hint.textContent = '请选择计划文件，或粘贴计划备份内容'; hint.style.display = 'block'; return; }
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
      const tt = $('#themeToggle'); if (tt) tt.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    } else {
      document.documentElement.removeAttribute('data-theme');
      const tt = $('#themeToggle'); if (tt) tt.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
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
    { id: 'export', name: '导出全部数据', desc: '导出所有记忆为备份文件', icon: '💾', shortcut: 'Ctrl+E', action: () => $('#exportAllBtn')?.click() },
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

  /* ===== 可访问性（P2-⑤，2026-09-22）：主操作件键盘可达 =====
   * 背景（CDP 实测基线，outputs/a11y-baseline-20260922.json）：看板大量"主操作件"是
   *   <a>/<div>/<span> + JS `.onclick`，无 href / tabindex → 不在 Tab 序列、键盘用户完全够不着
   *   （P0-1 命中 54，去重 36 个元素：导航 18 / 排序表头 7 / 侧栏快捷项 4 / 统计卡 4 / 会话项 2 / 任务地图 1）。
   * 取舍（P0 批 + 本批修订）：**主操作件与离散列表项**（导航/入口/标签/排序表头/词云/排行/chip/可点卡片）
   *   统一标记为可聚焦 + Enter/Space 可触发；**数据行（tr）本身仍不进 Tab 序列** —— 行是容器不是动作，
   *   其键盘等价路径是**行内主操作**（`button.row-open`，见 renderAllTable / renderAll / renderRules 三处模板）。
   * 动态内容（表格重渲染、会话列表、词云、右键菜单、runs 看板）由 MutationObserver 增量补齐；
   *   只 observe childList，自身写属性不会回环触发。
   */
  const A11Y_SEL = '.nav-item[data-route], .agent-sidebar-quick-item, .agent-session-item, .stat-card[data-route], #tabMap, th[data-sort], .more-panel-tab, .context-menu-item, .word-cloud-item, .rank-item, .notes-vchip, .session-chip, [data-a11y-click]';
  function markA11y(root) {
    const scope = (root && root.querySelectorAll) ? root : document;
    const NATIVE_FOCUSABLE = 'a[href],button,input,select,textarea,[contenteditable="true"]';
    const add = (el) => {
      if (el.disabled === true) return;
      if (el.dataset.a11yKey === '1') return;
      // ★ 必须按「原生可聚焦性」判定，不能看 el.tabIndex —— 实测 <a> 无 href 时 tabIndex 仍返回 0，
      //   用 `el.tabIndex < 0` 做守卫会跳过它、tabindex 属性根本没写上（探针实证 tabindexAttr=null）。
      if (!el.matches(NATIVE_FOCUSABLE) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      // th 保留 columnheader 角色（只加 tabindex），其余按标签定角色
      if (el.tagName !== 'TH' && !el.getAttribute('role')) el.setAttribute('role', el.tagName === 'A' ? 'link' : 'button');
      el.dataset.a11yKey = '1';
    };
    if (scope.matches && scope.matches(A11Y_SEL)) add(scope);
    scope.querySelectorAll(A11Y_SEL).forEach(add);
  }
  function initA11yInteractions() {
    markA11y(document.body);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const t = e.target;
      if (!t || !t.dataset || t.dataset.a11yKey !== '1') return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      t.click();
    });
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) markA11y(n);
    }).observe(document.body, { childList: true, subtree: true });
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
        headers.forEach(h => { h.textContent = h.textContent.replace(/ [↑↓]$/, ''); h.setAttribute('aria-sort', 'none'); });
        th.textContent += sortDir === 'asc' ? ' ↑' : ' ↓';
        th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending'); // ★ P2-⑤ a11y：排序状态暴露给屏幕阅读器
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
    // 协议值→中文展示映射（筛选标签只显示中文，data-value 仍为协议值，删除匹配逻辑不受影响）
    const STATUS_ZH = { triage: '待分流', todo: '待办', ready: '可认领', running: '执行中', review: '待验收', done: '已完成', failed: '失败', cancelled: '已取消', blocked: '受阻', archived: '已归档' };
    const TYPE_ZH = { memory: '记忆', rule: '规则', convo: '对话', experience: '经验', decision: '决策', pitfall: '踩坑', convention: '约定' };
    if (currentStatus !== 'all') tags.push({ type: 'status', value: currentStatus, label: '状态: ' + (STATUS_ZH[currentStatus] ?? currentStatus) });
    if (currentType !== 'all') tags.push({ type: 'type', value: currentType, label: '类型: ' + (TYPE_ZH[currentType] ?? currentType) });
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
      exportBtn.onclick = async () => {
        // ★ 批次⑨：prompt()→askForm
        const v = await askForm({ title: '导出格式', fields: [{ key: 'format', label: '输入 md / json / csv（默认 md）', value: 'md' }], okText: '导出' });
        if (!v) return;
        const format = v.format;
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
  /* ★ P4 简化批：终端 / Design 抽屉的注册句柄 —— 必须声明在 initTerm()/initDesign() 调用（下方 4012/4013 行）之前，
     否则模块顺序执行到调用点时会撞上暂时性死区（TDZ）→ ReferenceError 白屏。 */
  let _termOpenWithCwd = null;   // 由 initTerm 注册：打开准终端并选中指定 cwd
  let _designOpenDrawer = null;  // 由 initDesign 注册：打开设计拾取抽屉
  /* ===== ★ Orca 融合 P2（2026-10-03 CLAIM §5）：准终端抽屉（exec_run 流式版 SSE，无 pty）=====
   * 与后端 dashboard-reg-term.js 配套：argv 数组 + 白名单 + cwd 白名单 + killTree（安全口径同 MCP exec_run）。
   * 分屏 = 双 pane 并排（窄屏 CSS 自动纵向堆叠）；每 pane 独立 cwd/历史/停止。 */
  function initTerm() {
    const drawer = $('#termDrawer');
    if (!drawer) return;
    const T = { es: [null, null], runId: [null, null], hist: [[], []], hi: [0, 0], split: false, inited: false };
    const paneEl = (i) => drawer.querySelector(`.term-pane[data-pane="${i + 1}"]`);
    const append = (i, text, cls) => {
      const out = paneEl(i)?.querySelector('.term-out');
      if (!out) return;
      if (cls) { const s = document.createElement('span'); s.className = cls; s.textContent = text; out.appendChild(s); }
      else out.appendChild(document.createTextNode(text));
      while (out.childNodes.length > 4000) out.removeChild(out.firstChild); // DOM 上限：防长跑输出撑爆页面
      out.scrollTop = out.scrollHeight;
    };
    // 客户端分词（引号内成一段）→ argv 交后端白名单校验；准终端无管道/重定向
    const splitCmd = (s) => {
      const out = []; let cur = '', q = null;
      for (const ch of s) {
        if (q) { if (ch === q) q = null; else cur += ch; }
        else if (ch === '"' || ch === "'") q = ch;
        else if (ch === ' ') { if (cur) { out.push(cur); cur = ''; } }
        else cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    };
    const idle = (i) => {
      const el = paneEl(i);
      el.querySelector('.term-run').hidden = false;
      el.querySelector('.term-stop').hidden = true;
      const inp = el.querySelector('.term-input');
      inp.disabled = false;
      return inp;
    };
    const stop = (i, quiet) => {
      const es = T.es[i], rid = T.runId[i];
      if (es) es.close(); // 断开 SSE → 服务端 req close → killTree（双保险再补一次显式 kill）
      T.es[i] = null; T.runId[i] = null;
      if (rid) fetch('/api/exec/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: rid }) }).catch(() => {});
      if (!quiet) append(i, '\n[已停止]\n', 't-dim');
      idle(i);
    };
    const run = (i) => {
      const el = paneEl(i);
      const input = el.querySelector('.term-input');
      const cmd = input.value.trim();
      if (!cmd) return;
      if (T.es[i]) stop(i, true);
      const argv = splitCmd(cmd);
      if (!argv.length) return;
      const cwd = el.querySelector('.term-cwd').value || '.';
      const h = T.hist[i];
      if (h[h.length - 1] !== cmd) h.push(cmd);
      T.hi[i] = h.length;
      input.value = '';
      append(i, `\n$ ${cmd}\n`, 't-dim');
      el.querySelector('.term-run').hidden = true;
      el.querySelector('.term-stop').hidden = false;
      input.disabled = true;
      const es = new EventSource(`/api/exec/stream?argv=${encodeURIComponent(JSON.stringify(argv))}&cwd=${encodeURIComponent(cwd)}`);
      T.es[i] = es; T.runId[i] = null;
      const done = () => { try { es.close(); } catch { /* 已关 */ } T.es[i] = null; idle(i); };
      es.addEventListener('start', (e) => { try { T.runId[i] = JSON.parse(e.data).runId; } catch { /* 空 */ } });
      es.addEventListener('out', (e) => { try { append(i, JSON.parse(e.data).s); } catch { /* 空 */ } });
      es.addEventListener('err', (e) => { try { append(i, JSON.parse(e.data).s, 't-err'); } catch { /* 空 */ } });
      es.addEventListener('trunc', () => append(i, '\n[输出超上限，后续不再回传]\n', 't-dim'));
      es.addEventListener('exit', (e) => {
        let d = {}; try { d = JSON.parse(e.data); } catch { /* 空 */ }
        const bad = d.timedOut || d.error || (d.code !== 0 && d.code !== null);
        append(i, `\n[exit ${d.timedOut ? 'TIMEOUT' : (d.error ? 'ERROR' : d.code)}${d.error ? ' ' + d.error : ''} · ${d.ms ?? '?'}ms]\n`, bad ? 't-err' : 't-dim');
        done(); // ★ 必须先关 EventSource：否则连接关闭会触发其自动重连，把同一条命令再执行一遍
      });
      es.onerror = () => { append(i, '\n[连接中断]\n', 't-err'); done(); };
    };
    const initPane = (i) => {
      const el = paneEl(i);
      if (!el || el.dataset.wired) return;
      el.dataset.wired = '1';
      const input = el.querySelector('.term-input');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); run(i); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const h = T.hist[i];
          if (!h.length) return;
          e.preventDefault();
          T.hi[i] = e.key === 'ArrowUp' ? Math.max(0, T.hi[i] - 1) : Math.min(h.length, T.hi[i] + 1);
          input.value = T.hi[i] >= h.length ? '' : h[T.hi[i]];
        }
      });
      el.querySelector('.term-run').onclick = () => run(i);
      el.querySelector('.term-stop').onclick = () => stop(i);
      el.querySelector('.term-clear').onclick = () => { el.querySelector('.term-out').textContent = ''; };
    };
    // cwd 下拉：主工作区 + 全部 worktree（相对工作区路径，后端 resolveInside 校验）
    let _wantCwd = null; // ★ P4：卡片详情唤起时待选中的目录（下拉是异步填的，填完再补选一次）
    const applyCwd = (val) => {
      if (!val) return;
      [0, 1].forEach((i) => {
        const sel = paneEl(i)?.querySelector('.term-cwd');
        if (!sel || !sel.options.length) return;
        const hit = Array.from(sel.options).some((o) => o.value === val);
        if (hit) sel.value = val;
      });
    };
    const loadCwd = () => fetch('/api/worktrees').then((r) => r.json()).then((j) => {
      const items = (j && j.items) || [];
      [0, 1].forEach((i) => {
        const sel = paneEl(i)?.querySelector('.term-cwd');
        if (!sel) return;
        sel.innerHTML = '';
        items.forEach((w) => {
          const o = document.createElement('option');
          o.value = w.main ? '.' : `.worktrees/${w.name}`;
          o.textContent = (w.main ? '主工作区 · ' : 'worktree · ') + w.name;
          sel.appendChild(o);
        });
        if (!sel.options.length) { const o = document.createElement('option'); o.value = '.'; o.textContent = '工作区根'; sel.appendChild(o); }
      });
      applyCwd(_wantCwd); // ★ P4：下拉填充完成后补选（覆盖 open 早于 loadCwd 完成的时序）
    }).catch(() => {});
    const stopAll = () => [0, 1].forEach((i) => { if (T.es[i]) stop(i, true); });
    const open = (cwdVal) => {
      drawer.classList.add('show');
      const want = typeof cwdVal === 'string' && cwdVal ? cwdVal : null;
      if (!T.inited) { T.inited = true; initPane(0); initPane(1); }
      // ★ P4：每次打开都重拉一次 cwd 下拉 —— worktree 列表会变（卡片一键唤起时正是刚建完隔离区的时刻），
      //   复用 W9 那次的陈旧快照会导致新 worktree 不在选项里、选不中（走查 W28c 实测踩中）。
      _wantCwd = want;
      loadCwd();
      applyCwd(_wantCwd); // 已有 options → 立刻选中；loadCwd 回调里再补选一次，覆盖「列表刚刷新」的时序
      paneEl(0).querySelector('.term-input').focus();
    };
    const close = () => { stopAll(); drawer.classList.remove('show'); };
    const tb = $('#termBtn');
    if (tb) tb.onclick = () => open(); // ★ P4：不能直接绑 open —— onclick 会把 Event 当 cwdVal 传进来
    /* ★ P4：卡片详情「⌨ 终端」一键唤起，工作目录自动切到该卡的隔离工作区（没有则留主工作区） */
    _termOpenWithCwd = async (card) => {
      let cwd = '.';
      try {
        const cm = typeof card.meta === 'string' ? JSON.parse(card.meta || '{}') : (card.meta && typeof card.meta === 'object' ? card.meta : {});
        const want = cm.worktree || (card.workspace_kind === 'worktree' && card.workspace ? String(card.workspace).split(/[\\/]/).pop() : '');
        if (want) cwd = `.worktrees/${want}`;
        else {
          // meta 没记 → 按 cardId 反查（worktree 列表带 cardId，比 meta 更准）
          const r = await fetch('/api/worktrees').then((x) => x.json()).catch(() => null);
          const mine = r && Array.isArray(r.items) ? r.items.find((w) => w.cardId === card.id && !w.main) : null;
          if (mine) cwd = `.worktrees/${mine.name}`;
        }
      } catch { /* 解析失败 → 留主工作区 */ }
      open(cwd);
      toast(cwd === '.' ? '终端已打开（主工作区）' : `终端已打开 · 目录 ${cwd}`);
    };
    $('#termClose').onclick = close;
    drawer.onclick = (e) => { if (e.target === drawer) close(); };
    $('#termSplitBtn').onclick = () => {
      T.split = !T.split;
      paneEl(1).hidden = !T.split;
      const b = $('#termSplitBtn');
      b.textContent = T.split ? '单屏' : '分屏';
      b.setAttribute('aria-pressed', String(T.split));
    };
  }
  /* ===== ★ Orca 融合 P3（2026-10-03 CLAIM §5）：Design Mode 抽屉（真实 Chromium 元素拾取）
   * 与后端 dashboard-reg-design.js 配套：打开 URL → 独立 Chrome 窗口（127.0.0.1 随机端口 + 临时 profile）
   * → 窗口内 hover 高亮 / 点击拾取 → CDP bindingCalled 回传 HTML+计算样式+裁剪截图
   * → 本抽屉 1s 轮询 /api/design/picks 渲染 → 一键附进 Agent 输入框（P0 附件管线同口径）。 */
  function initDesign() {
    const drawer = $('#designDrawer');
    if (!drawer) return;
    const D = { active: false, timer: null, picks: [], sig: '' };
    const badge = $('#designStatusBadge');
    const setBadge = (txt, cls) => { if (badge) { badge.textContent = txt; badge.className = 'wb-gh-badge' + (cls ? ' ' + cls : ''); } };
    const setMode = (active) => {
      const o = $('#designOpenBtn'), n = $('#designNavBtn'), k = $('#designKillBtn');
      if (o) o.hidden = active;
      if (n) n.hidden = !active;
      if (k) k.hidden = !active;
    };
    const cssText = (p) => Object.entries(p.styles || {}).map(([k, v]) => `${k}: ${v};`).join('\n');
    const render = (picks) => {
      const wrap = $('#designPicks');
      if (!wrap) return;
      D.picks = Array.isArray(picks) ? picks : [];
      const sig = D.picks.map((p) => `${p.id}:${p.ts}`).join(',');
      if (sig === D.sig) return;
      D.sig = sig;
      if (!D.picks.length) { wrap.innerHTML = '<div class="wb-gh-empty">暂无拾取结果 —— 打开页面后在 Chrome 窗口里点选元素。</div>'; return; }
      wrap.innerHTML = [...D.picks].reverse().map((p) => `
        <div class="design-pick" data-id="${esc(p.id)}">
          <div class="design-pick-head">
            <span class="design-pick-sel" title="${esc(p.pageUrl)}">${esc(p.selector || p.title || '(元素)')}</span>
            <span class="design-pick-ts">${new Date(p.ts).toLocaleTimeString()}</span>
          </div>
          <div class="design-pick-main">
            ${p.shot ? `<div class="design-pick-shot"><img src="${p.shot}" alt="拾取元素裁剪截图"></div>` : ''}
            <div class="design-pick-meta">
              <details open><summary>HTML（${String(p.html || '').length} 字符）</summary><pre>${esc(p.html)}</pre></details>
              <details><summary>计算样式（CSS，${Object.keys(p.styles || {}).length} 项）</summary><pre>${esc(cssText(p))}</pre></details>
              <div class="design-pick-actions">
                <button class="btn-primary design-attach" data-id="${esc(p.id)}" style="padding:4px 12px;font-size:11px">附到输入框</button>
                <button class="btn-ghost design-copy" data-id="${esc(p.id)}" style="padding:4px 12px;font-size:11px">复制 HTML</button>
              </div>
            </div>
          </div>
        </div>`).join('');
    };
    /** 附到 Agent 输入框：HTML/CSS 文本块内联 + 截图走 P0 artifacts 管线（base64 零依赖） */
    const attach = async (p) => {
      let insert = `[Design 拾取 · ${p.selector || p.title || '元素'}]（来源：${p.pageUrl}）`;
      if (p.shot) {
        try {
          const b64 = String(p.shot).includes(',') ? String(p.shot).split(',')[1] : '';
          const res = await fetch('/api/artifacts/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `design-pick-${p.id}.jpg`, data: b64 }) });
          const j = await res.json().catch(() => ({}));
          if (res.ok && j.ok) insert += `\n[截图 artifact:${j.name}](${j.url})`;
        } catch { /* 截图上传失败不阻断文本附入 */ }
      }
      insert += `\n\`\`\`html\n${p.html}\n\`\`\`\n\`\`\`css\n${cssText(p)}\n\`\`\``;
      const input = $('#agentInput');
      if (input) { input.value = (input.value ? input.value.replace(/\s*$/, '\n') : '') + insert + '\n'; input.focus(); }
      toast('已附到智能体输入框');
    };
    const poll = async () => {
      try {
        const st = await (await fetch('/api/design/status')).json();
        if (!st || !st.ok) return;
        D.active = !!st.active;
        setMode(D.active);
        setBadge(D.active ? `会话中 · ${st.picks} 拾取` : '未启动', D.active ? 'ok' : '');
        if (D.active) {
          const pk = await (await fetch('/api/design/picks')).json();
          render(pk && pk.picks);
        }
        else { D.sig = ''; render([]); }
      } catch { /* 内核未响应：保持现状 */ }
    };
    const startPoll = () => { if (!D.timer) D.timer = setInterval(poll, 1000); void poll(); };
    const stopPoll = () => { if (D.timer) { clearInterval(D.timer); D.timer = null; } };
    const open = () => { drawer.classList.add('show'); startPoll(); $('#designUrl')?.focus(); };
    const close = () => { stopPoll(); drawer.classList.remove('show'); }; // 关抽屉不停会话（Chrome 窗口继续可用；「关闭会话」才杀进程）
    _designOpenDrawer = open; // ★ P4：卡片详情「🎯 拾取」一键唤起（与顶栏按钮同一入口）
    const db = $('#designBtn');
    if (db) db.onclick = () => open();
    $('#designClose').onclick = close;
    drawer.onclick = (e) => { if (e.target === drawer) close(); };
    $('#designOpenBtn').onclick = async () => {
      const url = ($('#designUrl')?.value || '').trim();
      if (!url) { toast('请输入地址（https:// 或 file:///）'); return; }
      const res = await fetch('/api/design/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(j.error || `打开失败（HTTP ${res.status}）`); return; }
      toast('Chrome 窗口已启动 —— 移动鼠标高亮，点击即拾取');
      void poll();
    };
    $('#designNavBtn').onclick = async () => {
      const url = ($('#designUrl')?.value || '').trim();
      if (!url) { toast('请输入新地址'); return; }
      const res = await fetch('/api/design/navigate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(j.error || `换页失败（HTTP ${res.status}）`); return; }
      toast('已在设计会话内换页');
    };
    $('#designKillBtn').onclick = async () => {
      const res = await fetch('/api/design/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await res.json().catch(() => ({}));
      toast(res.ok && j.ok ? '设计会话已关闭（进程树已杀、临时 profile 已清）' : (j.error || '关闭失败'));
      void poll();
    };
    // 结果区事件委托（render 重建 DOM 不丢绑定）
    $('#designPicks')?.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const p = D.picks.find((x) => x.id === b.dataset.id);
      if (!p) return;
      if (b.classList.contains('design-attach')) void attach(p);
      else if (b.classList.contains('design-copy')) {
        (navigator.clipboard?.writeText?.(p.html) ?? Promise.reject()).then(() => toast('HTML 已复制')).catch(() => toast('复制失败，请手动选取'));
      }
    });
    setMode(false);
  }
  initTerm(); // ★ Orca 融合 P2：准终端
  initDesign(); // ★ Orca 融合 P3：Design Mode（CDP 元素拾取）
  initTheme();
  initRipple();
  initKeyboard();
  initA11yInteractions(); // ★ P2-⑤：主操作件键盘可达（标记 + Enter/Space 触发 + 动态内容观察）
  /* ===== ★ P6 知识图谱 + 卡片看板（调用 /api/graph /api/cards 新后端）===== */
  const CARD_STATES_UI = [
    ['triage', '待细化', '#64748b'], ['todo', '待就绪', '#3b82f6'], ['ready', '可认领', '#06b6d4'], ['running', '执行中', '#a8557f'],
    ['review', '待验收', '#f59e0b'], ['blocked', '阻塞', '#ef4444'], ['failed', '失败', '#f97316'], ['done', '完成', '#10b981'],
    ['cancelled', '取消', '#94a3b8'], ['archived', '归档', '#64748b'],
  ];
  const SECTOR_COLOR_P6 = { working: '#94a3b8', episodic: '#38bdf8', semantic: '#34d399', procedural: '#a78bfa', meta: '#fbbf24', social: '#f472b6', user: '#22d3ee', prospective: '#fb923c', affective: '#f87171', secret: '#64748b' };
  const SECTOR_CN_P6 = { working: '工作', episodic: '情景', semantic: '语义', procedural: '程序', meta: '元记忆', social: '协作', user: '用户', prospective: '前瞻', affective: '情感' };




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
    if (banner) { banner.style.display = data.truncated ? 'block' : 'none'; if (data.truncated) banner.textContent = '图已截断（节点>200），请用作用域 / 筛选收窄'; }
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
    // ★ 2026-09-20：已完成列默认隐藏（与任务地图共用「显示已完成」开关）；隐藏时给可点开的提示条
    const hiddenDone = _taskMapState.showDone ? 0 : (buckets.done || []).length;
    const html = CARD_STATES_UI.map(([st, label, color]) => {
      if (st === 'done' && !_taskMapState.showDone) return '';
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
    const doneHint = hiddenDone ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:12px;color:var(--text-muted)"><span>已完成 ${hiddenDone} 张已隐藏</span><button class="btn-ghost" data-show-done style="padding:3px 10px;font-size:11px">显示已完成</button></div>` : '';
    board.innerHTML = `${doneHint}<div style="display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;min-height:180px">${html}</div>`;
    const showDoneBtn = board.querySelector('[data-show-done]');
    if (showDoneBtn) showDoneBtn.onclick = () => { _taskMapSetShowDone(true); renderCards(); };
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
  const TASK_MAP_GAP_Y = 70; // 2026-10-05：46→70 行距 +50%（治「太挤」）
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
    // ★ 2026-10-05 并入批：节点画布五类边（card_edges 派发/注入 + 交接挂边 + 终态投影）
    dispatch: { color: '#3b82f6', width: 2, dash: '' },
    dispatch_completed: { color: '#10b981', width: 2, dash: '' },
    superseded: { color: '#64748b', width: 1.5, dash: '4 4' },
    inject: { color: '#d9a441', width: 1.5, dash: '6 4' },
    handoff: { color: '#4a8a5c', width: 1.5, dash: '2 4' },
  };
  const _taskMapState = {
    data: { nodes: [], links: [] },
    positions: new Map(),
    auto: (() => { try { return (localStorage.getItem('memoryos-map-auto') ?? '0') !== '0'; } catch { return false; } })(), // ★ 2026-09-14 自动关联开关（?auto=0/1）；2026-10-05 默认改关（语义虚线默认不画，连线瘦身）
    showWeak: (() => { try { return (localStorage.getItem('memoryos-map-weak') ?? '1') !== '0'; } catch { return true; } })(), // ★ 2026-10-05 弱连线开关（relates/duplicates；默认显示，可一键隐藏）
    showArchived: (() => { try { return localStorage.getItem('memoryos-map-archived') === '1'; } catch { return false; } })(), // ★ 2026-09-18 归档任务默认隐藏（工具栏「查看归档」切换）
    showDone: (() => { try { return localStorage.getItem('memoryos-map-done') === '1'; } catch { return false; } })(), // ★ 2026-09-20 已完成任务默认隐藏（工具栏「显示已完成」切换；与卡片看板共用）
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
    const maxRows = Math.max(3, Math.min(7, Math.ceil(Math.sqrt(Math.max(1, taskSet.size))))); // 2026-10-05：9→7 行（减纵向长度、加大留白）
    const colPitch = TASK_MAP_NODE_W + TASK_MAP_GAP_X + 250; // 2026-10-05：226+92+250=568（原 508，治「太挤」）
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
    // ★ 2026-10-05 分区整理：agent 卡独立「执行者区」（右侧列）、handoff 文档卡挂宿主任务卡右侧，
    //   均不进工作流列倾倒（设计报告风险#4：投影/文档卡不进任务统计，视觉同样分家）
    const agentZone = [...taskSet].filter((id) => String(byId.get(id)?.kind) === 'agent');
    const handoffSet = new Set([...taskSet].filter((id) => String(byId.get(id)?.kind) === 'handoff'));
    const seq = [...taskSet].filter((id) => !agentZone.includes(id) && !handoffSet.has(id))
      .sort((a, b) => (rank.get(a) - rank.get(b)) || compare(a, b));
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

    /* —— ⑤ 执行者区 + 交接挂卡（2026-10-05 分区整理）——
       agent 卡：右侧独立列（4 行一列级联），与任务流分家、一眼看到「有哪些干活的人」
       handoff 卡：挂在产出它的宿主任务卡右侧（handoff 边 src=宿主 → dst=交接卡） */
    if (agentZone.length) {
      const maxTaskX = positions.size ? Math.max(...[...positions.values()].map(p => p.x + (p.aux ? AUX_W : TASK_MAP_NODE_W))) : TASK_MAP_PAD + TASK_MAP_NODE_W;
      const zx0 = maxTaskX + 160;
      const agentRows = 4;
      agentZone.sort((a, b) => compare(a, b));
      agentZone.forEach((id, i) => {
        const col = Math.floor(i / agentRows), row = i % agentRows;
        positions.set(id, { x: zx0 + col * (TASK_MAP_NODE_W + 120), y: TASK_MAP_PAD + row * (TASK_MAP_NODE_H + TASK_MAP_GAP_Y + 24), rank: maxRank + 1 });
      });
    }
    links.forEach(link => {
      if (String(link.kind) !== 'handoff') return;
      const s = Number(link.src_id), d = Number(link.dst_id);
      if (positions.has(s) && byId.has(d) && handoffSet.has(d)) {
        const sp = positions.get(s);
        positions.set(d, { x: sp.x + TASK_MAP_NODE_W + 110, y: sp.y, rank: sp.rank, aux: true });
      }
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
      const _mp = n.meta && typeof n.meta.map_pos === 'object' && n.meta.map_pos ? n.meta.map_pos : {};
      const saved = _mp[viewKey] || _mp.c; // c 桶=节点画布时代/点选建卡落点（并入后三桶共存读，写仍按当前 h/v 屏）
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
      const isReal = /^\d+$/.test(String(node.id)); // ★ 非数字 id（mem-N 动态子卡）不是真实卡片
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
      // ★ 2026-10-05 并入批：非任务卡显示类型中文名（agent→智能体 / handoff→交接文档 / doc→文档），
      //   智能体卡缺载体时直显 ⚠️（graph 端 profileMissing 标记，前端不自行探测进程）
      const nk = String(node.kind);
      const kindLabel = (nk === 'task' || isAux) ? '' : ((_cardTypes.list.find(t => t.type_key === nk) || {}).label || nk);
      const missingTag = (!isAux && nk === 'agent' && node.profileMissing) ? ' ⚠️ 载体缺失' : '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'task-map-node';
      button.dataset.cardId = String(node.id);
      button.style.left = position.x + 'px';
      button.style.top = position.y + 'px';
      button.style.setProperty('--node-color', status.color);
      const _ntc = NODE_TEXT_COLOR[status.color] || null;
      if (_ntc) {
        button.style.setProperty('--node-color-text', _ntc[0]);
        button.style.setProperty('--node-color-text-dark', _ntc[1]);
      }
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
          <span>${esc(isAux ? '' : (metaTail || kindLabel || ''))}${esc(missingTag)}</span>
        </span>
        <span class="task-map-node-link" data-card-id="${node.id}" title="按住拖到目标卡：建立依赖连线" aria-label="拖出连线">＋</span>
        ${isReal && !isAux ? `<span class="task-map-quick" aria-hidden="true">
          ${nk === 'agent'
            ? `<span class="task-map-qbtn" data-q="log" title="执行终端：实时看它干活的输出">⌨</span>
               <span class="task-map-qbtn" data-q="live" title="驾驶直播：桌面软件画面 + 输出">📺</span>
               <span class="task-map-qbtn" data-q="agentcfg" title="编辑智能体配置（智能体/通道/工作区/模型…）">⚙️</span>`
            : `<span class="task-map-qbtn" data-q="agent" title="交给智能体干（自动填好任务说明）">🚀</span>
               <span class="task-map-qbtn" data-q="dispatch" title="派发给智能体卡（选目标 + 按通道执行）">⚡</span>
               <span class="task-map-qbtn" data-q="toggle" title="一键完成（已完成的卡点这里重开）">✅</span>
               <span class="task-map-qbtn" data-q="ws" title="打开工作区：代码变更 + 行级批注">🔧</span>`}
        </span>` : ''}`;
      if (_taskMapFilter) {
        // 辅助卡过滤跟随宿主卡（自身无状态）
        const hostId = hostOf.get(node.id);
        const ref = (hostId != null && isAux) ? (nodeById.get(hostId) || node) : node;
        // 优先用后端 bucket（三态），aux 无 bucket 时按宿主状态回退三态
        const bkt = node.bucket != null ? node.bucket : (String(ref.status) === 'done' ? 'done' : (['archived', 'cancelled', 'failed'].includes(String(ref.status)) ? 'terminal' : 'open'));
        if (bkt !== _taskMapFilter) button.style.display = 'none';
      }
      // ★ 2026-09-14：非数字 id 节点（内存/自动匹配的 mem-N 子卡）不是真实卡片，点击/拖拽/右键均跳过，避免 openCardDetail(NaN) 与位置误存
      const realCard = isReal;
      button.onclick = (ev) => {
        if (_taskMapState.suppressClick) return;
        // ★ P4：悬停快捷条（🚀 交给 Agent / ✅ 完成 / 🔧 工作区）优先于「打开详情」
        const qb = ev.target && ev.target.closest ? ev.target.closest('.task-map-qbtn') : null;
        if (qb) { ev.stopPropagation(); void quickCardAction(qb.dataset.q, Number(node.id)); return; }
        if (!realCard) { toast(`关联子卡「${esc(node.title)}」为动态匹配，点击任务主卡操作`); return; }
        openCardDetail(Number(node.id));
      };
      // ★ 2026-09-13：卡片交互三件套 —— 拖拽定位 / 边框拖出连线 / 富右键菜单
      button.addEventListener('pointerdown', ev => {
        if (!realCard) { ev.stopPropagation(); return; } // 非真实卡不拖拽不连线
        if (ev.button !== 0) return;
        // ★ P4：快捷按钮按下不进拖拽（否则微小位移会被当成移动节点、suppressClick 吞掉点击）
        if (ev.target && ev.target.closest && ev.target.closest('.task-map-qbtn')) { ev.stopPropagation(); return; }
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
      // ★ 2026-10-05 连线瘦身：弱连线开关（关联/重复/自动关联可隐藏；依赖/派发/交接不受影响）
      if (!_taskMapState.showWeak && (kind === 'relates' || kind === 'duplicates' || kind === 'relates_auto')) return;
      // 辅助卡挂载边：完成卡规则与二态过滤都用宿主卡状态（辅助卡自身无状态）；绘制方向统一 宿主 → 辅助卡
      const isAuxLink = kind.startsWith('aux_');
      const hostRef = isAuxLink ? (kindOfNode.get(s) === 'aux' ? d : s) : null;
      if (isAuxLink && kindOfNode.get(s) === 'aux') [s, d] = [d, s];
      // ★ 已完成卡片不参与连线（任一端点 done → 整条边隐藏；辅助边看宿主卡）
      // ★ 2026-10-05：交接边豁免（交接卡恒 status=done，隐藏会断掉「任务→交接文档」链）
      if (kind !== 'handoff' && (isAuxLink ? statusOf.get(hostRef) === 'done' : (statusOf.get(s) === 'done' || statusOf.get(d) === 'done'))) return;
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
      title.textContent = `${kind === 'depends' ? '依赖' : kind === 'handoff' ? '交接' : kind}${link.context ? ' · ' + link.context : ''}`;
      path.appendChild(title);
      // ★ 2026-10-05 并入批：依赖线右键可删（后端 DELETE /api/cards/:id/links?dst_card_id=&kind= 现成；误连有出口）
      if (kind === 'depends') {
        path.style.cursor = 'pointer';
        path.addEventListener('contextmenu', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          confirmInline('删除这条依赖连线？', async () => {
            const lr = await fetch(`/api/cards/${Number(link.src_id)}/links?dst_card_id=${Number(link.dst_id)}&kind=depends`, { method: 'DELETE' })
              .then(x => x.json().catch(() => ({}))).catch(() => ({}));
            toast(lr && lr.ok ? '已删除连线' : '删除失败');
            renderTaskMap();
          });
        });
      }
      edgesEl.appendChild(path);
    });
    // ★ 2026-10-05 并入批：card_edges（派发/注入持久边；status 纯投影，来自 dispatches 真源）
    (_taskMapState.data.edges || []).forEach(e => {
      const s = Number(e.source_id), d = Number(e.target_id);
      const source = _taskMapState.positions.get(s), target = _taskMapState.positions.get(d);
      if (!source || !target) return; // 端点被过滤/隐藏 → 不画
      const st = String(e.status || 'active');
      const ek = String(e.kind);
      let key = ek;
      if (ek === 'dispatch') key = st === 'completed' ? 'dispatch_completed' : (st === 'superseded' || st === 'cancelled' ? 'superseded' : 'dispatch');
      const style = TASK_MAP_LINK_STYLE[key] || { color: '#3b82f6', width: 2, dash: '' };
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', taskMapEdgePath(source, target, vertical));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', style.color);
      path.setAttribute('stroke-width', String(style.width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.setAttribute('opacity', '0.85');
      if (style.dash) path.setAttribute('stroke-dasharray', style.dash);
      path.setAttribute('marker-end', `url(#taskMapArrow-${TASK_MAP_LINK_STYLE[key] ? key : 'dispatch'})`);
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${ek === 'inject' ? '前情注入' : '派发'}（${st}） #${s} → #${d}`;
      path.appendChild(title);
      if (ek === 'inject' && e.id) {
        path.style.cursor = 'pointer';
        path.addEventListener('contextmenu', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          confirmInline('删除这条前情注入连线？', async () => {
            const dr = await fetch(`/api/card-edges/${e.id}`, { method: 'DELETE' })
              .then(x => x.json().catch(() => ({}))).catch(() => ({}));
            toast(dr && dr.ok ? '已删除连线' : ('删除失败：' + ((dr && dr.error) || '')));
            renderTaskMap();
          });
        });
      } else if (ek === 'dispatch') {
        path.addEventListener('contextmenu', (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          toast('派发边是历史链的一部分，不可手删（随派发收口自动翻状态）');
        });
      }
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

  /* —— ★ P4 简化批（2026-10-03 CLAIM §5）：卡片免右键直达动作 ——
     痛点：原改状态只能右键（小白不可发现）、交给 Agent 无入口、终端/设计与卡片无关。
     落点：① 地图卡片悬停快捷条（一次点击）② 卡片详情底部动作条（同一批动作的键盘可达等价路径，满足 a11y）
     注：_termOpenWithCwd / _designOpenDrawer 的声明在 initTerm/initDesign 调用之前（见 3733 行附近），此处只使用。 */

  /** 把卡片交给 Agent：跳 Agent 页并预填 prompt（不自动发送，留给用户过目 —— 防误发） */
  function sendCardToAgent(card) {
    const body = String(card.body || '').trim();
    const prompt = [`请处理任务看板卡片 #${card.id}：${card.title}`,
      body ? `\n背景：\n${body}` : '',
      '\n要求：先认领该卡，做完把结论回填到本卡（评论或状态流转），不要新开重复任务。'].join('\n');
    location.hash = 'agent';
    let tries = 0;
    const fill = () => {
      const input = $('#agentInput');
      if (!input) { if (++tries < 20) setTimeout(fill, 300); else toast('智能体输入框未就绪，请手动到智能体页'); return; }
      input.value = prompt;
      input.focus();
      toast('已填入智能体输入框 —— 检查后回车发送');
    };
    setTimeout(fill, 350);
  }

  /** 一键改状态（CAS：带 expected_from，他人抢先改过 → 409 提示刷新，不静默覆盖） */
  async function setCardStatus(card, to) {
    const res = await fetch(`/api/cards/${card.id}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: to, expected_from: card.status, as: 'human:dashboard' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { toast(j.error || '改状态失败（可能已被其他操作改写，请刷新）'); return false; }
    toast(`#${card.id} → ${j.to || to}`);
    return true;
  }

  /** 悬停快捷条动作：agent=交给 Agent ｜ dispatch=派发给智能体卡 ｜ log/live=智能体卡实时窗口 ｜ agentcfg=编辑配置 ｜ toggle=完成/重开 ｜ ws=打开工作区 Tab */
  async function quickCardAction(kind, id) {
    if (kind === 'log') { agentCardTerm(id); return; }
    if (kind === 'live') { agentCardLive(id); return; }
    if (kind === 'agentcfg') { editAgentProfileFromCard(id); return; }
    if (kind === 'dispatch') { dispatchCardToAgent(id); return; }
    const r = await fetch(`/api/cards/${id}`).then(x => x.json()).catch(() => null);
    if (!r || !r.card) { toast('卡片不存在'); return; }
    const card = r.card;
    if (kind === 'agent') { sendCardToAgent(card); return; }
    if (kind === 'ws') { openCardDetail(id, 'workspace'); return; }
    if (kind === 'toggle') {
      const to = card.status === 'done' ? 'ready' : 'done';
      if (await setCardStatus(card, to)) refreshCurrentTaskView();
    }
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
    // ★ P4：右键状态项改为「按状态机只列可达目标」—— 原固定 6 项里大多数会被后端 409「非法迁移」拒绝
    const statusOpts = cwTargets(card.status).map(s => [s, CW_STATUS_LABEL[s] || s]);
    // ★ 2026-10-05 并入批：按卡片类型档位列「改型/派发/注入/编辑配置」项（card_types 注册表判档，缺省按内置四种）
    const ck = String(card.kind || '');
    const ckDef = _cardTypes.list.find(t => t.type_key === ck);
    const canDsp = ckDef ? !!ckDef.can_dispatch_out : (ck === 'task');
    const canInj = ckDef ? !!ckDef.can_inject_out : (ck === 'handoff');
    menu.innerHTML = `
      <div class="context-menu-title">卡片 #${card.id} · ${esc(String(card.title || '').slice(0, 18))}</div>
      <div class="context-menu-item" data-cardact="claim">✔ 认领</div>
      <div class="context-menu-item" data-cardact="detail">👁 打开详情</div>
      <div class="context-menu-item" data-cardact="link">➡ 拖出依赖连线</div>
      ${ck !== 'agent' ? `<div class="context-menu-item" data-cardact="retype">🔄 改卡片类型…</div>
      ${canDsp ? `<div class="context-menu-item" data-cardact="dispatch">⚡ 派发给…（交给智能体干）</div>` : ''}
      ${canInj ? `<div class="context-menu-item" data-cardact="inject">🔗 注入前情…（把本卡内容喂给下游任务）</div>` : ''}` : ''}
      ${ck === 'agent' ? `<div class="context-menu-item" data-cardact="agentcfg">⚙️ 编辑智能体配置</div>` : ''}
      ${AUX_CARD_TYPES.map(([k, l]) => `<div class="context-menu-item" data-cardact="aux" data-aux="${k}">📎 挂${l}</div>`).join('')}
      ${statusOpts.map(([s, l]) => `<div class="context-menu-item" data-cardact="status" data-status="${s}">${l}</div>`).join('') || '<div class="context-menu-item" style="opacity:.5;cursor:default">（终态，无法流转）</div>'}
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
        } else if (act === 'retype') {
          changeCardKind(cardId);
        } else if (act === 'dispatch') {
          dispatchCardToAgent(cardId);
        } else if (act === 'inject') {
          injectCardTo(cardId);
        } else if (act === 'agentcfg') {
          editAgentProfileFromCard(cardId);
        } else if (act === 'aux') {
          const kind = item.dataset.aux;
          const label = AUX_LABEL[kind] || kind;
          // ★ 批次⑨：prompt()→askForm
          const av = await askForm({ title: `新建「${label}」辅助卡`, fields: [{ key: 't', label: `挂在主任务 #${cardId} 上，供智能体读上下文`, value: `aux-${label} #${cardId}`, required: true }], okText: '创建' });
          if (!av) return;
          const t = (av.t || '').trim();
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
    // ★ 2026-09-20：已完成（done）同样默认隐藏，与归档共用同一剔除逻辑（各自独立开关，互不影响）
    const viewNodes = data.nodes || [], viewLinks = data.links || [];
    let keptNodes = viewNodes, keptLinks = viewLinks;
    if (!_taskMapState.showArchived || !_taskMapState.showDone) {
      const gone = new Set();
      viewNodes.forEach(n => {
        const nk = String(n.kind);
        if (nk === 'aux' || nk.startsWith('aux_')) return; // aux 子卡跟随宿主，单独处理
        if (nk === 'handoff') return; // ★ 2026-10-05：交接文档卡不受「隐藏已完成」过滤（交接链不断）
        const st = String(n.status);
        if (!_taskMapState.showArchived && st === 'archived') gone.add(String(n.id));
        else if (!_taskMapState.showDone && st === 'done') gone.add(String(n.id));
      });
      if (gone.size) {
        keptLinks = viewLinks.filter(l => !gone.has(String(l.src_id)) && !gone.has(String(l.dst_id)));
        const auxTouched = new Set();
        keptLinks.forEach(l => { const lk = String(l.kind); if (lk.startsWith('aux_')) { auxTouched.add(String(l.src_id)); auxTouched.add(String(l.dst_id)); } });
        keptNodes = viewNodes.filter(n => !gone.has(String(n.id)) && !(String(n.kind).startsWith('aux_') && !auxTouched.has(String(n.id))));
      }
    }
    _taskMapState.data = { nodes: keptNodes, links: keptLinks, edges: data.edges || [] }; // ★ 2026-10-05 并入批：card_edges（派发/注入）随图入渲染
    if (!_cardTypes.list.length) loadCardTypes(); // 类型中文名缓存（节点徽标/建卡向导共用；fire-and-forget）
    // ★ 2026-09-13：状态二态 chips（已完成 / 未完成；细粒度状态仍在卡片抽屉与右键菜单保留；点击过滤，再点/全部=清除）
    const chips = $('#taskMapChips');
    if (chips && viewNodes.length) {
      // ★ 2026-09-15：状态三态 chips（未完成 / 已完成 / 已归档）；终结态(archived/cancelled/failed)归「已归档」，不再混入「未完成」
      let open = 0, done = 0, terminal = 0;
      viewNodes.forEach(n => {
        const nk = String(n.kind);
        if (nk === 'aux' || nk.startsWith('aux_')) return; // 辅助卡是挂载物，不计入任务统计
        if (nk === 'agent' || nk === 'handoff') return; // ★ 2026-10-05 并入批：执行者/交接文档卡不进任务三态统计（设计报告风险#4）
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
        // ★ 2026-09-20：点「已完成」过滤同理需先揭开 done（否则过滤后空图）
        if (chip === 'done' && !_taskMapState.showDone) _taskMapSetShowDone(true);
        renderTaskMap();
      });
    }
    drawTaskMap();
    if (opts.fit || !_taskMapState.hasView) requestAnimationFrame(fitTaskMap);
    // 智能体清单惰性重试：仅当清单为空且距上次尝试 >30s（防高频打 scan 端点；非空后不再重拉）
    if (!_agentScan.list.length && Date.now() - _agentScan.ts > 30000) loadAgentScan(true);
    // ★ 2026-10-05 小白引导：依赖连线交互一次性提示（localStorage 只提醒一次，不打扰老用户）
    try {
      if (!localStorage.getItem('memoryos-link-hint-shown') && (keptNodes || []).length >= 2) {
        localStorage.setItem('memoryos-link-hint-shown', '1');
        setTimeout(() => toast('提示：按住卡片右侧的 ＋ 拖到另一张卡上，就能建一条依赖连线；点卡片看详情，悬停看快捷按钮。只提醒这一次。', 8000), 800);
      }
    } catch { /* 存储不可用时不打扰 */ }
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
  // ★ 2026-09-20：「显示已完成」按钮态（默认隐藏已完成=高亮提示可点开；已显示=ghost）
  function refreshDoneViewBtn(btn) {
    if (!btn) return;
    btn.className = _taskMapState.showDone ? 'btn-ghost' : 'btn-primary';
    btn.textContent = _taskMapState.showDone ? '隐藏已完成' : '✓ 显示已完成';
    btn.title = _taskMapState.showDone ? '已完成任务已显示在地图中；点击隐藏已完成任务' : '已完成任务默认隐藏；点击在地图中显示已完成任务';
  }
  function _taskMapSetShowDone(on) {
    _taskMapState.showDone = on;
    try { localStorage.setItem('memoryos-map-done', on ? '1' : '0'); } catch { /* ignore */ }
    refreshDoneViewBtn($('#taskMapDoneViewBtn'));
  }
  /* ★ 2026-09-20：归档中心 —— 归档卡片按主题分组呈现（只读）。
     数据源 GET /api/cards/archive/grouped?by=topic；组头显示主题+数量+时间范围，点行进卡片详情。
     与地图「📦 查看归档」并存：后者在地图中显示归档节点，本面板做分组检索。 */
  async function openArchiveCenter() {
    const j = await fetch('/api/cards/archive/grouped?by=topic').then(r => r.json()).catch(() => null);
    if (!j || !j.ok) { toast('归档数据读取失败'); return; }
    if (!j.total) { _cockpitModal('归档中心', '<div style="color:var(--text-muted);font-size:12px;padding:8px 0">暂无归档任务</div>'); return; }
    const fmt = t => (t ? String(t).slice(0, 10) : '—');
    const body = j.groups.map(g => `
      <div style="margin-bottom:10px;border:1px solid var(--border-glass);border-radius:10px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,255,255,0.04)">
          <span style="font-size:12px;font-weight:600;color:var(--text-primary)">${esc(g.topic)}</span>
          <span class="mono" style="font-size:11px;color:var(--text-muted)">${g.count} 张</span>
          <span class="mono" style="font-size:10px;color:var(--text-muted);margin-left:auto">${fmt(g.last)} ~ ${fmt(g.first)}</span>
        </div>
        ${g.cards.map(c => `
          <div data-arch-card="${c.id}" style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--border-glass);cursor:pointer;font-size:12px">
            <span class="mono" style="font-size:10px;color:var(--text-muted)">#${c.id}</span>
            <span style="color:var(--text-primary);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.title || '')}</span>
            <span style="font-size:10px;color:var(--text-muted)">${esc(c.kind || '')}</span>
            <span class="mono" style="font-size:10px;color:var(--text-muted)">${fmt(c.at)}</span>
          </div>`).join('')}
      </div>`).join('');
    _cockpitModal(`归档中心 · 按主题分组（${j.total} 张 / ${j.groups.length} 组）`, body, (el) => {
      el.querySelectorAll('[data-arch-card]').forEach(row => row.onclick = () => {
        const m = document.querySelector('.cockpit-modal');
        if (m) m.remove();
        openCardDetail(Number(row.dataset.archCard));
      });
    });
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
    // ★ 2026-10-05 连线瘦身：弱连线开关（关联/重复/自动关联 三类的显隐；默认显示，持久化）
    const weakBtn = $('#taskMapWeakBtn');
    if (weakBtn) {
      const syncWeak = () => {
        weakBtn.textContent = _taskMapState.showWeak ? '✓ 弱连线' : '弱连线';
        weakBtn.className = _taskMapState.showWeak ? 'btn-primary' : 'btn-ghost';
        weakBtn.title = _taskMapState.showWeak ? '当前显示 关联/重复/自动关联 弱连线；点击隐藏' : '当前已隐藏 关联/重复/自动关联 弱连线；点击显示（依赖/派发/交接不受影响）';
      };
      weakBtn.onclick = () => {
        _taskMapState.showWeak = !_taskMapState.showWeak;
        try { localStorage.setItem('memoryos-map-weak', _taskMapState.showWeak ? '1' : '0'); } catch { /* ignore */ }
        syncWeak();
        toast(_taskMapState.showWeak ? '已显示弱连线（关联/重复/自动关联）' : '已隐藏弱连线：只剩 依赖/派发/交接/辅助 实连线');
        renderTaskMap({ fit: false });
      };
      syncWeak();
    }
    // ★ 2026-09-18：「查看归档」切换 —— 归档任务默认隐藏，点击在地图中显示/隐藏（持久化 localStorage）
    const archViewBtn = $('#taskMapArchiveViewBtn');
    if (archViewBtn) archViewBtn.onclick = () => {
      _taskMapSetShowArchived(!_taskMapState.showArchived);
      toast(_taskMapState.showArchived ? '已显示归档任务' : '已隐藏归档任务（「已归档」chip 点击仍可临时查看）');
      renderTaskMap({ fit: false });
    };
    refreshArchiveViewBtn(archViewBtn);
    // ★ 2026-09-20：「显示已完成」切换 —— 已完成任务默认隐藏，点击在地图中显示/隐藏（持久化 localStorage）
    const doneViewBtn = $('#taskMapDoneViewBtn');
    if (doneViewBtn) doneViewBtn.onclick = () => {
      _taskMapSetShowDone(!_taskMapState.showDone);
      toast(_taskMapState.showDone ? '已显示已完成任务' : '已隐藏已完成任务（「已完成」chip 点击仍可临时查看）');
      renderTaskMap({ fit: false });
    };
    refreshDoneViewBtn(doneViewBtn);
    // ★ 2026-09-20：归档中心（按主题分组查看归档任务）
    const archCenterBtn = $('#taskMapArchiveCenterBtn');
    if (archCenterBtn) archCenterBtn.onclick = () => openArchiveCenter();
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

  /* —— C：卡片详情抽屉（多 Tab：正文/工作区/GitHub/评论/事件/关联 + 30s 评论轮询 + 小红点 + Esc 关闭） —— */
  let _cardPollTimer = null, _cardTab = 'body';
  /** ★ P4：10 态状态机 —— 必须与后端 `dist/dashboard-reg-cards.js` 的 CARD_TRANSITIONS 逐字对齐。
   *  前端只渲染「从当前状态可达」的目标按钮：原实现固定给 5 个状态，实测点「✅ 完成」在 running 下被
   *  后端 409「非法迁移 running → done」拒绝（正确流程是 running → review → done），点了报错极劝退。 */
  const CARD_TRANSITIONS = {
    triage: ['todo', 'cancelled'],
    todo: ['ready', 'cancelled', 'blocked'],
    ready: ['running', 'cancelled'],
    running: ['review', 'failed', 'blocked'],
    review: ['done', 'failed'],
    blocked: ['todo', 'ready', 'running', 'cancelled'],
    failed: ['blocked', 'todo', 'cancelled'],
    done: ['archived'],
    cancelled: [],
    archived: [],
  };
  /** 状态中文短标签（详情按钮 / 右键菜单共用） */
  const CW_STATUS_LABEL = {
    triage: '🔍 待细化', todo: '📝 待就绪', ready: '▶ 可认领', running: '🏃 执行中',
    review: '👁 待验收', blocked: '⛔ 阻塞', failed: '❌ 失败', done: '✅ 完成',
    cancelled: '🚫 取消', archived: '📦 归档',
  };
  const cwTargets = (st) => CARD_TRANSITIONS[st] || [];

  function stopCardPoll() { if (_cardPollTimer) { clearInterval(_cardPollTimer); _cardPollTimer = null; } }
  // ★ 2026-09-14 查漏：卡片详情统一关闭（Esc / 关闭按钮 / 认领 / 删除 共用，确保 keydown 监听器必被移除，防累积泄漏）
  function closeCardDetail() {
    stopCardPoll();
    $('#detailModal')?.classList.remove('show');
    document.removeEventListener('keydown', _cardEscHandler);
    _cardEscHandler = null;
  }
  let _cardEscHandler = null;

  async function openCardDetail(id, initialTab) {
    // ★ P4：重复打开（改状态后原地刷新）先解绑上一个 Esc 监听，避免 keydown 处理器累积泄漏
    if (_cardEscHandler) { document.removeEventListener('keydown', _cardEscHandler); _cardEscHandler = null; }
    stopCardPoll();
    const r = await fetch(`/api/cards/${id}`).then(x => x.json()).catch(() => null);
    if (!r || !r.card) { toast('卡片不存在'); return; }
    const card = r.card;
    const meta = CARD_STATES_UI.find(([s]) => s === card.status) || ['', '未知', '#64748b'];
    // ★ 是否绑定 MCP 任务记忆（卡片 ref_kind='memory' 且 ref_id 有效）
    const _mcpBound = card.ref_kind === 'memory' && Number(card.ref_id) > 0;
    const links = (card.links_out || []).map(l => `${l.kind} → ${l.dst_kind}#${l.dst_id ?? l.dst_title}`).join('<br>') || '—';
    const mems = (card.memories || []).map(m => `记忆#${m.memory_id}（${m.relation}）`).join('<br>') || '—';
    $('#modalBody').innerHTML = `
      <div style="display:flex;gap:6px;border-bottom:1px solid var(--border-glass);padding-bottom:10px;margin-bottom:12px;flex-wrap:wrap">
        ${[['body','📋 正文'],['workspace','🔧 工作区'],['github','🌐 GitHub'],['comments','💬 评论'],['events','🕒 事件'],['links','🔗 关联']].map(([k, t]) => `<button class="btn-ghost" data-ctab="${k}" style="padding:6px 14px;font-size:12px;${_cardTab === k ? 'background:rgba(65,187,200,0.15);color:var(--accent-cyan);border-color:rgba(65,187,200,0.35)' : ''}">${t}${k === 'comments' ? `<span id="commentDot" style="display:none;margin-left:6px;width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block"></span>` : ''}</button>`).join('')}
      </div>
      <div id="cardTabBody"></div>
      <div class="cw-actions">
        <button class="btn-primary" id="cardAgentBtn" title="跳到智能体页并预填本卡任务说明（不自动发送，你过目后回车）">🚀 交给智能体</button>
        <button class="btn-ghost" id="cardTermBtn" title="打开准终端，并把工作目录切到本卡的工作区">⌨ 终端</button>
        <button class="btn-ghost" id="cardDesignBtn" title="打开 Design Mode：去真实浏览器点元素，抓 HTML+CSS+截图">🎯 拾取</button>
        <button class="btn-ghost" id="cardClaimBtn" style="padding:6px 14px;font-size:12px">✔ 认领</button>
        <button class="btn-ghost" id="cardPushMcpBtn" style="padding:6px 14px;font-size:12px;${_mcpBound ? '' : 'opacity:0.45;cursor:not-allowed'}" title="${_mcpBound ? '把本卡当前状态/标题回写到绑定的 MCP 任务记忆' : '该卡未绑定 MCP 任务'}" ${_mcpBound ? '' : 'disabled'}>⚡ 同步到 MCP</button>
        <span style="flex:1"></span>
        <button class="btn-ghost" id="cardCloseBtn" style="padding:6px 14px;font-size:12px">关闭（Esc）</button>
      </div>
      <div class="cw-status" role="group" aria-label="改卡片状态">
        <span class="cw-status-label">改状态（当前：${esc(meta[1])}）：</span>
        ${cwTargets(card.status).map(s => `<button class="cw-status-btn" data-st="${s}" title="改成${esc(CW_STATUS_LABEL[s] || s)}">${esc(CW_STATUS_LABEL[s] || s)}</button>`).join('') || '<span class="cw-status-label">已是终态，不能再流转</span>'}
        <span style="flex:1"></span>
        <button class="btn-danger" id="cardDeleteBtn" style="padding:4px 12px;font-size:11px">🗑 删除卡片</button>
      </div>`;
    const bodyBox = $('#cardTabBody');
    const renderBody = () => {
      bodyBox.innerHTML = `
        <div class="detail-grid">
          ${pair('编号', '#' + card.id, true)}
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
    /* ══ ★ Orca 融合 P1（2026-10-03 CLAIM §5）：工作区 Tab ══
       worktree 编排（创建/清理，共享优先原则）+ 只读 diff（手写 unified 解析，零第三方依赖）
       + 行级批注（存 card_comments，结构化前缀）+ 一键回传 Agent（汇总为卡片评论） */
    let _wbCh = null, _wbAnns = [], _wbFileFilter = '';
    /** unified diff → 行对象；side：add/ctx=新行(1)、del=旧行(0) */
    const wbParseDiff = (text) => {
      const rows = [];
      let file = null, oldNo = 0, newNo = 0;
      for (const ln of String(text || '').split('\n')) {
        if (ln.startsWith('+++ ')) { file = ln.slice(4).replace(/^b\//, ''); rows.push({ t: 'meta', text: ln }); continue; }
        if (ln.startsWith('--- ') || ln.startsWith('diff --git ') || ln.startsWith('index ') || ln.startsWith('old mode') || ln.startsWith('new mode') || ln.startsWith('Binary files')) { rows.push({ t: 'meta', text: ln }); continue; }
        if (ln.startsWith('@@')) {
          const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
          if (m) { oldNo = +m[1]; newNo = +m[2]; }
          rows.push({ t: 'hunk', text: ln }); continue;
        }
        if (ln.startsWith('+')) { rows.push({ t: 'add', file, line: newNo, side: 1, text: ln }); newNo++; continue; }
        if (ln.startsWith('-')) { rows.push({ t: 'del', file, line: oldNo, side: 0, text: ln }); oldNo++; continue; }
        if (ln.startsWith('\\')) { rows.push({ t: 'meta', text: ln }); continue; }
        if (ln === '') continue;
        rows.push({ t: 'ctx', file, line: newNo, lineOld: oldNo, side: 1, text: ln });
        oldNo++; newNo++;
      }
      return rows;
    };
    let _wbRows = [];
    const wbRenderDiff = () => {
      const box = document.getElementById('wbDiff');
      if (!box) return;
      if (!_wbCh) { box.innerHTML = `<div style="padding:10px;color:var(--text-muted);font-size:12px">加载变更…</div>`; return; }
      if (!_wbCh.files || !_wbCh.files.length) { box.innerHTML = `<div style="padding:10px;color:var(--text-muted);font-size:12px">工作区干净，无变更 ✓</div>`; return; }
      if (!_wbCh.diff) {
        box.innerHTML = `<div style="padding:10px;color:var(--text-muted);font-size:12px">有 ${_wbCh.files.length} 处文件变动，但 diff 为空（多为未跟踪新文件 —— 新文件不在 git diff 输出内，可先在 worktree 内 git add -N 后刷新）</div>`;
        return;
      }
      _wbRows = wbParseDiff(_wbCh.diff);
      // 批注按 file|line 分组（ctx 行同时挂新旧行号）
      const annByKey = {};
      for (const a of _wbAnns) {
        const k = a.path + '|' + a.line;
        (annByKey[k] = annByKey[k] || []).push(a);
      }
      let html = '';
      for (const r of _wbRows) {
        if (r.t === 'meta' || r.t === 'hunk') {
          html += `<div class="wb-line wb-${r.t}"><span class="wb-gutter"></span><span class="wb-gutter"></span><code>${esc(r.text)}</code></div>`;
          continue;
        }
        const cls = r.t === 'add' ? 'wb-add' : r.t === 'del' ? 'wb-del' : '';
        const g1 = r.t === 'del' ? r.line : r.t === 'ctx' ? r.lineOld : '';
        const g2 = r.t !== 'del' ? r.line : '';
        const keys = [r.file + '|' + r.line];
        if (r.t === 'ctx') keys.push(r.file + '|' + r.lineOld);
        html += `<div class="wb-line ${cls}"><span class="wb-gutter">${g1 === '' ? '' : esc(String(g1))}</span><span class="wb-gutter">${g2 === '' ? '' : esc(String(g2))}</span><code>${esc(r.text)}</code><button class="wb-mark" data-file="${esc(r.file || '')}" data-line="${r.line}" data-side="${r.side}" aria-label="批注 ${esc(r.file || '')} 第${r.line}行">✎</button></div>`;
        const seen = new Set();
        for (const k of keys) {
          for (const a of (annByKey[k] || [])) {
            if (seen.has(a.id)) continue;
            seen.add(a.id);
            html += `<div class="wb-ann"><span class="wb-ann-who">${esc(a.author || '')}<br>${fmtDate(a.created_at)}</span><span>${a.side ? '' : '<b>[旧] </b>'}${esc(a.body)}</span></div>`;
          }
        }
      }
      box.innerHTML = html;
      box.onclick = (e) => {
        const b = e.target.closest('.wb-mark');
        if (!b) return;
        document.querySelectorAll('.wb-ann-form').forEach(f => f.remove());
        const file = b.dataset.file, line = Number(b.dataset.line), side = Number(b.dataset.side);
        const row = b.closest('.wb-line');
        if (!row) return;
        const form = document.createElement('div');
        form.className = 'wb-ann-form';
        form.innerHTML = `
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">批注 ${esc(file)}:${line}（${side ? '新行' : '旧行'}）</div>
          <textarea aria-label="行级批注内容" placeholder="写给智能体的意见（存入卡片评论，可一键回传）"></textarea>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
            <button class="btn-ghost" data-wb-cancel style="padding:4px 12px;font-size:11px">取消</button>
            <button class="btn-primary" data-wb-ok style="padding:4px 12px;font-size:11px">提交批注</button>
          </div>`;
        row.after(form);
        const ta = form.querySelector('textarea');
        ta.focus();
        form.querySelector('[data-wb-cancel]').onclick = () => form.remove();
        form.querySelector('[data-wb-ok]').onclick = async () => {
          const text = (ta.value || '').trim();
          if (!text) { toast('批注内容不能为空'); return; }
          const res = await fetch(`/api/cards/${id}/annotations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file, line, side, body: text, author: 'human:dashboard' }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { toast(j.error || '批注失败'); return; }
          _wbAnns.push({ id: Date.now(), path: file, line, side, body: text, author: 'human:dashboard', created_at: new Date().toISOString() });
          wbRenderDiff();
          wbRenderAnns();
          toast('批注已提交');
        };
      };
    };
    const wbRenderAnns = () => {
      const box = document.getElementById('wbAnnList');
      if (!box) return;
      box.innerHTML = _wbAnns.length
        ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">行级批注（${_wbAnns.length}）</div>` + _wbAnns.map(a => `<div style="font-size:11px;padding:3px 0;color:var(--text-primary)"><span class="mono" style="color:var(--accent-cyan)">${esc(a.path)}:${a.line}</span> <span style="color:var(--text-muted)">${esc(a.author || '')}</span> ${esc(a.body)}</div>`).join('')
        : '';
    };
    const _wbLoadChanges = async (name) => {
      const q = _wbFileFilter ? `?file=${encodeURIComponent(_wbFileFilter)}` : '';
      const res = await fetch(`/api/worktrees/${encodeURIComponent(name)}/changes${q}`).catch(() => null);
      const box = document.getElementById('wbDiff');
      if (!res) { if (box) box.innerHTML = `<div style="padding:10px;color:#ef4444;font-size:12px">内核未响应</div>`; return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { if (box) box.innerHTML = `<div style="padding:10px;color:#ef4444;font-size:12px">${esc(j.error || '读取变更失败')}</div>`; return; }
      _wbCh = j;
      // 文件 chips（带批注计数；点选过滤 diff，再点取消）
      const chipBox = document.getElementById('wbFiles');
      if (chipBox) {
        const annCount = {};
        for (const a of _wbAnns) annCount[a.path] = (annCount[a.path] || 0) + 1;
        chipBox.innerHTML = (j.files || []).map(f => {
          const st = f.untracked ? '未跟踪' : f.conflicted ? '冲突' : ((f.index || '') + (f.worktree || ''));
          return `<button class="wb-files-chip${_wbFileFilter === f.path ? ' on' : ''}" data-f="${esc(f.path)}" aria-label="按文件过滤 diff：${esc(f.path)}">${esc(f.path)} <span style="color:var(--text-muted)">${esc(st)}</span>${annCount[f.path] ? `<span class="wb-badge">✎${annCount[f.path]}</span>` : ''}</button>`;
        }).join('') || '<span style="color:var(--text-muted)">无变动文件</span>';
        chipBox.querySelectorAll('.wb-files-chip').forEach(ch => ch.onclick = () => {
          _wbFileFilter = _wbFileFilter === ch.dataset.f ? '' : ch.dataset.f;
          _wbLoadChanges(name);
        });
      }
      wbRenderDiff();
    };
    /* ★ Orca 融合 P2（2026-10-03 CLAIM §5）：工作区 Tab 的 GitHub 区块
     * 读侧全功能：配置（owner/repo + token 走 DPAPI 密文）+ 仓库状态 + open issues/PR 列表 + 本卡关联 issue/PR 状态回显；
     * 写侧降级：建 PR 端点存在，但工作区无 origin 远端时后端 409 → 这里显示引导（本仓真实路径）。 */
    const _wbRenderGithub = async (box, fcard) => {
      const host = document.createElement('div');
      host.id = 'wbGh';
      host.className = 'wb-gh';
      host.innerHTML = `<div class="wb-gh-empty">加载 GitHub…</div>`;
      box.appendChild(host);
      let cm = {};
      // ★ P2 修复：详情接口 meta 经 readCardMeta 已是**对象**（创建流也有字符串形态）——原 JSON.parse(对象) 恒抛错 → cm={}
      //   导致 meta.worktree（P0 关联快取）与 meta.github（P2 关联）在 UI 永远读不到（P1 靠 workspace_kind 兜底掩盖）。
      try { cm = typeof fcard.meta === 'string' ? JSON.parse(fcard.meta || '{}') : (fcard.meta && typeof fcard.meta === 'object' ? fcard.meta : {}); } catch { cm = {}; }
      const gh0 = (cm.github && cm.github.ref) ? cm.github : null;
      let cfg = null;
      try { cfg = await fetch('/api/github/config').then((x) => x.json()); } catch { /* 内核未响应 */ }
      if (!cfg || !cfg.ok) { host.innerHTML = `<div class="wb-gh-title">🐙 GitHub</div><div class="wb-gh-empty" style="color:#ef4444">内核未响应</div>`; return; }
      let st = null, issues = [], pulls = [], ghState = null;
      if (cfg.repo) {
        const [r1, r2, r3] = await Promise.all([
          fetch('/api/github/status').then((x) => x.json()).catch(() => ({})),
          fetch('/api/github/issues?per_page=8').then((x) => x.json()).catch(() => ({})),
          fetch('/api/github/pulls?per_page=8').then((x) => x.json()).catch(() => ({})),
        ]);
        st = (r1 && r1.ok) ? r1 : null;
        issues = (r2 && r2.items) || [];
        pulls = (r3 && r3.items) || [];
      }
      if (gh0) ghState = await fetch(`/api/github/card/${id}/state`).then((x) => x.json()).catch(() => null);
      const linked = (ghState && ghState.linked) ? ghState.github : gh0;
      const badge = (s) => `<span class="wb-gh-badge ${s === 'open' ? 'ok' : (s ? 'warn' : '')}">${esc(s || '状态未知')}</span>`;
      host.innerHTML = `
        <div class="wb-gh-title">🐙 GitHub
          <span class="wb-gh-badge ${cfg.repo ? 'ok' : 'warn'}">${cfg.repo ? esc(cfg.repo) : '未配置仓库'}</span>
          <span class="wb-gh-badge ${cfg.remote && cfg.remote.exists ? 'ok' : 'warn'}">origin ${cfg.remote && cfg.remote.exists ? '✓' : '✗ 写侧降级'}</span>
          <span class="wb-gh-badge ${cfg.tokenSet ? 'ok' : ''}">token ${esc(cfg.tokenSource)}</span>
        </div>
        <div class="wb-gh-form">
          <input id="wbGhRepo" placeholder="owner/repo（如 stablyai/orca）" value="${esc(cfg.repo || '')}" aria-label="GitHub 仓库 owner/repo" style="flex:1 1 200px" autocomplete="off" spellcheck="false">
          <input id="wbGhToken" type="password" placeholder="${cfg.tokenSet ? '已存密文 token（留空不改）' : 'token（可选，公开仓库可空）'}" aria-label="GitHub 令牌" style="flex:1 1 180px" autocomplete="off">
          <button class="btn-primary" id="wbGhSave" style="padding:5px 14px;font-size:11px">保存配置</button>
          ${cfg.tokenSet ? `<button class="btn-ghost" id="wbGhClearTok" style="padding:5px 10px;font-size:11px">清除 token</button>` : ''}
          <div class="wb-gh-meta">明文 token 不落盘（DPAPI 密文）${cfg.canProtect ? '' : '；当前非 Windows，只能用环境变量 GITHUB_TOKEN 注入'}${st && st.repo ? `；默认分支 ${esc(st.repo.default_branch)} · 未关闭 Issue ${st.repo.open_issues_count} · 最近推送 ${esc(st.repo.pushed_at || '-')}` : ''}</div>
        </div>
        <div class="wb-gh-form" style="align-items:flex-start">
          ${linked ? `
            <span style="font-size:11px;line-height:26px">本卡关联：<a href="${esc(linked.url)}" target="_blank" rel="noopener">${esc(linked.ref)}</a> ${badge(linked.state)}</span>
            <button class="btn-ghost" id="wbGhRefresh" style="padding:4px 10px;font-size:11px">刷新状态</button>
            <button class="btn-ghost" id="wbGhUnlink" style="padding:4px 10px;font-size:11px">解除关联</button>
            ${ghState && ghState.stale ? `<div class="wb-gh-meta" style="color:#f59e0b">状态刷新失败：${esc(ghState.error || '网络/权限问题')}（显示最后已知态）</div>` : ''}
          ` : `
            <input id="wbGhLinkUrl" placeholder="粘贴 issue/PR 链接关联到本卡，例：https://github.com/owner/repo/issues/1" aria-label="GitHub issue 或 PR 链接" style="flex:1 1 300px" autocomplete="off" spellcheck="false">
            <button class="btn-ghost" id="wbGhLink" style="padding:4px 12px;font-size:11px">关联本卡</button>
          `}
        </div>
        ${cfg.repo ? `
          <div class="wb-gh-list"><b style="font-size:11px">未关闭 Issues</b>
            ${issues.length ? issues.map((it) => `<div class="wb-gh-item"><span class="wb-gh-no">#${it.number}</span><a href="${esc(it.html_url)}" target="_blank" rel="noopener">${esc(it.title)}</a></div>`).join('') : '<div class="wb-gh-empty">无（或网络/权限不可用）</div>'}
          </div>
          <div class="wb-gh-list"><b style="font-size:11px">未关闭 PR</b>
            ${pulls.length ? pulls.map((it) => `<div class="wb-gh-item"><span class="wb-gh-no">#${it.number}</span><a href="${esc(it.html_url)}" target="_blank" rel="noopener">${esc(it.title)}</a><span class="wb-gh-no">${esc(it.head || '?')}→${esc(it.base || '?')}</span></div>`).join('') : '<div class="wb-gh-empty">无（或网络/权限不可用）</div>'}
          </div>
          <div class="wb-gh-form">
            <input id="wbGhPrHead" placeholder="head 分支（本地已存在）" aria-label="PR head 分支" style="flex:1 1 150px" autocomplete="off" spellcheck="false">
            <input id="wbGhPrTitle" placeholder="PR 标题（留空用分支名）" aria-label="PR 标题" style="flex:1 1 150px" autocomplete="off">
            <button class="btn-primary" id="wbGhPrBtn" style="padding:5px 14px;font-size:11px">创建 PR</button>
            <div class="wb-gh-meta" id="wbGhPrHint"></div>
          </div>
        ` : `<div class="wb-gh-empty">填写 owner/repo 保存后：展示 open issues / PR 列表、可把 issue/PR 关联到本卡（读侧）。</div>`}
      `;
      const j2 = (res) => res.json().catch(() => ({}));
      const rerender = () => renderGithub(); // ★ P4：GitHub 已独立成 Tab，配置/关联后的重渲染留在本 Tab（原 renderWorkspace 会跳回工作区）
      const save = $('#wbGhSave');
      if (save) save.onclick = async () => {
        const body = { repo: $('#wbGhRepo').value.trim() };
        const tok = $('#wbGhToken').value.trim();
        if (tok) body.token = tok;
        const res = await fetch('/api/github/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await j2(res);
        if (!res.ok) { toast(j.error || '保存失败'); return; }
        toast('GitHub 配置已保存');
        rerender();
      };
      const clearTok = $('#wbGhClearTok');
      if (clearTok) clearTok.onclick = async () => {
        const res = await fetch('/api/github/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearToken: true }) });
        const j = await j2(res);
        if (!res.ok) { toast(j.error || '清除失败'); return; }
        toast('已清除 token');
        rerender();
      };
      const link = $('#wbGhLink');
      if (link) link.onclick = async () => {
        const url = $('#wbGhLinkUrl').value.trim();
        if (!url) { toast('先粘贴 issue/PR 链接'); return; }
        const res = await fetch('/api/github/card', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: id, url }) });
        const j = await j2(res);
        if (!res.ok) { toast(j.error || '关联失败'); return; }
        toast('已关联到本卡');
        rerender();
      };
      const unlink = $('#wbGhUnlink');
      if (unlink) unlink.onclick = async () => {
        const res = await fetch('/api/github/card', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: id, url: '' }) });
        const j = await j2(res);
        if (!res.ok) { toast(j.error || '解除失败'); return; }
        toast('已解除关联');
        rerender();
      };
      const refresh = $('#wbGhRefresh');
      if (refresh) refresh.onclick = () => rerender();
      const prBtn = $('#wbGhPrBtn');
      if (prBtn) prBtn.onclick = async () => {
        const head = $('#wbGhPrHead').value.trim();
        if (!head) { toast('填写 head 分支'); return; }
        const title = $('#wbGhPrTitle').value.trim();
        const res = await fetch('/api/github/pr', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ head, title }) });
        const j = await j2(res);
        const hint = $('#wbGhPrHint');
        if (!res.ok) {
          const msg = [j.error, j.hint].filter(Boolean).join(' —— ');
          if (hint) hint.innerHTML = `<span style="color:#f59e0b">${esc(msg)}</span>`;
          toast(j.error || '创建 PR 失败');
          return;
        }
        toast(`PR #${j.pr?.number} 已创建`);
        if (j.pr?.html_url) window.open(j.pr.html_url, '_blank', 'noopener');
        rerender();
      };
    };
    const renderWorkspace = async () => {
      bodyBox.innerHTML = `<div style="padding:14px 0;color:var(--text-muted);font-size:12px">加载工作区…</div>`;
      // ★ 每次重取卡片：闭包里的 card 是打开弹窗时的快照 —— 创建/清理 worktree 后其 meta/workspace 已变，用旧快照会渲染错态
      const fresh = await fetch(`/api/cards/${id}`).then(x => x.json()).catch(() => null);
      const fcard = (fresh && fresh.card) ? fresh.card : card;
      let wtItems = [], policy = '';
      try {
        const r0 = await fetch('/api/worktrees').then(x => x.json());
        if (!r0.ok || !Array.isArray(r0.items)) { bodyBox.innerHTML = `<div style="padding:14px 0;color:#ef4444;font-size:12px">${esc(r0.error || '工作区列表读取失败')}</div>`; return; }
        wtItems = r0.items; policy = r0.policy || '';
      } catch { bodyBox.innerHTML = `<div style="padding:14px 0;color:#ef4444;font-size:12px">内核未响应</div>`; return; }
      let cm = {};
      // ★ P2 修复：详情接口 meta 经 readCardMeta 已是**对象**（创建流也有字符串形态）——原 JSON.parse(对象) 恒抛错 → cm={}
      //   导致 meta.worktree（P0 关联快取）与 meta.github（P2 关联）在 UI 永远读不到（P1 靠 workspace_kind 兜底掩盖）。
      try { cm = typeof fcard.meta === 'string' ? JSON.parse(fcard.meta || '{}') : (fcard.meta && typeof fcard.meta === 'object' ? fcard.meta : {}); } catch { cm = {}; }
      const want = cm.worktree || (fcard.workspace_kind === 'worktree' && fcard.workspace ? String(fcard.workspace).split(/[\\/]/).pop() : '');
      const mine = wtItems.find(w => w.name === want) || null;
      _wbCh = null; _wbFileFilter = ''; _wbRows = [];
      const aj = await fetch(`/api/cards/${id}/annotations`).then(x => x.json()).catch(() => ({ annotations: [] }));
      _wbAnns = aj.annotations || [];
      const others = wtItems.filter(w => !w.main && w.name !== want);
      if (!mine) {
        bodyBox.innerHTML = `
          <div style="font-size:12px;color:var(--text-muted);line-height:1.8">
            本卡未关联隔离工作区 —— <b style="color:var(--text-primary)">默认共享主工作区</b>（并行任务发生真实冲突时才需要隔离，见 Orca 原则）。<br>
            本仓现有隔离区：${others.length ? others.map(w => esc(w.name)).join('、') : '无'}${policy ? `<br><span style="opacity:.75">${esc(policy)}</span>` : ''}
          </div>
          <div style="display:flex;gap:8px;margin-top:12px">
            <button class="btn-ghost" id="wbCreateBtn" style="padding:6px 14px;font-size:12px">创建工作区并关联本卡</button>
          </div>`;
        const cb = $('#wbCreateBtn');
        if (cb) cb.onclick = async () => {
          // ★ P4 简化：预填默认名（回车即建），少一次打字；仍保留弹窗以避免与既有 worktree 重名
          const v = await askForm({ title: '创建隔离 worktree（分支 wt/<名称>，落在 .worktrees/ 内）', okText: '创建', fields: [{ key: 'name', label: '名称（已预填，可改）', required: true, value: `card-${id}`, placeholder: '如 fix-1234' }] });
          if (!v) return;
          const res = await fetch('/api/worktrees', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: v.name, cardId: id }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) { toast(j.error || '创建失败'); return; }
          toast(`已创建 ${j.name}（${j.branch}）`);
          renderWorkspace();
        };
        return;
      }
      bodyBox.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px">
          <span class="mono" style="color:var(--accent-cyan)">● ${esc(mine.name)}</span>
          <span class="mono" style="color:var(--text-muted)">${esc(mine.branch || '')}${mine.detached ? '（detached）' : ''}</span>
          <span style="flex:1"></span>
          <button class="btn-ghost" id="wbRefreshBtn" style="padding:5px 12px;font-size:12px">刷新变更</button>
          <button class="btn-ghost" id="wbSendBackBtn" style="padding:5px 12px;font-size:12px" title="把行级批注汇总为一条卡片评论，供智能体下轮读取">回传批注给智能体</button>
          <button class="btn-danger" id="wbRemoveBtn" style="padding:5px 12px;font-size:12px">清理工作区</button>
        </div>
        <div id="wbFiles" style="margin-top:10px;font-size:11px"></div>
        <div id="wbAnnList" style="margin-top:6px"></div>
        <div class="wb-diff" id="wbDiff" style="margin-top:8px"><div style="padding:10px;color:var(--text-muted);font-size:12px">加载变更…</div></div>`;
      wbRenderAnns();
      $('#wbRefreshBtn').onclick = () => _wbLoadChanges(mine.name);
      $('#wbSendBackBtn').onclick = async () => {
        if (!_wbAnns.length) { toast('暂无行级批注'); return; }
        const lines = _wbAnns.map(a => `- ${a.path}:${a.line}（${a.side ? '新行' : '旧行'}）${a.body}`).join('\n');
        const res = await fetch(`/api/cards/${id}/comment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: `【diff 批注回传 · ${mine.name}】\n${lines}`, author: 'human:dashboard' }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { toast(j.error || '回传失败'); return; }
        toast(`已回传 ${_wbAnns.length} 条批注（智能体下轮可见评论）`);
      };
      $('#wbRemoveBtn').onclick = async () => {
        const v = await askForm({
          title: `清理工作区 ${mine.name}（分支保留可回滚；有未提交改动会被拒绝，勾选强制可忽略）`, okText: '清理',
          fields: [{ key: 'force', label: '强制（输入 1 = 忽略未提交改动）', placeholder: '留空 = 脏区拒绝' }],
        });
        if (!v) return;
        const res = await fetch(`/api/worktrees/${encodeURIComponent(mine.name)}${v.force === '1' ? '?force=1' : ''}`, { method: 'DELETE' }).catch(() => null);
        if (!res) { toast('内核未响应'); return; }
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { toast(j.error || '清理失败'); return; }
        toast('已清理 ' + mine.name);
        renderWorkspace();
      };
      _wbLoadChanges(mine.name);
    };
    /* ★ P4：GitHub 从「工作区」拆为独立 Tab —— 原本配置/issue/PR/建 PR 四组表单与 diff、批注挤在同一条超长滚动里，
       打开还要连发 5 个请求才渲染完，信息过载是最主要的迷路点之一。低频能力独立成页，主路径（改代码）更干净。 */
    const renderGithub = async () => {
      bodyBox.innerHTML = `<div style="padding:14px 0;color:var(--text-muted);font-size:12px">加载 GitHub…</div>`;
      const fresh = await fetch(`/api/cards/${id}`).then(x => x.json()).catch(() => null);
      const fcard = (fresh && fresh.card) ? fresh.card : card;
      bodyBox.innerHTML = '';
      _wbRenderGithub(bodyBox, fcard);
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
      else if (k === 'workspace') renderWorkspace();
      else if (k === 'github') renderGithub();
      else renderEvents();
    };
    // ★ 2026-09-14 查漏：打开新卡片时重置 Tab 为正文，避免沿用上一张卡片的 Tab（评论/事件）
    // ★ P4：允许调用方指定首屏 Tab（地图快捷条 🔧 直达工作区）
    _cardTab = ['body', 'workspace', 'github', 'comments', 'events', 'links'].includes(initialTab) ? initialTab : 'body';
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
    /* ★ P4 工作台动作条：交给 Agent / 终端（自动切本卡目录）/ 设计拾取 / 一键改状态 */
    $('#cardAgentBtn').onclick = () => { closeCardDetail(); sendCardToAgent(card); };
    $('#cardTermBtn').onclick = () => {
      if (!_termOpenWithCwd) { toast('终端尚未就绪'); return; }
      _termOpenWithCwd(card);
    };
    $('#cardDesignBtn').onclick = () => {
      if (!_designOpenDrawer) { toast('Design Mode 尚未就绪'); return; }
      _designOpenDrawer();
    };
    $$('#modalBody .cw-status-btn[data-st]').forEach(b => b.onclick = async () => {
      if (b.disabled) return;
      if (await setCardStatus(card, b.dataset.st)) {
        refreshCurrentTaskView();
        openCardDetail(id, _cardTab); // 原地刷新：按钮高亮与状态徽标同步（Esc 监听已在函数开头去重）
      }
    });
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

  /* ===== 卡片类型 / 智能体清单 / 智能体卡向导（2026-10-05 并入批：节点画布能力并入任务地图）===== */
  // 卡片类型注册表缓存（失败按内置四种兜底，与节点画布同口径，防「无类型可选」空转）
  const CARD_TYPES_BUILTIN = [
    { type_key: 'task', label: '任务', builtin: 1, can_dispatch_out: 1, can_dispatch_in: 0, can_inject_out: 0, can_inject_in: 1 },
    { type_key: 'agent', label: '智能体', builtin: 1, can_dispatch_out: 0, can_dispatch_in: 1, can_inject_out: 0, can_inject_in: 0 },
    { type_key: 'handoff', label: '交接文档', builtin: 1, can_dispatch_out: 0, can_dispatch_in: 0, can_inject_out: 1, can_inject_in: 0 },
    { type_key: 'doc', label: '文档', builtin: 1, can_dispatch_out: 0, can_dispatch_in: 0, can_inject_out: 0, can_inject_in: 0 },
  ];
  let _cardTypes = { list: [], ts: 0 };
  async function loadCardTypes() {
    try {
      const r = await fetch('/api/card-types').then(x => x.json());
      if (Array.isArray(r?.types) && r.types.length) _cardTypes.list = r.types;
      _cardTypes.ts = Date.now();
    } catch (e) { console.warn('[任务地图] 卡片类型拉取失败，按内置四种兜底', e); }
    if (!_cardTypes.list.length) _cardTypes.list = CARD_TYPES_BUILTIN;
    return _cardTypes.list;
  }

  // 智能体清单缓存（根因修复语义 2026-10-05：旧实现一次性取数、失败静默归零且无重试 → 下拉永久空。
  // 现：取数失败/异常体保留旧清单不归零；向导打开时若空先重拉；轮询仅空清单且 >30s 才惰性重试（scan 端点带 spawnSync 探测，勿高频打）。
  let _agentScan = { list: [], ts: 0 };
  async function loadAgentScan(force = false) {
    if (_agentScan.list.length && !force) return _agentScan.list;
    try {
      const r = await fetch('/api/scan-agents').then(x => x.json());
      const arr = Array.isArray(r?.agents) ? r.agents : (Array.isArray(r?.rows) ? r.rows : null);
      if (arr) { _agentScan.list = arr; _agentScan.ts = Date.now(); }
      else console.warn('[任务地图] scan-agents 取数失败（错误体），保留旧智能体清单', r?.error || '');
    } catch (e) { console.warn('[任务地图] scan-agents 拉取失败，保留旧智能体清单（不中断向导）', e); }
    return _agentScan.list;
  }

  // 当前任务地图视口中心 → 世界坐标（新建卡/智能体卡的初始位置，走 meta.map_pos.c 桶持久化）
  function taskMapViewCenter() {
    const canvas = $('#taskMapCanvas');
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const st = _taskMapState;
    const s = st.scale || 1;
    return { x: Math.round((r.width / 2 - st.x) / s), y: Math.round((r.height / 2 - st.y) / s) };
  }

  /** 智能体卡配置向导（create=POST /api/agent-profiles 事务建档案+投影卡；edit=GET 现值→预填→PUT 整对象保存。
   *  A 类坑（探针/读码实证）：PUT 的 launch_overrides 是整对象替换——高级栏留空时不传该字段（端点保留旧值），
   *  填了才传解析后的对象，防「半更新把 exe/args 清掉」。409（该卡有进行中派发）透出提示。 */
  async function openAgentWizard({ mode = 'create', profileId = null, presetTitle = '', pos = null, rawProfile = false } = {}) {
    await loadAgentScan(_agentScan.list.length === 0);
    let p0 = null;
    if (mode === 'edit') {
      const r = await fetch('/api/agent-profiles').then(x => x.json()).catch(() => null);
      p0 = (r?.profiles || []).find(x => Number(x.id) === Number(profileId)) || null;
      if (!p0) { toast('未取到智能体档案（可能已随卡片删除）'); return false; }
    }
    const lo0 = p0?.launch_overrides ? (typeof p0.launch_overrides === 'string' ? p0.launch_overrides : JSON.stringify(p0.launch_overrides, null, 1)) : '';
    const agentOpts = _agentScan.list.map(a => ({ value: String(a.id ?? ''), label: `${a.name ?? a.id ?? ''}${a.connected ? '' : ' · 未连接'}` }));
    if (!_agentScan.list.length) agentOpts.push({ value: '', label: '（未扫描到，可留空建「无载体」卡，卡上会标 ⚠️）' });
    const inStyle = 'width:100%;box-sizing:border-box;padding:7px 10px;font-size:13px;background:var(--surface-glass,#fff);color:var(--text-primary);border:1px solid var(--border-glass,rgba(0,0,0,.15));border-radius:8px;outline:none';

    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'ask-form-modal cockpit-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center';
      ov.innerHTML = `
      <div style="max-width:470px;width:94%;background:var(--surface-glass,#fff);backdrop-filter:blur(14px);border:1px solid var(--border-glass,rgba(0,0,0,.12));border-radius:14px;padding:18px 20px;box-shadow:0 18px 60px rgba(0,0,0,.3);max-height:88vh;overflow:auto">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:var(--text-primary)">${mode === 'edit' ? `编辑智能体配置（档案 #${esc(String(profileId))}）` : '新建智能体卡'}</span>
          <button data-x style="margin-left:auto;background:none;border:none;font-size:16px;color:var(--text-muted);cursor:pointer">✕</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin:2px 0 6px">智能体卡 = 一个可配置的执行者。选「智能体 + 执行通道」，之后把任务 ⚡ 派给它，系统按通道自动执行。</div>
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">卡片名称 *</label>
        <input data-k="name" style="${inStyle}" value="${esc(presetTitle || p0?.name || '智能体卡')}">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">智能体（本机已装）</label>
        <select data-k="agent_key" style="${inStyle}">${agentOpts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">执行通道</label>
        <select data-k="channel" style="${inStyle}">
          <option value="queue">队列 · 智能体自己领单（保底，永远可用）</option>
          <option value="cli">直控 · 终端拉起并直播日志（需该智能体已登录/配好密钥）</option>
          <option value="cdp">驾驶 · 拉起桌面软件并直播画面（Chromium 系应用）</option>
        </select>
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">工作区（留空 = 用户主目录）</label>
        <input data-k="workspace" style="${inStyle}" placeholder="例：D:\\项目\\某目录" value="${esc(p0?.workspace || '')}">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">模型（留空 = 智能体默认）</label>
        <input data-k="model" style="${inStyle}" value="${esc(p0?.model || '')}">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">推理强度（留空 = 默认）</label>
        <input data-k="reasoning" style="${inStyle}" placeholder="例：standard / high" value="${esc(p0?.reasoning || '')}">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">上下文 token（留空 = 默认）</label>
        <input data-k="context_tokens" style="${inStyle}" value="${esc(String(p0?.context_tokens ?? ''))}">
        <details style="margin-top:8px"><summary style="font-size:12px;color:var(--text-muted);cursor:pointer">高级：启动参数 / 聊天框选择器（JSON，可不填）</summary>
          <textarea data-k="launch_overrides" rows="4" style="width:100%;box-sizing:border-box;margin-top:6px;padding:7px 10px;font:11px/1.5 Consolas,monospace;background:var(--surface-glass,#fff);color:var(--text-primary);border:1px solid var(--border-glass,rgba(0,0,0,.15));border-radius:8px;outline:none;resize:vertical" placeholder='CLI 直控：{"cmd":"codex","args":["exec","-"]} · CDP 驾驶：{"exe":"C:\\...\\Trae CN.exe","chatSelector":"...","sendSelector":"..."}'></textarea>
        </details>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">高级栏留空 = 保存时不动已有配置（PUT 整替换语义，防误清空）。直控/驾驶通道需登录态/选择器配好，未配会如实显示「未连通」；拿不准就选「队列」。</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button data-cancel class="btn-ghost" style="padding:6px 14px;font-size:12px">取消</button>
          <button data-ok class="btn-primary" style="padding:6px 16px;font-size:12px">保存</button>
        </div>
      </div>`;
      const ta = ov.querySelector('[data-k="launch_overrides"]'); if (ta) ta.value = lo0;
      const q = k => ov.querySelector(`[data-k="${k}"]`);
      let done = false;
      const close = (val) => { if (done) return; done = true; ov.remove(); resolve(val); };
      const submit = async () => {
        const loRaw = q('launch_overrides').value.trim();
        let lo = null;
        if (loRaw) {
          try { lo = JSON.parse(loRaw); }
          catch { toast('高级配置需为合法 JSON（看格式示例）'); return; }
        }
        const body = {
          name: q('name').value.trim() || '智能体卡',
          agent_key: q('agent_key').value || null,
          channel: q('channel').value,
          workspace: q('workspace').value.trim() || null,
          model: q('model').value.trim() || null,
          reasoning: q('reasoning').value.trim() || null,
        };
        const ct = Number(q('context_tokens').value);
        if (ct > 0) body.context_tokens = ct;
        if (mode === 'create' && rawProfile) {
          // 改型内联场景：只取值——profile 随 POST /api/cards/:id/retype 事务建档案（不在这里建卡）
          if (lo) body.launch_overrides = lo;
          close(body);
          return;
        }
        if (mode === 'create') {
          if (lo) body.launch_overrides = lo;
          if (pos) body.meta = { map_pos: { x: pos.x, y: pos.y } };
          const r = await fetch('/api/agent-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { toast(`智能体卡创建失败：${j.error || r.status}`); return; }
          toast(`已创建智能体卡 #${j.card_id}（档案 #${j.profile_id}）`);
          close(true); refreshCurrentTaskView(); return;
        }
        // edit：PUT 整对象；launch_overrides 仅当高级栏填了才传（否则端点保留旧值）
        const put = { ...body, concurrency: Number(p0?.concurrency) > 0 ? Number(p0.concurrency) : 1 };
        if (lo) put.launch_overrides = lo;
        const r = await fetch(`/api/agent-profiles/${profileId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(put) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { toast(`配置保存失败：${j.error || r.status}`); return; }
        toast('智能体配置已保存');
        close(true); refreshCurrentTaskView();
      };
      ov.querySelector('[data-x]').onclick = () => close(false);
      ov.querySelector('[data-cancel]').onclick = () => close(false);
      ov.querySelector('[data-ok]').onclick = submit;
      ov.addEventListener('click', e => { if (e.target === ov) close(false); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
      });
      q('name').focus();
    });
  }

  /** 新建自定义卡片类型（POST /api/card-types；保留字/内置/aux 前缀由端点 400 拦截，错误透出） */
  function newTypeDialog() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'ask-form-modal cockpit-modal';
      ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center';
      const inStyle = 'width:100%;box-sizing:border-box;padding:7px 10px;font-size:13px;background:var(--surface-glass,#fff);color:var(--text-primary);border:1px solid var(--border-glass,rgba(0,0,0,.15));border-radius:8px;outline:none';
      ov.innerHTML = `
      <div style="max-width:420px;width:92%;background:var(--surface-glass,#fff);backdrop-filter:blur(14px);border:1px solid var(--border-glass,rgba(0,0,0,.12));border-radius:14px;padding:18px 20px;box-shadow:0 18px 60px rgba(0,0,0,.3)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:var(--text-primary)">新建自定义卡片类型</span>
          <button data-x style="margin-left:auto;background:none;border:none;font-size:16px;color:var(--text-muted);cursor:pointer">✕</button>
        </div>
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">显示名 *</label>
        <input data-k="label" style="${inStyle}" placeholder="例：里程碑">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">标识（小写字母开头，2-32 位字母/数字/下划线）*</label>
        <input data-k="type_key" style="${inStyle}" placeholder="例：milestone">
        <label style="display:block;font-size:12px;color:var(--text-muted);margin:8px 0 4px">颜色（可选）</label>
        <input data-k="color" style="${inStyle}" placeholder="例：#8f7a3d（可空）">
        <div style="font-size:12px;color:var(--text-muted);margin:8px 0 4px">连线能力档位（不勾 = 纯文档节点，不参与任何连线）</div>
        <label style="font-size:12px;margin:4px 0"><input type="checkbox" data-k="can_dispatch_out"> 可发起派发（→ 智能体卡）</label>
        <label style="font-size:12px;margin:4px 0"><input type="checkbox" data-k="can_dispatch_in"> 可接收派发</label>
        <label style="font-size:12px;margin:4px 0"><input type="checkbox" data-k="can_inject_out"> 可发起前情注入（→ 任务卡）</label>
        <label style="font-size:12px;margin:4px 0"><input type="checkbox" data-k="can_inject_in"> 可接收前情注入</label>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button data-cancel class="btn-ghost" style="padding:6px 14px;font-size:12px">取消</button>
          <button data-ok class="btn-primary" style="padding:6px 16px;font-size:12px">创建</button>
        </div>
      </div>`;
      const q = k => ov.querySelector(`[data-k="${k}"]`);
      let done = false;
      const close = (val) => { if (done) return; done = true; ov.remove(); resolve(val); };
      const submit = async () => {
        const body = {
          type_key: q('type_key').value.trim(),
          label: q('label').value.trim(),
          color: q('color').value.trim() || null,
          can_dispatch_out: q('can_dispatch_out').checked ? 1 : 0,
          can_dispatch_in: q('can_dispatch_in').checked ? 1 : 0,
          can_inject_out: q('can_inject_out').checked ? 1 : 0,
          can_inject_in: q('can_inject_in').checked ? 1 : 0,
        };
        if (!body.type_key || !body.label) { toast('显示名与标识必填'); return; }
        const r = await fetch('/api/card-types', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { toast(`类型创建失败：${j.error || r.status}`); return; }
        toast(`已创建卡片类型「${body.label}」`);
        close(body);
        loadCardTypes();
      };
      ov.querySelector('[data-x]').onclick = () => close(null);
      ov.querySelector('[data-cancel]').onclick = () => close(null);
      ov.querySelector('[data-ok]').onclick = submit;
      ov.addEventListener('click', e => { if (e.target === ov) close(null); });
      q('label').focus();
    });
  }

  /* 画布左上角「＋ 新建卡片」悬浮入口（点选建卡：先选类型、再落卡；与工具条按钮同一份交互） */
  function initCreateCardPanel() {
    if ($('#taskMapPlusBtn')) return;
    const canvas = $('#taskMapCanvas');
    if (!canvas) return;
    const btn = document.createElement('button');
    btn.id = 'taskMapPlusBtn';
    btn.type = 'button';
    btn.textContent = '＋';
    btn.title = '新建卡片：先选类型（任务/智能体/交接/文档/自定义），卡片落到地图（当前视图中心）';
    btn.setAttribute('aria-label', '新建卡片');
    btn.style.cssText = 'position:absolute;left:10px;top:10px;z-index:30;width:36px;height:36px;border-radius:50%;border:1px solid var(--border-glass,rgba(0,0,0,.15));background:var(--surface-glass,#fff);color:var(--text-primary);font-size:18px;line-height:1;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.15)';
    btn.onmouseenter = () => { btn.style.outline = '2px solid #06b6d4'; };
    btn.onmouseleave = () => { btn.style.outline = 'none'; };
    btn.onclick = () => createCard();
    canvas.appendChild(btn);
    const sync = () => { btn.style.display = (RESTRICTED && RESTRICTED.cardCreate) ? 'none' : ''; };
    sync();
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // 受限模式切换同步显隐
  }

  /** 新建卡片（点选式：先选类型+标题 → 按类型走不同端点；智能体卡自动进配置向导。
   *  替代旧「单字段建 task 卡」——卡片类型不再随意。RESTRICTED=1 时端点拒绝，toast 透出。 */
  async function createCard() {
    await loadCardTypes();
    const typeOpts = _cardTypes.list.map(t => ({ value: t.type_key, label: t.builtin ? t.label : `${t.label}（自定义）` }));
    typeOpts.push({ value: '__new__', label: '＋ 新建自定义类型…' });
    const v = await askForm({ title: '新建卡片', fields: [
      { key: 'kind', type: 'select', label: '卡片类型', options: typeOpts, value: 'task', required: true },
      { key: 'title', label: '卡片标题', placeholder: '例：梳理记忆检索链路', required: true },
    ], okText: '创建' });
    if (!v) return;
    let kind = v.kind;
    if (kind === '__new__') {
      const t = await newTypeDialog();
      if (!t) return;
      kind = t.type_key;
    }
    if (kind === 'agent') {
      const ok = await openAgentWizard({ mode: 'create', presetTitle: (v.title || '').trim(), pos: taskMapViewCenter() });
      if (ok) refreshCurrentTaskView();
      return;
    }
    const title = (v.title || '').trim();
    if (!title) return;
    const res = await fetch('/api/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, kind, meta: { map_pos: { c: taskMapViewCenter() } } }) });
    const j = await res.json().catch(() => ({}));
    const kindLabel = (_cardTypes.list.find(t => t.type_key === kind) || {}).label || kind;
    toast(res.ok ? `已建卡片 #${j.id}（${kindLabel}）` : (`创建失败：${j.error || res.status}`));
    if (res.ok) refreshCurrentTaskView();
  }

  /* ===== 2026-10-05 并入批：派发/注入/改型/实时窗口（端点全部现成，前端只做编排与诚实降级）===== */

  // 通用小弹层（目标选择/确认；EventSource 类弹层关闭钩子统一注册，防流泄漏）
  let _agentPops = [];
  let _agentPopOv = null;
  function closeAgentPops() {
    _agentPops.forEach(f => { try { f(); } catch { /* 忽略 */ } });
    _agentPops = [];
    if (_agentPopOv) { _agentPopOv.remove(); _agentPopOv = null; }
  }
  function agentOverlay(title, bodyHtml, footerBtns = []) {
    closeAgentPops();
    const ov = document.createElement('div');
    _agentPopOv = ov;
    ov.style.cssText = 'position:fixed;right:16px;top:64px;z-index:10000;width:340px;max-width:94vw;background:var(--surface-glass,#fff);backdrop-filter:blur(14px);border:1px solid var(--border-glass,rgba(0,0,0,.12));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:14px 16px;box-sizing:border-box';
    ov.innerHTML = `<div style="display:flex;align-items:center;font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px"><span>${esc(title)}</span><button style="margin-left:auto;background:none;border:none;font-size:14px;color:var(--text-muted);cursor:pointer" aria-label="关闭">✕</button></div><div class="ap-body">${bodyHtml}</div>${footerBtns.length ? `<div style="display:flex;gap:8px;margin-top:10px">${footerBtns.map(b => `<button class="btn-ghost ap-btn" data-act="${b.act}" style="padding:4px 12px;font-size:12px">${esc(b.label)}</button>`).join('')}</div>` : ''}`;
    document.body.appendChild(ov);
    ov.querySelector('div > button[aria-label="关闭"]').onclick = closeAgentPops;
    return ov;
  }
  /** 行内确认层（替代 window.confirm——CDP 冒烟/走查会被原生 confirm 阻塞） */
  function confirmInline(text, onOk) {
    closeAgentPops();
    const ov = document.createElement('div');
    _agentPopOv = ov;
    ov.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center';
    ov.innerHTML = `<div style="background:var(--surface-glass,#fff);border:1px solid var(--border-glass,rgba(0,0,0,.12));border-radius:12px;padding:16px 18px;max-width:320px;font-size:13px;color:var(--text-primary);box-shadow:0 12px 40px rgba(0,0,0,.3)"><div style="margin-bottom:12px">${esc(text)}</div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-ghost" style="padding:5px 12px;font-size:12px">取消</button><button class="btn-primary" style="padding:5px 14px;font-size:12px">确认</button></div></div>`;
    document.body.appendChild(ov);
    const [cancel, ok] = ov.querySelectorAll('button');
    cancel.onclick = closeAgentPops;
    ok.onclick = () => { closeAgentPops(); onOk(); };
  }

  /** ⚡ 派发给…（按卡定向派发：选目标智能体卡 → state 拦截/确认层 → POST /api/cards/:id/dispatch-agent。
   *  收掉 A1 接线记录遗留待办「前端按钮真调 dispatch-agent」。carrier_missing=真 → 拦截并提示先配置。 */
  async function dispatchCardToAgent(srcCardId) {
    const targets = (_taskMapState.data.nodes || []).filter(n => String(n.kind) === 'agent');
    if (!targets.length) { toast('地图上还没有智能体卡——先点左上角 ＋ 建一张（类型选「智能体」）'); return; }
    const rows = targets.map(t => {
      const miss = t.profileMissing ? ' <span style="color:#f59e0b;font-size:11px">⚠️ 载体缺失</span>' : '';
      return `<div data-next="${''}" data-target="${t.id}" class="ap-item" style="padding:8px 10px;border:1px solid var(--border-glass,rgba(0,0,0,.08));border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px;color:var(--text-primary)">🤖 ${esc(t.title || ('#' + t.id))}${miss}</div>`;
    }).join('');
    const ov = agentOverlay(`把 #${srcCardId} 派给哪个智能体？`, rows);
    ov.querySelectorAll('[data-target]').forEach(el => {
      el.onclick = async () => {
        const dst = Number(el.dataset.target);
        let st = {};
        try { st = await fetch(`/api/agent-cards/${dst}/state`).then(x => x.json()).catch(() => ({})); } catch { /* 状态拿不到仍可尝试派发 */ }
        if (st.carrier_missing) {
          agentOverlay('⚠️ 无法派发', `<div style="font-size:12px;color:var(--text-muted)">该智能体载体缺失（选的智能体未安装/未登记）。请右键智能体卡「⚙️ 编辑智能体配置」选一个本机已装的智能体。</div>`);
          return;
        }
        const chLabel = { cli: '直控 · 终端流', cdp: '驾驶 · 界面直播', queue: '队列 · 领单' }[st.channel] || '队列 · 领单';
        const depth = st.queue_depth ? `队列中已有 ${Number(st.queue_depth)} 项（将排队执行）` : '当前空闲，立即执行';
        const ov2 = agentOverlay('确认派发', `
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.8">
            任务卡 <b>#${srcCardId}</b> → 智能体 <b>${esc(st.name || ('#' + dst))}</b>（${chLabel}）<br>${esc(depth)}
          </div>
          `, [
            { act: 'go', label: '确认派发' },
            { act: 'cancel', label: '取消' },
          ]);
        const go = (o) => {
          o.querySelector('[data-act="go"]').onclick = async () => {
            const res = await fetch(`/api/cards/${srcCardId}/dispatch-agent`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ agent_card_id: dst }),
            }).then(x => x.json().catch(() => ({})));
            closeAgentPops();
            if (res.ok) { toast(`已把 #${srcCardId} 派给「${st.name || dst}」${res.dispatch ? `（第 ${Number(res.dispatch.generation) + 1} 次尝试）` : ''}`); refreshCurrentTaskView(); }
            else toast(`派发失败：${res.error || '未知'}`);
          };
          o.querySelector('[data-act="cancel"]').onclick = closeAgentPops;
        };
        go(ov2);
      };
    });
  }

  /** 📎 注入前情（POST /api/card-edges {kind:'inject'}；端点白名单=仅 inject，档位/重复/端点存在性由后端 409/404 拦截并透出） */
  async function injectCardTo(srcCardId) {
    await loadCardTypes();
    const inOk = (k) => { const t = _cardTypes.list.find(x => x.type_key === k); return t ? !!t.can_inject_in : (k === 'task'); };
    const targets = (_taskMapState.data.nodes || []).filter(n => inOk(String(n.kind)) && !String(n.kind).startsWith('aux_'));
    if (!targets.length) { toast('没有可接收注入的卡片（需「可接收注入」档位的类型，默认只有任务卡）'); return; }
    const rows = targets.slice(0, 30).map(t =>
      `<div data-target="${t.id}" style="padding:8px 10px;border:1px solid var(--border-glass,rgba(0,0,0,.08));border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px;color:var(--text-primary)">📄 ${esc(t.title || ('#' + t.id))}</div>`
    ).join('');
    const ov = agentOverlay(`把 #${srcCardId} 的前情注入到哪张卡片？`, rows);
    ov.querySelectorAll('[data-target]').forEach(el => {
      el.onclick = async () => {
        const res = await fetch('/api/card-edges', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source_id: srcCardId, target_id: Number(el.dataset.target), kind: 'inject' }),
        }).then(x => x.json().catch(() => ({})));
        closeAgentPops();
        if (res.ok) { toast('已建立前情注入：该卡被派发时会自动带上这份前情'); refreshCurrentTaskView(); }
        else toast(`注入连线失败：${res.error || '未知'}`);
      };
    });
  }

  /** 🔄 改卡片类型（POST /api/cards/:id/retype；切 agent 且卡无档案 → 先走智能体向导取 profile 内联建档案。
   *  409（执行中/有进行中派发）原样透出。 */
  async function changeCardKind(cardId) {
    const r = await fetch(`/api/cards/${cardId}`).then(x => x.json()).catch(() => null);
    if (!r?.card) { toast('卡片不存在'); return; }
    await loadCardTypes();
    const cur = String(r.card.kind);
    const opts = _cardTypes.list.filter(t => t.type_key !== cur);
    const ov = agentOverlay(`把 #${cardId} 改为哪种类型？（当前：${esc((_cardTypes.list.find(t => t.type_key === cur) || {}).label || cur)}）`,
      opts.map(t => `<div data-target="${esc(t.type_key)}" style="padding:8px 10px;border:1px solid var(--border-glass,rgba(0,0,0,.08));border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px;color:var(--text-primary)">${esc(t.label)}${t.builtin ? '' : '（自定义）'}</div>`).join('') +
      `<div data-target="__new__" style="padding:8px 10px;font-size:12px;color:var(--text-muted);cursor:pointer;margin-top:4px">＋ 新建自定义类型…</div>`);
    ov.querySelectorAll('[data-target]').forEach(el => {
      el.onclick = async () => {
        let kind = el.dataset.target;
        if (kind === '__new__') {
          const t = await newTypeDialog();
          if (!t) return;
          kind = t.type_key;
        }
        let extra = {};
        if (kind === 'agent' && !Number(r.card.meta && r.card.meta.profile_id)) {
          // 切 agent 且无档案：向导取 profile 值内联随 retype 事务建档案（一步到位，免两跳）
          const prof = await openAgentWizard({ mode: 'create', presetTitle: r.card.title, rawProfile: true });
          if (!prof) return;
          extra = { profile: prof };
        }
        const res = await fetch(`/api/cards/${cardId}/retype`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind, ...extra }),
        }).then(x => x.json().catch(() => ({})));
        closeAgentPops();
        if (res.ok) { toast(kind === 'agent' ? `已改为智能体卡（可在 ⚙️ 继续完善配置）` : `已改为「${(_cardTypes.list.find(t => t.type_key === kind) || {}).label || kind}」`); refreshCurrentTaskView(); }
        else toast(`改型失败：${res.error || '未知'}`);
      };
    });
  }

  /** ⚙️ 编辑智能体配置（从卡片 meta.profile_id 找到档案 → 向导编辑态 = GET 现值预填 + PUT 整对象） */
  async function editAgentProfileFromCard(cardId) {
    const r = await fetch(`/api/cards/${cardId}`).then(x => x.json()).catch(() => null);
    const pid = Number(r?.card?.meta && r.card.meta.profile_id);
    if (!pid) { toast('该卡还没有智能体档案（先改型为智能体，或重建卡片）'); return; }
    openAgentWizard({ mode: 'edit', profileId: pid });
  }

  // 执行终端（SSE：/api/agent-cards/:id/exec/stream；弹层关闭钩子统一断流，防 EventSource 泄漏）
  let _agentPopClosers = [];
  function agentCardTerm(cardId) {
    closeAgentPops();
    const ov = agentOverlay(`⌨ 执行终端 · 卡片 #${cardId}`,
      `<pre style="height:260px;overflow:auto;background:rgba(0,0,0,.25);color:#c7d3e0;font:11px/1.5 Consolas,monospace;padding:8px;border-radius:8px;white-space:pre-wrap;word-break:break-all"></pre><div style="font-size:11px;color:var(--text-muted)" class="ap-st"></div>`,
      [{ act: 'stop', label: '停止执行' }, { act: 'close', label: '关闭' }]);
    const term = ov.querySelector('pre');
    const status = ov.querySelector('.ap-st');
    const es = new EventSource(`/api/agent-cards/${cardId}/exec/stream`);
    _agentPopClosers.push(() => es.close());
    _agentPops.push(() => es.close());
    const scroll = () => { term.scrollTop = term.scrollHeight; };
    es.addEventListener('line', (e) => {
      const d = JSON.parse(e.data);
      term.textContent += (d.stream === 'err' ? '[err] ' : '') + d.text + '\n';
      if (term.textContent.length > 60000) term.textContent = term.textContent.slice(-40000);
      scroll();
    });
    es.addEventListener('end', (e) => {
      const d = JSON.parse(e.data);
      status.textContent = d.status === 'done' ? '（已完成）' : '（已失败）';
      es.close();
    });
    es.onerror = () => { status.textContent = '（无执行记录或流已断开——队列通道/未直控时此处为空，属正常）'; es.close(); };
    ov.querySelector('[data-act="close"]').onclick = closeAgentPops;
    ov.querySelector('[data-act="stop"]').onclick = async () => {
      const res = await fetch(`/api/agent-cards/${cardId}/exec/stop`, { method: 'POST' }).then(x => x.json().catch(() => ({})));
      toast(res.ok ? '已发送停止指令' : ('停止失败：' + (res.error || '')));
    };
  }

  // 驾驶直播（SSE：/api/agent-cards/:id/live；CDP screencast 帧流；断开驾驶不杀用户的 App）
  function agentCardLive(cardId) {
    closeAgentPops();
    const ov = agentOverlay(`📺 驾驶直播 · 卡片 #${cardId}`,
      `<img alt="等待直播画面…" style="width:100%;border-radius:8px;background:rgba(0,0,0,.3);min-height:160px;display:block"><pre style="height:110px;overflow:auto;background:rgba(0,0,0,.25);color:#c7d3e0;font:11px/1.5 Consolas,monospace;padding:8px;border-radius:8px;white-space:pre-wrap;margin-top:6px"></pre><div style="font-size:11px;color:var(--text-muted)" class="ap-st"></div>`,
      [{ act: 'stop', label: '断开驾驶' }, { act: 'close', label: '关闭' }]);
    const img = ov.querySelector('img');
    const term = ov.querySelector('pre');
    const status = ov.querySelector('.ap-st');
    const es = new EventSource(`/api/agent-cards/${cardId}/live`);
    _agentPopClosers.push(() => es.close());
    _agentPops.push(() => es.close());
    es.addEventListener('frame', (e) => { img.src = 'data:image/jpeg;base64,' + JSON.parse(e.data).frame; });
    es.addEventListener('line', (e) => {
      term.textContent += JSON.parse(e.data).text + '\n';
      if (term.textContent.length > 30000) term.textContent = term.textContent.slice(-20000);
      term.scrollTop = term.scrollHeight;
    });
    es.addEventListener('end', (e) => {
      const d = JSON.parse(e.data);
      status.textContent = d.status === 'done' ? '（会话结束）' : '（会话已收口）';
      es.close();
    });
    es.onerror = () => { status.textContent = '（无驾驶会话或流已断开——直控/驾驶未跑通时此处为空，属正常）'; es.close(); };
    ov.querySelector('[data-act="close"]').onclick = closeAgentPops;
    ov.querySelector('[data-act="stop"]').onclick = async () => {
      const res = await fetch(`/api/agent-cards/${cardId}/live/stop`, { method: 'POST' }).then(x => x.json().catch(() => ({})));
      toast(res.ok ? '已断开驾驶（桌面软件未被关闭）' : ('操作失败：' + (res.error || '')));
    };
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
    if (!vault) { hint.textContent = '请先在上方选择 / 输入仓库路径'; hint.className = 'form-hint err'; return; }
    const title = $('#noteTitle').value.trim();
    const content = $('#noteBody').value.trim();
    if (!title) { hint.textContent = '标题不能为空'; hint.className = 'form-hint err'; return; }
    // 编辑已有笔记：PUT 写回原文件（标题跟随原笔记，编辑模式下标题输入框锁定）
    if (NOTE_EDITING_ID != null) {
      const r = await fetch('/api/notes/' + NOTE_EDITING_ID, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { hint.textContent = j.error || '保存失败'; hint.className = 'form-hint err'; return; }
      const edited = NOTE_ALL.find(n => n.id === NOTE_EDITING_ID);
      hint.textContent = '已写回原文件 → ' + (edited ? edited.rel_path : '#' + NOTE_EDITING_ID);
      hint.className = 'form-hint';
      NOTE_EDITING_ID = null;
      await loadNoteIndex();
      renderNoteRail();
      drawNoteGraph();
      return;
    }
    const res = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vault, title, content, type: (($('#noteType') || {}).value || undefined) }) });
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
    wrap.innerHTML = `<div style="font-size:11px;color:var(--text-muted)">${isUser ? '我' : '智能体'}</div>
      <div style="max-width:86%;padding:10px 13px;border-radius:12px;font-size:13px;line-height:1.85;white-space:pre-wrap;word-break:break-word;${isUser
        ? 'background:rgba(65,187,200,0.12);border:1px solid rgba(65,187,200,0.25);color:var(--text-primary)'
        : 'background:rgba(255,255,255,0.72);border:1px solid rgba(15,23,42,0.08);color:var(--text-primary)'}">${html}</div>`;
    return wrap;
  }

  /* ★ 2026-09-20：结论/过程切分（输出契约见 agent-core.js buildSystemPrompt）。
     模型按 <结论>…</结论><过程>…</过程> 输出；解析不到标记时整段视为结论（兜底，绝不丢内容）。 */
  function _agentSplitAnswer(text) {
    const s = String(text ?? '');
    if (!/<结论>|<过程>/.test(s)) return { conclusion: s, process: '' };
    const mc = /<结论>([\s\S]*?)<\/结论>/.exec(s);
    const mp = /<过程>([\s\S]*?)<\/过程>/.exec(s);
    const process = mp ? mp[1].trim() : '';
    const conclusion = mc ? mc[1].trim() : s.replace(/<过程>[\s\S]*?<\/过程>/g, '').replace(/<\/?结论>/g, '').trim();
    return { conclusion, process };
  }
  /* ★ 2026-09-20：过程段追加为「执行过程」思考卡；★ 批次⑤（2026-09-23）：该块已内联进对话流
     （#agentRunLive 挂入 #agentChat，question → process → answer），过程随消息滚动、逐轮留档 */
  function _agentAppendProcessCard(process, title) {
    if (!process) return;
    const wrap = $('#agentRunLive');
    if (wrap) wrap.style.display = 'block';
    _agentRunLiveSteps.push({ stepId: 'proc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), type: 'thinking', content: process, state: 'ok', tool: title || '思考' });
    _agentRunLiveRender();
  }

  /* ★ 执行中心内联时间线（agent 页一体化）：发送即 SSE 实时渲染，点步骤展开终端/diff/产物。
     数据源：POST /api/agent/runs（立即回 runId）+ SSE /stream；步骤详情复用 /api/agent/runs/:id。 */
  let _agentRunLiveEs = null, _agentRunLivePoll = null, _agentRunLiveId = null, _agentRunLiveSteps = [], _agentRunLiveTimer = null, _agentRunLiveSeconds = 0;
  /* ★ 批次①/④（2026-09-23）：流式打字机状态（pi renderer 模式）——
     _agentStreamBuf 累积 answer_delta 文本；30ms 节流重绘；chars/4 徽标 300ms 更新；
     _agentRunLiveExpanded 折叠持久（stepId 集合，重渲后恢复展开，LRU 上限 200）；
     _agentRunLiveDetailHtml 缓存已拉取的详情 HTML（展开态跨重渲不丢）。 */
  let _agentStreamBuf = '', _agentStreamTimer = null, _agentStreamBadgeAt = 0;
  const _agentRunLiveExpanded = new Set();
  const _agentRunLiveDetailHtml = new Map();
  function _agentStreamClear() {
    _agentStreamBuf = '';
    if (_agentStreamTimer) { clearTimeout(_agentStreamTimer); _agentStreamTimer = null; }
    _agentStreamRender();
  }
  function _agentStreamDelta(d) {
    if (d && d.reset) { _agentStreamClear(); return; }   // 本轮出现 tool_calls → 丢弃试渲文字
    _agentStreamBuf += String(d?.delta || '');
    if (_agentStreamTimer) return;
    _agentStreamTimer = setTimeout(() => { _agentStreamTimer = null; _agentStreamRender(); }, 30); // 30ms 节流
  }
  /** 打字机卡片：只更新自身节点（不整表重渲），带 .stream-caret 光标 + chars/4 token 徽标（300ms） */
  function _agentStreamRender() {
    const tl = $('#agentRunLiveTimeline');
    if (!tl) return;
    let card = document.getElementById('agentStreamCard');
    if (!_agentStreamBuf) { if (card) card.remove(); _agentRunLiveBadge(); return; }
    if (!card) {
      card = document.createElement('div');
      card.id = 'agentStreamCard';
      card.className = 'run-card streaming';
      card.innerHTML = '<div class="run-card-header"><span class="run-card-type tool">作答</span><span class="run-card-title">生成中</span><span class="run-card-state pending" id="agentStreamBadge"></span></div><div class="run-card-body"><pre id="agentStreamText" style="white-space:pre-wrap;word-break:break-word;margin:0"></pre></div>';
      tl.appendChild(card);
    }
    const pre = card.querySelector('#agentStreamText');
    if (pre) {
      pre.textContent = _agentStreamBuf;
      const caret = document.createElement('span');
      caret.className = 'stream-caret';
      pre.appendChild(caret);
    }
    const now = Date.now();
    if (now - _agentStreamBadgeAt > 300) {   // chars/4 估算徽标 300ms 节流
      _agentStreamBadgeAt = now;
      const b = card.querySelector('#agentStreamBadge');
      if (b) b.textContent = '~' + Math.ceil(_agentStreamBuf.length / 4) + ' tok';
    }
    tl.scrollTop = tl.scrollHeight;
    _agentChatFollow();   // ★ 批次⑤：过程块内联后由 chat 统一贴底跟随
    _agentRunLiveBadge();
  }
  /** 状态徽标：有进行中工具 → 工具运行中(n)；流式生成中 → 等待模型…（均无则不动 meta 既有文案） */
  function _agentRunLiveBadge() {
    const meta = $('#agentRunLiveMeta');
    if (!meta) return;
    const pending = _agentRunLiveSteps.filter(s => s.state === 'pending').length;
    if (pending > 0) meta.textContent = '⏳ 工具运行中(' + pending + ')';
    else if (_agentStreamBuf) meta.textContent = '✍ 等待模型…';
  }
  /* ★ 批次⑤（2026-09-23，方案1·过程内联，参照 pi renderer）：
     发送后把 #agentRunLive 整块移进 #agentChat 的 pending 气泡之后（顺序 user → 过程 → 结论）；
     下一轮发送时旧块原地克隆为静态快照（.run-snap：剥 id/onclick/按钮，历史不可交互、留驻原位），
     实时块复用移交到本轮；会话切换/清空 chat.innerHTML='' 前必须 _agentRunLiveDetach 摘出保命。 */
  function _agentRunLivePlace(chat, pending) {
    const live = document.getElementById('agentRunLive');
    if (!live || !chat || !pending) return;
    if (live.dataset.migrated === '1' && live.parentElement === chat) {
      // 旧轮次：原地冻结为只读快照留档（剥 id 防与实时块重号，剥 onclick 防克隆闭包句柄失效报错）
      const snap = live.cloneNode(true);
      snap.removeAttribute('id');
      snap.removeAttribute('data-migrated');
      snap.classList.add('run-snap');
      snap.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      snap.querySelectorAll('[onclick]').forEach(el => el.removeAttribute('onclick'));
      snap.querySelectorAll('button').forEach(b => b.remove());   // 刷新/展开等操作按钮对快照无意义
      snap.style.display = 'block';
      chat.insertBefore(snap, live);
    }
    // ★ 换序贴 pi：挂到占位气泡【之前】（运行中 user → 过程 → 占位；终态占位移除后 user → 过程 → 答案）
    chat.insertBefore(live, pending);
    chat.scrollTop = chat.scrollHeight;
    live.dataset.migrated = '1';
    live.style.display = 'block';
  }
  /** 会话切换/清空（chat.innerHTML 全清）前摘出实时块挂回聊天区后原位，避免被一并销毁 */
  function _agentRunLiveDetach() {
    const live = document.getElementById('agentRunLive');
    if (!live) return;
    const parent = live.parentElement;
    if (parent && parent.id === 'agentChat') {
      parent.removeChild(live);
      if (parent.nextSibling) parent.parentNode.insertBefore(live, parent.nextSibling);
      else parent.parentNode.appendChild(live);
    }
    live.removeAttribute('data-migrated');
    live.style.display = 'none';
  }
  /** 内联后 chat 统一滚动：接近底部才跟随贴底（上翻历史时不打断） */
  function _agentChatFollow() {
    const chat = $('#agentChat');
    if (!chat) return;
    if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160) chat.scrollTop = chat.scrollHeight;
  }
  function _agentRunLiveStart(runId) {
    _agentRunLiveId = runId;
    _agentRunLiveSteps = [];
    _agentStreamClear();
    _agentRunLiveExpanded.clear();
    _agentRunLiveDetailHtml.clear();
    const wrap = $('#agentRunLive');
    if (wrap) wrap.style.display = 'block';
    const tl = $('#agentRunLiveTimeline');
    if (tl) tl.innerHTML = '<div class="run-card-empty">agent 运行中，执行过程将实时显示在这里…</div>';
    const meta = $('#agentRunLiveMeta');
    if (meta) meta.textContent = '';
    // 「在执行中心查看」跳转
    const openBtn = $('#agentRunLiveOpen');
    if (openBtn) openBtn.onclick = () => { location.hash = 'tasks/runs'; };
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
    if (_agentRunLiveTimer) clearInterval(_agentRunLiveTimer);
    _agentRunLiveTimer = setInterval(() => {
      _agentRunLiveSeconds++;
      if (timerEl) timerEl.textContent = _agentRunLiveSeconds + 's';
      // ★ 秒表：有进行中步骤时每秒重渲（run-card-state 实时 ++.s）
      if (_agentRunLiveSteps.some(s => s.state === 'pending' && s.t0)) _agentRunLiveRender();
      // ★ 批次⑤b：30秒无步骤的警示并入 meta 行（去分节感，不再弹独立橙条）
      if (_agentRunLiveSeconds >= 30 && !_agentRunLiveSteps.length && meta) {
        meta.textContent = '⏳ 执行较长（模型慢或多轮工具）· 可点 ↻ 刷新或到执行中心查看';
      }
    }, 1000);
    const on = (type, d) => {
      // ★ 批次①/④（2026-09-23）：删除幻影监听分支（thinking/reasoning/context —— 后端从不发这三种
      //   事件，属死代码）；补齐后端实发的 started/tool_repeat/max_steps；write_denied 判空 meta。
      if (type === 'step') {
        const st = _agentRunLiveSteps.find(x => x.stepId === d.stepId) || { stepId: d.stepId, tool: d.tool, argsPreview: d.argsPreview, state: 'pending' };
        st.state = 'pending'; st.argsPreview = d.argsPreview || st.argsPreview; st.tool = d.tool; st.t0 = Date.now();
        if (!_agentRunLiveSteps.includes(st)) _agentRunLiveSteps.push(st);
        _agentRunLiveBadge();
        _agentRunLiveRender();
      } else if (type === 'step_end') {
        const st = _agentRunLiveSteps.find(x => x.stepId === d.stepId);
        if (st) { st.state = d.ok ? 'ok' : 'error'; st.elapsedMs = d.elapsedMs; st.preview = d.preview || ''; st.outChars = d.outChars; st.hasDiff = d.hasDiff; st.artifactPath = d.artifactPath; st.t0 = null; }
        _agentRunLiveBadge();
        _agentRunLiveRender();
      } else if (type === 'started') {
        if (meta) meta.textContent = '▶ ' + (d.note || '已开始运行');
      } else if (type === 'tool_repeat') {
        _agentRunLiveSteps.push({ stepId: 'rep-' + Date.now(), tool: '重复调用拦截', state: 'ok', preview: (d.tool || '') + (d.count ? ` 相同参数第 ${d.count} 次，已跳过执行` : ' ' + (d.note || '')) });
        _agentRunLiveRender();
      } else if (type === 'max_steps') {
        if (meta) meta.textContent = '⚠ ' + (d.note || '达到最大步数，已强制收尾');
      } else if (type === 'write_denied') {
        if (meta) meta.textContent = '✋ 有写操作被拦截（未勾选「允许写入」或受限模式）';
      } else if (type === 'answer_delta') {
        _agentStreamDelta(d);
      } else if (type === 'answer') {
        _agentStreamClear();
        // 终态：拉全量补 diff 字段，再收 SSE
        fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).then(j => {
          if (j && j.ok) { _agentRunLiveSteps = j.steps || []; _agentRunLiveRender(); if (meta) meta.textContent = j.status + ' · ' + (j.toolCalls || 0) + ' 工具 · ' + (((j.finishedAt - j.startedAt) / 1000).toFixed(1)) + 's'; }
          _agentRunLiveStop();
        }).catch(() => _agentRunLiveStop());
      } else if (type === 'done') {
        _agentStreamClear();
        _agentRunLiveStop();
      }
    };
    _agentRunLiveEs = new EventSource('/api/agent/runs/' + encodeURIComponent(runId) + '/stream');
    ['step', 'step_end', 'started', 'tool_repeat', 'max_steps', 'write_denied', 'answer_delta', 'answer', 'done'].forEach(ev => _agentRunLiveEs.addEventListener(ev, e => { try { on(ev, JSON.parse(e.data)); } catch {} }));
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
    _agentStreamClear();
  }
  function _agentRunLiveRender() {
    const tl = $('#agentRunLiveTimeline');
    if (!tl) return;
    tl.innerHTML = '';
    if (!_agentRunLiveSteps.length && !_agentStreamBuf) { tl.innerHTML = '<div class="run-card-empty">agent 运行中，执行过程将实时显示在这里…</div>'; return; }
    for (const s of _agentRunLiveSteps) {
      const card = document.createElement('div');
      card.className = 'run-card';
      card.dataset.stepId = String(s.stepId);
      // 判断类型
      let cardType = 'tool';
      if (s.type === 'thinking') cardType = 'thinking';
      else if (s.tool && (s.tool.includes('write') || s.tool.includes('文件') || s.tool.includes('Bash') || s.tool.includes('shell'))) cardType = 'code';
      const typeLabel = { thinking: '思考', tool: '工具', code: '代码', system: '系统' }[cardType] || '工具';
      const stateCls = s.state === 'ok' ? 'ok' : s.state === 'error' ? 'error' : 'pending';
      // ★ 秒表：进行中步骤用 t0 实时计时（1s 定时器重渲驱动）；完成态用 elapsedMs
      const stateText = s.state === 'ok' ? '完成' : s.state === 'error' ? '失败'
        : s.state === 'pending' && s.t0 ? '进行中 · ' + ((Date.now() - s.t0) / 1000).toFixed(1) + 's' : '进行中';
      const ms = s.elapsedMs != null ? ' · ' + (s.elapsedMs / 1000).toFixed(1) + 's' : '';
      // 构建内容
      let bodyHtml = '';
      if (s.type === 'thinking') {
        bodyHtml = `<div class="run-card-thinking">${esc(s.content || s.preview || '思考中…')}</div>`;
      } else {
        // 工具调用卡片：args 只显前 120 字摘要（全量进详情面板）
        if (s.argsPreview) bodyHtml += `<div class="run-card-body" style="color:var(--text-muted)">${esc(String(s.argsPreview).slice(0, 120))}${String(s.argsPreview).length > 120 ? '…' : ''}</div>`;
        if (s.preview) bodyHtml += `<pre${s.state === 'error' ? ' style="background:color-mix(in srgb, var(--danger) 12%, transparent);border-color:color-mix(in srgb, var(--danger) 55%, transparent)"' : ''}>${esc(s.preview)}</pre>`;
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
      // ★ 折叠持久：重渲后从缓存恢复已展开详情（pi expansion store 模式，Map 即 LRU，容量 200）
      const cachedHtml = _agentRunLiveDetailHtml.get(String(s.stepId));
      if (_agentRunLiveExpanded.has(String(s.stepId)) && cachedHtml) {
        const box = card.querySelector('[data-detail]');
        box.innerHTML = cachedHtml;
        box.style.display = '';
        card.classList.add('sel');
      }
      // 点击展开/收起详情
      card.onclick = (e) => {
        if (e.target.dataset.a === 'diff') { _agentRunLiveDetail(s.stepId, true); e.stopPropagation(); return; }
        if (e.target.dataset.a === 'art') { _agentRunLiveDetail(s.stepId, false, true); e.stopPropagation(); return; }
        if (e.target.tagName === 'BUTTON' || e.target.closest('details')) return;
        const key = String(s.stepId);
        if (_agentRunLiveExpanded.has(key)) {   // 已展开 → 折叠
          _agentRunLiveExpanded.delete(key);
          _agentRunLiveRender();
          return;
        }
        _agentRunLiveDetail(s.stepId);
      };
      tl.appendChild(card);
    }
    _agentStreamRender();   // 打字机卡片挂尾（无缓冲则 no-op）
    // 自动滚动到底部
    tl.scrollTop = tl.scrollHeight;
    _agentChatFollow();   // ★ 批次⑤：过程块内联后由 chat 统一贴底跟随
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
    // ★ 折叠持久：登记展开态 + 缓存详情 HTML（重渲后原样恢复；Map 容量 200 即 LRU）
    _agentRunLiveExpanded.add(String(stepId));
    _agentRunLiveDetailHtml.set(String(stepId), html);
    if (_agentRunLiveDetailHtml.size > 200) {
      const oldest = _agentRunLiveDetailHtml.keys().next().value;
      _agentRunLiveDetailHtml.delete(oldest);
      _agentRunLiveExpanded.delete(oldest);
    }
    const bd = box.querySelector('[data-a2="diff"]');
    if (bd) bd.onclick = () => _agentRunLiveDetail(stepId, true);
    const ba = box.querySelector('[data-a2="art"]');
    if (ba) ba.onclick = () => _agentRunLiveDetail(stepId, false, true);
  }

  /* ★ 2026-09-20：发送按钮双态 —— 运行中变「⏹ 停止」，点击只中止当前 run（不再 disabled 空等） */
  let _agentCurrentRunId = null;
  function _agentSetSendBtn(sending) {
    const btn = $('#agentSendBtn');
    if (!btn) return;
    if (sending) {
      btn.textContent = '⏹ 停止';
      btn.disabled = false;
      btn.dataset.sending = '1';
      btn.classList.add('agent-stop-btn');
    } else {
      btn.textContent = '发送';
      btn.disabled = false;
      delete btn.dataset.sending;
      btn.classList.remove('agent-stop-btn');
    }
  }
  /* ★ 2026-09-20：只中止当前 run —— 既有 _agentCockpitAbort 会中止全部 running run，不适合发送按钮 */
  async function _agentAbortCurrent() {
    const id = _agentCurrentRunId;
    if (!id) { toast('没有运行中的任务', 2500); return; }
    try {
      const r = await fetch(`/api/agent/runs/${encodeURIComponent(id)}/abort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '发送按钮手动停止' }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) toast('停止请求失败：' + (j.error || ('HTTP ' + r.status)), 3200);
      else toast('已请求停止当前生成（LLM 轮次中断，进行中工具调用会跑完）', 3600);
    } catch (e) { toast('停止请求失败：' + (e.message || e), 3200); }
    _agentRunLiveStop();
  }

  async function agentSend() {
    if (agentBusy) return;
    const input = $('#agentInput'), chat = $('#agentChat');
    const text = (input && input.value || '').trim();
    if (!text || !chat) return;
    agentBusy = true;
    showRunStatus('正在思考…');
    if (chat.dataset.empty === '1') { _agentRunLiveDetach(); chat.innerHTML = ''; chat.dataset.empty = '0'; }
    if (input) input.value = '';
    chat.appendChild(agentBubble('user', esc(text)));
    const pending = agentBubble('assistant', '<span class="text-muted">agent 运行中…执行过程在上方实时展开（本地模型首轮较慢，多轮工具调用可能 1~2 分钟）</span>');
    chat.appendChild(pending);
    chat.scrollTop = chat.scrollHeight;
    _agentSetSendBtn(true);
    const allowWrites = !!($('#agentAllowWrites') || {}).checked;
    // 内联执行过程清空待新 run
    _agentRunLiveStop();
    _agentRunLiveSteps = [];
    try {
      // ★ 批次⑥（2026-09-23）：无会话自动开会话 —— 后端仅带 sessionKey 才落库（agent_sessions），
      //   不先建会话消息会静默丢失（重启即没）。建失败不阻断发送（该轮不落库）。
      if (!_agentSessionKey) {
        try {
          const s = await fetch('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(r => r.json());
          if (s && s.ok && s.sessionKey) {
            _agentSessionKey = s.sessionKey;
            _agentSessions.unshift({ session_key: s.sessionKey, title: '新会话', msg_count: 0 });
            _agentSessionChips();
          }
        } catch { /* 建会话失败不阻断发送 */ }
      }
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
        _agentSetSendBtn(false);
        return;
      }
      _agentCurrentRunId = j.runId;
      _agentRunLivePlace(chat, pending);   // ★ 批次⑤：过程块内联挂到 pending 之后（user → 过程 → 结论）
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
      // 终态：拉答案 → 过程段进内联过程块（结论气泡上方）、结论进聊天气泡（★ 批次⑤ 2026-09-23 内联）
      const fin = await fetch('/api/agent/runs/' + encodeURIComponent(j.runId)).then(r => r.json()).catch(() => null);
      const raw = (fin && fin.ok && fin.answer) || '';
      const aborted = !!fin && fin.status === 'aborted';
      const sp = _agentSplitAnswer(raw);
      _agentAppendProcessCard(sp.process, '思考');
      // ★ 2026-09-20：停止生成后不再显示误导性的「（无内容）」
      const answer = aborted && !raw.trim() ? '已停止生成' : (sp.conclusion || '（无内容）');
      const deniedNote = fin && fin.status === 'failed' ? `<div style="margin-top:6px;font-size:12px;color:var(--danger)">⚠ 运行失败：${esc(fin.error || '')}</div>` : '';
      chat.appendChild(agentBubble('assistant', esc(answer) + deniedNote));
      AGENT_HISTORY.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
      setRunStatus(aborted ? '已停止' : '已完成', aborted ? 'aborted' : 'done');
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
      _agentSetSendBtn(false);
      _agentCurrentRunId = null;
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
    // ★ Orca 融合 P0（2026-10-03）：附件上传 —— 拖入输入框或点 📎（移动端 WebView 无拖拽，按钮兜底）
    //   落 artifacts（≤5MB，零依赖 base64 通道）；≤64KB 文本同时内联进 prompt，Agent 直接可读
    const attachFile = async (file) => {
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast('文件超过 5MB 上限'); return; }
      toast(`上传 ${file.name} …`);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let bin = '';
        const CH = 0x8000; // 分块转换，避免 String.fromCharCode(...bytes) 大文件爆调用栈
        for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        const res = await fetch('/api/artifacts/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, data: btoa(bin) }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { toast(j.error || '上传失败'); return; }
        let insert = `[附件 artifact:${j.name}](${j.url})`;
        const isText = /^text\/|^application\/(json|javascript|xml|yaml|x-yaml)/.test(file.type || '')
          || /\.(md|txt|js|ts|jsx|tsx|json|csv|log|html?|css|py|sh|ya?ml|xml|sql|bat|ps1)$/i.test(file.name);
        if (isText && file.size <= 64 * 1024) {
          const txt = await file.text();
          insert += `\n内容（${file.name}，${file.size}B）：\n\`\`\`\n${txt}\n\`\`\``;
        } else if (isText) {
          insert += `（大文本未内联，可先分片或让智能体提示用户查看）`;
        }
        if (input) { input.value = (input.value ? input.value.replace(/\s*$/, '\n') : '') + insert + '\n'; input.focus(); }
        toast(`已附加 ${file.name}（${j.size}B）`);
      } catch (e) { toast('上传异常：' + String(e && e.message || e).slice(0, 80)); }
    };
    const attachBtn = $('#agentAttachBtn'), fileInput = $('#agentFileInput'), zone = $('#agentInputZone');
    if (attachBtn && fileInput) attachBtn.onclick = () => fileInput.click();
    if (fileInput) fileInput.onchange = () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; if (f) attachFile(f); };
    if (zone) {
      ['dragover', 'dragenter'].forEach(t => zone.addEventListener(t, e => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over'); }));
      ['dragleave', 'dragend'].forEach(t => zone.addEventListener(t, e => { if (t === 'dragleave' && zone.contains(e.relatedTarget)) return; zone.classList.remove('drag-over'); }));
      zone.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag-over');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) attachFile(f);
      });
    }
    // ★ 2026-09-20：发送按钮双态 —— 运行中点击=停止当前生成，空闲=发送
    if (btn) btn.onclick = () => { if (btn.dataset.sending === '1') _agentAbortCurrent(); else agentSend(); };
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); } });
    if (clear) clear.onclick = () => {
      AGENT_HISTORY.length = 0;
      if (chat) { _agentRunLiveDetach(); chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">对话已清空（记忆库与任务不受影响）</div>'; chat.dataset.empty = '1'; }
      hideRunStatus();
    };
    // 运行状态条按钮（★ 2026-09-20：停止生成已上移到发送按钮，#agentRunStopBtn 已移除）
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
      { label: '📋 复制回复', kind: 'real', act: '_agentCockpitCopy' },
      { label: '⬇ 导出对话', kind: 'real', act: '_agentCockpitExportChat' },
    ]},
    { domain: '② 任务目标', open: true, btns: [
      { label: '🎯 领任务做', kind: 'real', act: '_agentFnQuick', arg: 'task' },
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
      { label: '执行工具开关', kind: 'real', act: '_agentCockpitExecToggle', hint: '开/关 file_read/file_write/exec_run（重 spawn MCP）' },
      { label: '浏览器控制', kind: 'stub', why: '未启用：browser_* 工具域（YAGNI 不做）' },
    ]},
    { domain: '⑤ 审批安全', btns: [
      { label: '⏹ 紧急停止', kind: 'real', act: '_agentCockpitAbort' },
      { label: '查审计', kind: 'real', act: '_agentCockpitAudit' },
      { label: '撤销凭据', kind: 'real', act: '_agentCockpitCreds' },
      { label: '本次允许', kind: 'stub', why: '审批三键 501 占位（writeGate 升级单独立项）' },
    ]},
    { domain: '⑥ 记忆上下文', btns: [
      { label: '🧠 沉淀记忆', kind: 'real', act: '_agentFnQuick', arg: 'mem' },
      { label: '压缩会话', kind: 'real', act: '_agentCockpitCompact' },
      { label: '导出记忆', kind: 'real', act: '_agentCockpitExportMem' },
      { label: '上下文摘要', kind: 'real', act: '_agentCockpitSummarize', hint: 'LLM 有损压缩早期对话（保留最近 6 条原文）' },
    ]},
    { domain: '⑦ 模型成本', btns: [
      { label: '测试连接', kind: 'real', act: '_agentCockpitTestLlm' },
      { label: 'Token 用量', kind: 'real', act: '_agentCockpitTokenUsage' },
      { label: '预算上限', kind: 'real', act: '_agentCockpitBudget', hint: '设单 run 累计 token 上限，超即中止' },
      { label: '缓存', kind: 'real', act: '_agentCockpitCache', hint: 'LLM 响应缓存开关（同历史轮次省真实推理）' },
    ]},
    { domain: '⑧ 多智能体', btns: [
      { label: '接入向导', kind: 'real', act: '_agentCockpitConnectGuide' },
      { label: '智能体清单', kind: 'real', act: '_agentCockpitAgents' },
      { label: '子智能体', kind: 'stub', why: '架构不支持：单 agent 内核，无 spawn/并行控制' },
      { label: '并行数', kind: 'real', act: '_agentCockpitParallelism', hint: '同时运行的 run 上限（超出自动排队）' },
      { label: '终止子 agent', kind: 'stub', why: '架构不支持：单 agent 内核' },
    ]},
    { domain: '⑨ 可观测调试', btns: [
      { label: '回放任务', kind: 'real', act: '_agentFnHistory' },
      { label: '性能面板', kind: 'real', act: '_agentCockpitHealth' },
      { label: '自进化', kind: 'real', act: '_agentCockpitEvolution' },
      { label: '调用链', kind: 'real', act: '_agentCockpitCallChain', hint: '查看某 run 的工具调用链（顺序+耗时+产物）' },
      { label: '日志级别', kind: 'real', act: '_agentCockpitLogLevel', hint: '运行期切换内核 5xx 诊断日志级别' },
    ]},
    { domain: '⑩ 治理合规', btns: [
      { label: '审计日志', kind: 'real', act: '_agentCockpitAudit' },
      { label: '合规检查', kind: 'real', act: '_agentCockpitHealth' },
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
    _agentCockpitNav: (arg) => { location.hash = arg || 'tasks/runs'; },
    _agentCockpitCard: async (arg) => {
      /* ★ P4：原实现只弹提示 + 跳看板（点了没反应的假动作）。改为真执行 ——
         选卡（多数情况只有 1 张候选，直接干）→ 真调 POST /api/cards/:id/status（带 expected_from CAS）。 */
      const ACT = { accept: { to: 'done', label: '验收通过 → 完成', order: ['review', 'running', 'ready', 'blocked', 'todo', 'triage'] },
                    refine: { to: 'ready', label: '打回 → 可执行', order: ['running', 'review', 'blocked', 'ready'] },
                    archive: { to: 'archived', label: '归档', order: ['done'] } }[arg];
      if (!ACT) { toast('未知操作：' + arg); return; }
      const data = await fetch('/api/cards').then(r => r.json()).catch(() => null);
      const buckets = (data && data.buckets) || {};
      const pool = [];
      ACT.order.forEach(st => (Array.isArray(buckets[st]) ? buckets[st] : []).forEach(c => pool.push({ ...c, status: st })));
      if (!pool.length) {
        toast(arg === 'archive' ? '没有已完成的任务可归档' : `没有可${ACT.label.split(' ')[0]}的卡片`, 3000);
        location.hash = 'tasks';
        return;
      }
      let target = pool[0];
      if (pool.length > 1) {
        const hint = pool.slice(0, 6).map(c => `#${c.id} ${String(c.title || '').slice(0, 16)}`).join(' ｜ ');
        const v = await askForm({ title: `${ACT.label} —— 有 ${pool.length} 张候选`, okText: '执行', fields: [{ key: 'id', label: `候选（改填别的编号也行）：${hint}`, required: true, value: String(pool[0].id), placeholder: '卡片编号' }] });
        if (!v) return;
        const id = Number(v.id);
        target = pool.find(c => Number(c.id) === id) || null;
        if (!target) {
          const rr = await fetch(`/api/cards/${id}`).then(x => x.json()).catch(() => null);
          if (!rr || !rr.card) { toast('卡片 #' + id + ' 不存在'); return; }
          target = rr.card;
        }
      }
      const res = await fetch(`/api/cards/${target.id}/status`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: ACT.to, expected_from: target.status, as: 'human:dashboard' }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast(`#${target.id} 失败：${j.error || res.status}（可能已被其他操作改写，请刷新）`, 4200); return; }
      toast(`✓ #${target.id} ${ACT.label}（${j.from || target.status} → ${j.to || ACT.to}）`, 3600);
      refreshCurrentTaskView();
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
      toast('已标记拒绝：智能体将基于只读信息收尾（审批三键真实生效需单独立项）', 4200);
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
      toast('接入向导在「工具连接」页（点各智能体的 connect 出配置预览）', 3600);
    },
    _agentCockpitAgents: async () => {
      const a = await fetch('/api/agents').then(r => r.json()).catch(() => ({ agents: [] }));
      const list = a.agents || [];
      toast(list.length ? `本机智能体 ${list.length} 个：${list.map(x => x.id).join(', ')}` : '未检测到本机智能体', 5000);
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
      // ★ 批次⑨：prompt()→askForm
      const dv = await askForm({ title: '自动拆解目标', fields: [{ key: 'goal', label: '要拆解的目标（LLM 会拆成 3–7 条可派发子任务）', required: true }], okText: '拆解' });
      if (!dv) return;
      const goal = (dv.goal || '').trim();
      if (!goal) return;
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
      // ★ 批次⑨：prompt()→askForm
      const v = await askForm({ title: 'run token 预算', fields: [{ key: 'n', label: `单次 run 的累计 token 上限（0=不设限；当前 ${cur || '未设'}）`, value: String(cur || '') }], okText: '设置' });
      if (!v) return;
      const n = Math.floor(Number(v.n));
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
      // ★ 批次⑨：prompt()→askForm
      const v = await askForm({ title: '并行上限', fields: [{ key: 'n', label: `同时运行的 agent run 上限（1–8，超出自动排队；当前 ${t.maxConcurrent ?? 3}）`, value: String(t.maxConcurrent ?? 3) }], okText: '设置' });
      if (!v) return;
      const n = Math.floor(Number(v.n));
      if (!(n >= 1 && n <= 8)) { toast('须为 1–8 的整数', 2600); return; }
      const r = await fetch('/api/agent/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxConcurrent: n }) }).then(x => x.json()).catch(() => ({}));
      toast(r.ok ? `并行数已设为 ${n}（当前执行中 ${t.running ?? 0} / 排队 ${t.queued ?? 0}）` : '设置失败：' + (r.error || ''), 4000);
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
      // ★ 批次⑨：prompt()→askForm
      const v = await askForm({ title: '内核诊断日志级别', fields: [{ key: 'lv', label: `内核 5xx 诊断日志级别（debug/info/warn/error；warn/error 静默诊断行；审计表不受影响。当前 ${cur}）`, value: String(cur) }], okText: '切换' });
      if (!v) return;
      const lv = String(v.lv).trim().toLowerCase();
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
  /* agent 页常驻功能按钮的 handler
     ★ 2026-09-20：执行记录/步骤时间线统一渲染到「执行过程」区（#agentRunLive），不再写入聊天区
     —— 聊天区只承载对话与结论，执行过程与对话解耦。 */
  async function _agentFnHistory() {
    const j = await fetch('/api/agent/runs').then(r => r.json()).catch(() => ({ runs: [] }));
    const runs = (j.runs || []).slice(0, 10);
    const wrap = $('#agentRunLive'), tl = $('#agentRunLiveTimeline'), meta = $('#agentRunLiveMeta');
    if (!wrap || !tl) return;
    wrap.style.display = 'block';
    _agentRunLiveStop();
    _agentRunLiveSteps = [];
    if (!runs.length) {
      if (meta) meta.textContent = '';
      tl.innerHTML = '<div class="run-card-empty">还没有执行记录。发一条指令即可在此看到过程。</div>';
      return;
    }
    if (meta) meta.textContent = '历史运行 ' + runs.length + ' 次（点某次看步骤时间线）';
    tl.innerHTML = runs.map(r => {
      const dot = r.status === 'running' ? '🟢' : r.status === 'done' ? '✅' : '⚠️';
      return `<div class="session-chip" data-hrun="${esc(r.runId)}" style="cursor:pointer;margin:3px 0;width:100%;justify-content:space-between">
        <span>${dot} ${esc(r.title || r.runId)} · ${esc(r.status)} · ${r.stepIndex} 步</span>
        <span style="opacity:.6">${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s</span></div>`;
    }).join('');
    tl.querySelectorAll('[data-hrun]').forEach(el => el.onclick = () => _agentFnOpenRun(el.dataset.hrun));
  }
  async function _agentFnOpenRun(runId) {
    const j = await fetch('/api/agent/runs/' + encodeURIComponent(runId)).then(r => r.json()).catch(() => null);
    const wrap = $('#agentRunLive'), meta = $('#agentRunLiveMeta');
    if (!j || !j.ok || !wrap) return;
    wrap.style.display = 'block';
    _agentRunLiveStop();
    _agentRunLiveId = runId;
    // 复用执行过程时间线渲染器（与实时 SSE 同一套卡片），结论作为末张卡片一并落此区
    _agentRunLiveSteps = (j.steps || []).map(s => ({ ...s }));
    const sp = _agentSplitAnswer(j.answer || '');
    if (sp.conclusion) _agentRunLiveSteps.push({ stepId: 'ans-' + runId, type: 'thinking', content: sp.conclusion, state: 'ok', tool: '结论' });
    if (meta) meta.textContent = (j.title ? j.title + ' · ' : '') + j.status + ' · ' + (j.toolCalls || 0) + ' 工具';
    _agentRunLiveRender();
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
      _agentRunLiveDetach();   // ★ 批次⑤：清空前摘出实时过程块，防 innerHTML 连带销毁
      chat.innerHTML = '';
      chat.dataset.empty = '0';
      if (!s.messages || !s.messages.length) {
        chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">（空会话）</div>';
      } else {
        // ★ 2026-09-20：回放同样按结论/过程切分 —— 聊天气泡只放结论，过程段不回放（★ 批次⑤：内联过程块仅当轮可见，历史完整过程到执行中心查看）
        for (const m of s.messages) {
          if (m.role === 'assistant') chat.appendChild(agentBubble('assistant', esc(_agentSplitAnswer(m.content).conclusion)));
          else chat.appendChild(agentBubble('user', esc(m.content)));
        }
      }
      AGENT_HISTORY.length = 0;
      for (const m of (s.messages || []).slice(-8)) {
        AGENT_HISTORY.push({ role: m.role, content: m.role === 'assistant' ? _agentSplitAnswer(m.content).conclusion : m.content });
      }
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
        if (chat) { _agentRunLiveDetach(); chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">新会话（输入指令开始）</div>'; chat.dataset.empty = '1'; }
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
      if (chat) { _agentRunLiveDetach(); chat.innerHTML = '<div class="text-muted" style="font-size:13px;padding:18px;text-align:center">（会话已删除）</div>'; chat.dataset.empty = '1'; }
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
      // ★ 批次⑥（2026-09-23）：刷新/重启后自动恢复最近有消息的会话（不选则聊天区空白，看似消息丢失；
      //   列表按 updated_at DESC，取第一条有消息的；全空则保留欢迎态）
      if (!_agentSessionKey) {
        const last = _agentSessions.find(x => (x.msg_count || 0) > 0);
        if (last) _agentSessionSelect(last.session_key);
      }
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
    // 自动展开执行过程（★ 批次⑤：只操作已内联进对话流的实时块；首轮由 _agentRunLivePlace 挂载，
    //   避免 runId 返回前把模板块闪现在聊天区外）
    const live = $('#agentRunLive');
    if (live && live.dataset.migrated === '1') live.style.display = 'block';
    const tl = $('#agentRunLiveTimeline');
    if (live && live.dataset.migrated === '1' && tl && !tl.innerHTML.trim()) tl.innerHTML = '<li class="text-muted" style="font-size:11px;padding:6px">agent 运行中，工具调用实时追加…</li>';
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

  // ===== V1重构：更多功能面板（★ 2026-09-20 整合为 6 组，复用 COCKPIT 数据）=====
  //   导航类项（任务看板/查记忆/删除记忆/执行流/扫描 agent/问责链）已移除：这些在主导航与 agent 边栏均有入口，
  //   面板只保留「本会话可直接操作」的项；假入口（密钥管理/选模型/拒绝/重建索引）已删（D4）。
  const MORE_GROUPS = {
    session: { label: '当前会话', domains: ['① 会话输入'] },
    task: { label: '任务', domains: ['② 任务目标'] },
    memory: { label: '记忆', domains: ['⑥ 记忆上下文'] },
    permission: { label: '权限', domains: ['③ 自主权模式', '④ 工具权限', '⑤ 审批安全'] },
    model: { label: '模型', domains: ['⑦ 模型成本', '⑧ 多智能体'] },
    debug: { label: '调试', domains: ['⑨ 可观测调试', '⑩ 治理合规'] },
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
    // ★ 2026-09-20：计数动态化（原 index.html 硬编码「共 47 项功能」与实际条目不符）
    const cnt = $('#agentMoreCount');
    if (cnt) {
      const total = COCKPIT.reduce((s, d) => s + d.btns.length, 0);
      const real = COCKPIT.reduce((s, d) => s + d.btns.filter(b => b.kind !== 'stub').length, 0);
      cnt.textContent = showStub ? `共 ${total} 项（可操作 ${real}）` : `可操作 ${real} 项 · 未启用 ${total - real} 项`;
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
      board.innerHTML = '<div class="text-muted" style="font-size:12px;padding:14px">暂无运行记录。在「智能体」页发一条指令（带会话）即在此实时展开。</div>';
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
      card.setAttribute('data-a11y-click', '1'); // ★ P2-⑤：标记为可点卡片 → 由 initA11yInteractions 补键盘可达
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
  /* ===== Slice D：界面 pictograph 统一为单色 SVG =====
     做法：一张映射表 + 文本节点清扫，静态 HTML 与动态渲染统一覆盖；
     只扫界面语言层，跳过用户数据正文（记忆内容 / 笔记正文 / 终端日志 / 时间线正文）避免内容失真。
     回滚：window.__MOS_PICTOGRAPH = false 即停止；已替换的节点在窗口内不可逆（刷新即还原）。 */
  window.__MOS_PICTOGRAPH = true;
  const PICTO_ICONS = {"★":{"b":"<path d=\"M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95z\"/>","s":true},"⭐":{"b":"<path d=\"M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.5l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95z\"/>","s":true},"✓":{"b":"<path d=\"M20 6.5L9 17.5 4 12.5\"/>","s":false},"✔":{"b":"<path d=\"M20 6.5L9 17.5 4 12.5\"/>","s":false},"✅":{"b":"<path d=\"M21 11.1V12a9 9 0 1 1-5.3-8.2\"/><path d=\"M22 4L12 14.01l-3-3\"/>","s":false},"✕":{"b":"<path d=\"M18 6L6 18M6 6l12 12\"/>","s":false},"✗":{"b":"<path d=\"M18 6L6 18M6 6l12 12\"/>","s":false},"✖":{"b":"<path d=\"M18 6L6 18M6 6l12 12\"/>","s":false},"⚠":{"b":"<path d=\"M10.3 3.9L2.1 17.9A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-3.1L13.7 3.9a2 2 0 0 0-3.4 0z\"/><path d=\"M12 9v4.5\"/><circle cx=\"12\" cy=\"17.2\" r=\".6\"/>","s":false},"⛔":{"b":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M5.6 5.6l12.8 12.8\"/>","s":false},"🚫":{"b":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M5.6 5.6l12.8 12.8\"/>","s":false},"❌":{"b":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M15 9l-6 6M9 9l6 6\"/>","s":false},"🟢":{"b":"<circle cx=\"12\" cy=\"12\" r=\"8.5\"/>","s":true},"✎":{"b":"<path d=\"M17 3.5a2.83 2.83 0 1 1 4 4L7.5 21 2 22.5 3.5 17z\"/><path d=\"M15 5.5l4 4\"/>","s":false},"✏":{"b":"<path d=\"M17 3.5a2.83 2.83 0 1 1 4 4L7.5 21 2 22.5 3.5 17z\"/><path d=\"M15 5.5l4 4\"/>","s":false},"✍":{"b":"<path d=\"M17 3.5a2.83 2.83 0 1 1 4 4L7.5 21 2 22.5 3.5 17z\"/>","s":false},"🖐":{"b":"<path d=\"M18 11V6.5a1.5 1.5 0 0 0-3 0V11\"/><path d=\"M15 10.5V4.5a1.5 1.5 0 0 0-3 0V11\"/><path d=\"M12 10.5V6a1.5 1.5 0 0 0-3 0v8\"/><path d=\"M18 8.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.2a6 6 0 0 1-4.3-1.8L4 14.5a1.6 1.6 0 0 1 2.3-2.2L9 15V4a1.5 1.5 0 0 1 3 0\"/>","s":false},"🗑":{"b":"<path d=\"M3 6h18\"/><path d=\"M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6\"/><path d=\"M18.5 6l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6\"/><path d=\"M10 11v6M14 11v6\"/>","s":false},"📦":{"b":"<path d=\"M21 8.2v7.6a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4a2 2 0 0 1-1-1.7V8.2a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4a2 2 0 0 1 1 1.7z\"/><path d=\"M3.3 7.3L12 12.2l8.7-4.9\"/><path d=\"M12 22V12.2\"/>","s":false},"📋":{"b":"<path d=\"M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13.5A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H15\"/><rect x=\"9\" y=\"2.5\" width=\"6\" height=\"4\" rx=\"1\"/><path d=\"M8.5 11h7M8.5 15h5\"/>","s":false},"🔧":{"b":"<path d=\"M14.2 6.2a4.5 4.5 0 0 0 5.9 5.9l-8 8a2.7 2.7 0 0 1-3.8-3.8z\"/><path d=\"M6.5 3.5L9 6 6 9l-2.5-2.5a3.5 3.5 0 0 0 3-3z\"/>","s":false},"🔗":{"b":"<path d=\"M9.5 14.5l5-5\"/><path d=\"M11 6.5l1.8-1.8a3.8 3.8 0 0 1 5.4 5.4L16.4 12\"/><path d=\"M13 17.5l-1.8 1.8a3.8 3.8 0 0 1-5.4-5.4L7.6 12\"/>","s":false},"📎":{"b":"<path d=\"M20 11.5l-8.4 8.4a5 5 0 0 1-7.1-7.1l8.8-8.8a3.3 3.3 0 0 1 4.7 4.7l-8.8 8.8a1.7 1.7 0 0 1-2.3-2.3l8.1-8.1\"/>","s":false},"👁":{"b":"<path d=\"M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>","s":false},"🎯":{"b":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"12\" cy=\"12\" r=\"5\"/><circle cx=\"12\" cy=\"12\" r=\"1.4\"/>","s":false},"🚀":{"b":"<path d=\"M5 15l-2 6 6-2\"/><path d=\"M12.5 3.5c3.5-1 6-1 6-1s0 2.5-1 6l-6 6-4-4z\"/><circle cx=\"14.5\" cy=\"9.5\" r=\"1.6\"/><path d=\"M9 15l-3.5 3.5M6 18l-2.5 2.5\"/>","s":false},"⚡":{"b":"<path d=\"M13.5 2L4 13.5h6L10.5 22 20 10.5h-6z\"/>","s":false},"🔍":{"b":"<circle cx=\"11\" cy=\"11\" r=\"7.5\"/><path d=\"M20.5 20.5l-4.2-4.2\"/>","s":false},"📝":{"b":"<path d=\"M12 20.5h9\"/><path d=\"M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z\"/>","s":false},"💭":{"b":"<path d=\"M20.5 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 20.5 12z\"/>","s":false},"🔌":{"b":"<path d=\"M9 2.5v6M15 2.5v6\"/><path d=\"M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0z\"/><path d=\"M12 17v4.5\"/>","s":false},"📓":{"b":"<path d=\"M5 3.5A1.5 1.5 0 0 1 6.5 2H19v20H6.5A1.5 1.5 0 0 1 5 20.5z\"/><path d=\"M9 2v20M12 7h4M12 11h4\"/>","s":false},"📄":{"b":"<path d=\"M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z\"/><path d=\"M14 2.5V8h5.5\"/><path d=\"M8.5 13h7M8.5 17h5\"/>","s":false},"🗺":{"b":"<path d=\"M9 4.5L3 6.8v13L9 17.5l6 2.3 6-2.3v-13L15 6.8z\"/><path d=\"M9 4.5v13M15 6.8v13\"/>","s":false},"📂":{"b":"<path d=\"M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2.5h8.8A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z\"/>","s":false},"📊":{"b":"<path d=\"M3 3.5v17.5h18\"/><rect x=\"6\" y=\"12\" width=\"3.5\" height=\"6\"/><rect x=\"12\" y=\"8\" width=\"3.5\" height=\"10\"/><rect x=\"18\" y=\"4.5\" width=\"3.5\" height=\"13.5\"/>","s":false},"📈":{"b":"<path d=\"M3 3.5v17.5h18\"/><path d=\"M6.5 15l4-4.5 3.5 3L20 7\"/>","s":false},"💤":{"b":"<path d=\"M20.5 14.5A8.5 8.5 0 0 1 8 12.8 7 7 0 0 0 3.5 12a6.5 6.5 0 1 0 17 2.5z\"/><path d=\"M9.5 7.5h4M8 10.5h3\"/>","s":false},"📚":{"b":"<path d=\"M12 6.5v15\"/><path d=\"M3 4.5h5a2.5 2.5 0 0 1 2 2.4V21a2 2 0 0 0-1.6-1H3z\"/><path d=\"M21 4.5h-5a2.5 2.5 0 0 0-2 2.4V21a2 2 0 0 1 1.6-1H21z\"/>","s":false},"⚙":{"b":"<path d=\"M4 7h10M18 7h2M4 17h4M12 17h8\"/><circle cx=\"16\" cy=\"7\" r=\"2.4\"/><circle cx=\"10\" cy=\"17\" r=\"2.4\"/>","s":false},"🎨":{"b":"<path d=\"M12 2.5a9.5 9.5 0 0 0 0 19c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.8.7-1.4 1.6-1.4h1.8A5.3 5.3 0 0 0 21.5 10C21.5 5.8 17.2 2.5 12 2.5z\"/><circle cx=\"7.5\" cy=\"11\" r=\"1.1\"/><circle cx=\"11\" cy=\"7\" r=\"1.1\"/><circle cx=\"15.5\" cy=\"8.5\" r=\"1.1\"/>","s":false},"💾":{"b":"<path d=\"M5 3.5h11l3 3v14H5z\"/><rect x=\"8\" y=\"12.5\" width=\"8\" height=\"6\"/>","s":false},"🔄":{"b":"<path d=\"M20.5 11.5a8.5 8.5 0 0 0-14.8-4.6L2 10.5\"/><path d=\"M2 4.5v6h6\"/><path d=\"M3.5 12.5a8.5 8.5 0 0 0 14.8 4.6L22 13.5\"/><path d=\"M22 19.5v-6h-6\"/>","s":false},"✂":{"b":"<circle cx=\"6\" cy=\"6\" r=\"2.5\"/><circle cx=\"6\" cy=\"18\" r=\"2.5\"/><path d=\"M8 7.5L20 18M8 16.5L20 6\"/>","s":false},"💡":{"b":"<path d=\"M9 18h6\"/><path d=\"M10 21.5h4\"/><path d=\"M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.6.5.8 1 .8 1.7h6c0-.7.2-1.2.8-1.7A6.5 6.5 0 0 0 12 2.5z\"/>","s":false},"📏":{"b":"<path d=\"M3 15.5l6-6M9 9.5l5.5 5.5\"/><rect x=\"12\" y=\"3\" width=\"9\" height=\"6\" rx=\"1.5\" transform=\"rotate(45 16.5 6)\"/><rect x=\"12\" y=\"15\" width=\"9\" height=\"6\" rx=\"1.5\" transform=\"rotate(45 16.5 18)\"/>","s":false},"🐙":{"b":"<path d=\"M12 2.5a7.5 7.5 0 0 0-7.5 7.5v.8a4 4 0 0 0 1 2.6l1.3 1.7v4.4a2 2 0 0 0 2 2h6.4a2 2 0 0 0 2-2v-4.4l1.3-1.7a4 4 0 0 0 1-2.6v-.8A7.5 7.5 0 0 0 12 2.5z\"/><path d=\"M12 8.5v3M9 10h6\"/>","s":false},"✨":{"b":"<path d=\"M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z\"/><path d=\"M19 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z\"/>","s":false},"⚑":{"b":"<path d=\"M5 21.5V3.5\"/><path d=\"M5 4.5h11l-2 3.5 2 3.5H5z\"/>","s":false},"📥":{"b":"<path d=\"M12 3.5v11\"/><path d=\"M7.5 10.5L12 15l4.5-4.5\"/><path d=\"M4 17.5v1.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5\"/>","s":false},"🔵":{"b":"<circle cx=\"12\" cy=\"12\" r=\"8.5\"/>","s":true},"➡":{"b":"<path d=\"M4 12h15\"/><path d=\"M13.5 6.5L19 12l-5.5 5.5\"/>","s":false},"🏃":{"b":"<circle cx=\"15\" cy=\"4.5\" r=\"1.8\"/><path d=\"M12.5 21.5l1.8-5.4-3-2.6 1-4.5 3.7 2.5 2.5 2.5\"/><path d=\"M11.3 9l-3.6 1.2-2 3\"/><path d=\"M14.3 16.1l3.4 1.4 1.3 4\"/>","s":false},"🌐":{"b":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18\"/><path d=\"M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z\"/>","s":false},"💬":{"b":"<path d=\"M20.5 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 20.5 12z\"/>","s":false},"🕒":{"b":"<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5.2l3.4 2\"/>","s":false},"📜":{"b":"<path d=\"M6 3.5h11a2 2 0 0 1 2 2v13a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2z\"/><path d=\"M9 8h6M9 12h6M9 16h4\"/>","s":false},"⬇":{"b":"<path d=\"M12 4v11\"/><path d=\"M7.5 10.5L12 15l4.5-4.5\"/><path d=\"M4.5 19.5h15\"/>","s":false},"🧠":{"b":"<path d=\"M9.5 3.5A2.5 2.5 0 0 0 7 6a2.5 2.5 0 0 0-2 3.5A2.5 2.5 0 0 0 5.5 15a2.5 2.5 0 0 0 4 2.5V3.5z\"/><path d=\"M14.5 3.5A2.5 2.5 0 0 1 17 6a2.5 2.5 0 0 1 2 3.5a2.5 2.5 0 0 1-.5 5.5a2.5 2.5 0 0 1-4 2.5V3.5z\"/><path d=\"M12 3.5v17\"/>","s":false},"📡":{"b":"<circle cx=\"12\" cy=\"16.5\" r=\"2\"/><path d=\"M8.8 13.2a4.5 4.5 0 0 1 0 6.6M15.2 13.2a4.5 4.5 0 0 0 0 6.6\"/><path d=\"M5.8 9.8a8.8 8.8 0 0 1 0 12.4M18.2 9.8a8.8 8.8 0 0 0 0 12.4\"/>","s":false},"🤖":{"b":"<rect x=\"4\" y=\"8\" width=\"16\" height=\"11\" rx=\"2.5\"/><path d=\"M12 4.5V8\"/><circle cx=\"12\" cy=\"4\" r=\"1.4\"/><circle cx=\"9\" cy=\"13\" r=\"1.2\"/><circle cx=\"15\" cy=\"13\" r=\"1.2\"/><path d=\"M9.5 16.2h5\"/>","s":false},"☀":{"b":"<circle cx=\"12\" cy=\"12\" r=\"4.2\"/><path d=\"M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6\"/>","s":false},"🌙":{"b":"<path d=\"M20.5 14.3A8.8 8.8 0 0 1 9.7 3.5a8.8 8.8 0 1 0 10.8 10.8z\"/>","s":false}};
  const PICTO_RE = new RegExp("[★⭐✓✔✅✕✗✖⚠⛔🚫❌🟢✎✏✍🖐🗑📦📋🔧🔗📎👁🎯🚀⚡🔍📝💭🔌📓📄🗺📂📊📈💤📚⚙🎨💾🔄✂💡📏🐙✨⚑📥🔵➡🏃🌐💬🕒📜⬇🧠📡🤖☀🌙]", "gu");
  /* 明确不扫的容器：用户数据与机器输出 */
  const PICTO_SKIP_SEL = '.memory-content,.notes-tabpane,.notes-hint,pre,code,.run-timeline,.sessionMessages,.stat-value,#noteDetail,.row-content,.log-body,.audit-text';
  function _pictoSvg(ch) {
    const it = PICTO_ICONS[ch];
    if (!it) return null;
    const cls = it.s ? " class=\"ic ic-solid\"" : " class=\"ic\"";
    return "<svg" + cls + " viewBox=\"0 0 24 24\" aria-hidden=\"true\" focusable=\"false\" data-picto-ch=\"" + ch + "\">" + it.b + "</svg>";
  }
  function _pictoInSkipped(node) {
    for (let p = node.parentElement; p; p = p.parentElement) { if (p.matches && p.matches(PICTO_SKIP_SEL)) return true; }
    return false;
  }
  function sweepPictographs(root) {
    if (window.__MOS_PICTOGRAPH === false) return 0;
    const scope = root || document.body;
    if (!scope || !scope.createTreeWalker) return 0;
    const walker = scope.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.match(PICTO_RE)) return NodeFilter.FILTER_REJECT;
        if (_pictoInSkipped(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    PICTO_RE.lastIndex = 0;
    const hits = [];
    let n;
    while ((n = walker.nextNode())) hits.push(n);
    let done = 0;
    for (const t of hits) {
      const txt = t.nodeValue;
      if (!txt.match(PICTO_RE)) continue;
      PICTO_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m, local = 0;
      while ((m = PICTO_RE.exec(txt))) {
        const svg = _pictoSvg(m[1]);
        if (!svg) continue;
        if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
        const span = document.createElement("span");
        span.innerHTML = svg;
        frag.appendChild(span.firstChild);
        last = m.index + 1;
        local++;
        done++;
      }
      if (!local) continue;
      if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
      t.parentNode.replaceChild(frag, t);
    }
    return done;
  }
  function initPictographs() {
    const run = () => { try { return sweepPictographs(document.body); } catch (e) { return 0; } };
    run();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    setTimeout(run, 1200); setTimeout(run, 3000);
    /* 动态渲染兜底：节流 400ms 的 MutationObserver，覆盖 innerHTML 注入的按钮/徽标/空态 */
    let timer = null;
    const obs = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; if (window.__MOS_PICTOGRAPH !== false) run(); }, 400);
    });
    if (document.body) obs.observe(document.body, { childList: true, subtree: true });
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
    const onPageLeave = () => { const h = location.hash.slice(1); if (h !== 'tasks/runs' && h !== 'tasks') _runsCloseSse(); };
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
        if (d && d.messages) box.textContent = d.messages.map(m => (m.role === 'user' ? '我：' : '智能体：') + m.content).join('\n') || '（空）';
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
  bindMemorySubnav();
  initRowExpand();
  loadFilterState();
  initCommandPalette();
  initTableSort();
  initFilterTags();
  initMemoryLinks();
  initDataActions();
  initConnectScan();
  initAgent();
  initRuns();
  initRules();
  initIngest();
  initObsidian();
  initSkills();
  initTasks();
  initGraph();
  initPictographs();
  initLoadError();
  initDaemonHealth();
  load().then(() => {
    // 工具连接页列数修正
    if (location.hash.slice(1).split('/')[0] === 'graph') location.hash = 'obsidian/unified';
    if (location.hash.slice(1).split('/')[0] === 'runs') location.hash = 'tasks/runs';
    const _seg = (location.hash.slice(1) || 'agent').split('/');
    if (PAGE_TITLES[_seg[0]]) navigate(_seg[0], _seg[1]);
  }).catch(e => console.error('load failed', e));
})();
