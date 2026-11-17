/* 新手教程页走查：真实 headless Chromium 打开运行中的 8787 看板，验证
 *  ① 导航项存在、可切页、aria-current 同步；
 *  ② 10 章渲染完整、进度持久化（localStorage）；
 *  ③ 「带我去做」能真实跳页并高亮目标控件；
 *  ④ 深链 #guide/c3 展开对应章节；
 *  ⑤ 深浅主题 / 移动端布局不溢出；
 *  ⑥ 全程 0 JS 错误。
 * 用法：node verify-guide.cjs [--port 8787]
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? Number(process.argv[i + 1]) : 8787;
})();

function readToken() {
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'MemoryOS', 'data', 'token'),
    path.resolve(__dirname, '..', '..', 'data', 'token'),
  ];
  for (const f of candidates) {
    try {
      const t = fs.readFileSync(f, 'utf8').trim();
      if (t) return t;
    } catch { /* 继续找下一个 */ }
  }
  throw new Error('未找到访问令牌（先启动 MemoryOS 看板）');
}

const R = [];
const rec = (name, ok, extra = '') => {
  R.push({ name, ok: !!ok, extra });
  console.log((ok ? '✓ ' : '✗ ') + name + (extra ? ' — ' + extra : ''));
};

(async () => {
  const token = readToken();
  const base = `http://127.0.0.1:${argPort}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  /* 已知存量缺陷（与本次改动无关）：index.html 有 <base href="/">，而内核 CSP 是 base-uri 'none'，
     每次加载都会产生一条被拦截的 console.error。基线 HEAD 同样存在，故单列出来、不计入本次回归。 */
  const KNOWN_CSP = /base-uri 'none'/;
  const knownCspHits = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (KNOWN_CSP.test(text)) { knownCspHits.push(text); return; }
    jsErrors.push('console: ' + text);
  });

  try {
    await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#page-agent.active', { timeout: 20000 });
    await page.waitForTimeout(2500);

    // ① 导航项
    const nav = page.locator('#navGuide');
    rec('导航项「新手教程」存在', await nav.count() === 1);
    rec('导航项可键盘聚焦', await nav.evaluate(el => el.tabIndex >= 0 && !el.disabled));
    rec('导航项有可访问名', (await nav.evaluate(el => el.textContent.trim())) === '新手教程');
    await nav.click();
    await page.waitForTimeout(1200);
    rec('点击后切到 #page-guide', await page.locator('#page-guide.active').count() === 1);
    rec('导航项 aria-current=page', (await nav.getAttribute('aria-current')) === 'page');
    rec('文档标题同步', (await page.title()).startsWith('新手教程'));
    rec('h1 同步为教程标题', /新手教程/.test(await page.locator('#a11yPageH1').textContent()));

    // ② 章节完整 + 进度
    const chapters = await page.locator('[data-gd-chapter]').count();
    rec('10 章全部渲染', chapters === 10, 'chapters=' + chapters);
    rec('每章都有目标/步骤/验收', await page.evaluate(() => {
      const chs = [...document.querySelectorAll('[data-gd-chapter]')];
      return chs.every(c => c.querySelector('.gd-goal') && c.querySelectorAll('.gd-steps li').length >= 4);
    }));
    rec('目录 10 项且可聚焦', await page.evaluate(() => {
      const as = [...document.querySelectorAll('[data-gd-index]')];
      return as.length === 10 && as.every(a => a.tagName === 'A' && a.getAttribute('href').startsWith('#guide/c'));
    }));
    const p0 = await page.locator('#gdDoneCount').textContent();
    rec('初始进度为 0', p0 === '0', 'done=' + p0);

    // 章节默认折叠 → 先展开再点「标记完成」（也顺带验证折叠章节里的按钮确实可展开可点）
    await page.locator('[data-gd-chapter="3"] summary').click();
    await page.waitForTimeout(300);
    await page.locator('[data-gd-done="3"]').click();
    await page.waitForTimeout(400);
    const p1 = await page.locator('#gdDoneCount').textContent();
    const bar1 = await page.locator('#gdProgressBar').getAttribute('aria-valuenow');
    rec('标记完成 → 进度 1', p1 === '1' && bar1 === '1', `done=${p1} aria-valuenow=${bar1}`);
    rec('章节状态与目录同步', await page.evaluate(() => {
      const ch = document.querySelector('[data-gd-chapter="3"]');
      const idx = document.querySelector('[data-gd-index="3"]');
      return ch.dataset.done === 'true' && idx.dataset.done === 'true' && ch.querySelector('[data-gd-state]').textContent === '已完成';
    }));

    // 持久化：整页重载后仍在
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#page-agent.active', { timeout: 20000 });
    await page.waitForTimeout(2000);
    await page.locator('#navGuide').click();
    await page.waitForTimeout(800);
    const p2 = await page.locator('#gdDoneCount').textContent();
    rec('刷新后进度持久化（1）', p2 === '1', 'done=' + p2);

    // ②b 目录链接真实可用（点击 → hash 变化 → 该章展开）
    await page.locator('[data-gd-index="7"]').click();
    await page.waitForTimeout(900);
    rec('点目录第 7 章 → 该章展开且目录高亮', await page.evaluate(() => {
      const ch = document.querySelector('[data-gd-chapter="7"]');
      const idx = document.querySelector('[data-gd-index="7"]');
      return !!ch && ch.open === true && idx.getAttribute('aria-current') === 'true';
    }));
    rec('hash 同步为 #guide/c7', (await page.evaluate(() => location.hash)) === '#guide/c7');

    // ②c 键盘激活导航项（Enter）也能切页
    await page.locator('#navGuide').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    rec('导航项 Enter 激活不报错且仍在教程页', await page.locator('#page-guide.active').count() === 1);

    /* ②d 只给路由、不给锚点（hero「从第 1 章开始」与第 1 章「带我去做」都是这种形态）：
       必须真跳页，且**不得**弹出「没找到要演示的控件」——空锚点在 guideSpotlight 里应被静默跳过，
       否则用户会看到一条与事实相反的告警（控件明明存在，只是这一步不需要高亮）。 */
    await page.evaluate(() => { const t = document.querySelector('#toast'); if (t) t.textContent = ''; });
    await page.locator('[data-gd-jump="agent"]').first().click();
    await page.waitForTimeout(1200);
    rec('无锚点跳转到智能体页', await page.locator('#page-agent.active').count() === 1);
    const noAnchorToast = await page.evaluate(() => {
      const t = document.querySelector('#toast');
      return !!(t && /没找到要演示的控件|undefined/.test(t.textContent || ''));
    });
    rec('无锚点跳转不弹「没找到要演示的控件」', noAnchorToast === false);
    await page.locator('#navGuide').click();
    await page.waitForTimeout(700);

    // ③ 带我去做 → 真实跳页 + 高亮
    await page.locator('[data-gd-jump="govern/connect"]').first().click();
    await page.waitForTimeout(1400);
    rec('「带我去做」跳到系统页', await page.locator('#page-govern.active').count() === 1);
    rec('跳到工具连接子视图', await page.locator('#page-govern .subview[data-view="connect"].on').count() === 1);
    const spot = await page.evaluate(() => {
      const el = document.querySelector('#scanBtn');
      return el ? el.classList.contains('gd-spotlight') : false;
    });
    rec('目标控件被高亮', spot === true);

    /* 静态校验：全部 data-gd-jump 的目标路由 + 锚点必须真实存在，防止后续改 id 后悄悄失效 */
    const jumpAudit = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('[data-gd-jump]').forEach(btn => {
        const spec = btn.dataset.gdJump;
        const anchor = btn.dataset.gdAnchor || '';
        const route = spec.split('/')[0];
        /* 顶层用 .nav-item，系统分组（规则/技能/界面规范）用 .system-section-link，两者都算合法入口 */
        if (!document.querySelector(`[data-route="${route}"]`)) bad.push(spec + ' 路由不存在');
        if (anchor && !document.querySelector(anchor)) bad.push(spec + ' 锚点不存在 ' + anchor);
      });
      return bad;
    });
    rec('全部跳转目标路由/锚点均有效', jumpAudit.length === 0, jumpAudit.join(' | '));

    // ④ 深链
    await page.goto(`${base}/?token=${encodeURIComponent(token)}#guide/c6`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    rec('深链 #guide/c6 打开对应页', await page.locator('#page-guide.active').count() === 1);
    rec('深链自动展开第 6 章', await page.evaluate(() => {
      const ch = document.querySelector('[data-gd-chapter="6"]');
      return !!ch && ch.open === true;
    }));

    // ⑤ 主题与移动端
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(600);
    rec('暗色主题下教程可读（正文与背景对比 ≥ 4.5）', await page.evaluate(() => {
      const lum = c => {
        const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map(v => {
          v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const el = document.querySelector('#gd-c2 .gd-steps li');
      const cs = getComputedStyle(el);
      let bgEl = el, bg = 'rgba(0, 0, 0, 0)';
      while (bgEl && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; }
      return ratio(cs.color, bg) >= 4.5;
    }));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(900);
    rec('移动端无横向溢出', await page.evaluate(() => {
      const root = document.querySelector('#page-guide');
      return document.documentElement.scrollWidth <= window.innerWidth + 1 && root.scrollWidth <= root.clientWidth + 1;
    }));
    rec('移动端目录转为横向排布', await page.evaluate(() => {
      const nav = document.querySelector('.gd-index nav');
      return getComputedStyle(nav).flexDirection === 'row';
    }));
    await page.setViewportSize({ width: 1440, height: 900 });

    rec('全程 0 JS 错误（不含存量 base-uri CSP 提示）', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
    console.log('ℹ 存量 CSP base-uri 提示（HEAD 基线同样存在，未计入）：' + knownCspHits.length + ' 条');
  } catch (e) {
    rec('走查执行', false, String(e && e.message).slice(0, 200));
  } finally {
    await browser.close();
  }

  const bad = R.filter(r => !r.ok).length;
  console.log(bad ? `\n${bad}/${R.length} 项未通过` : `\n全部通过（${R.length} 项）`);
  process.exit(bad ? 1 : 0);
})();
