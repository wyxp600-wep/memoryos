/* 教程页截图取证：桌面亮色 / 桌面暗色 / 手机三张，落到 verification/ 便于人工复核。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

function readToken() {
  for (const f of [
    path.join(os.homedir(), 'AppData', 'Roaming', 'MemoryOS', 'data', 'token'),
    path.resolve(__dirname, '..', '..', 'data', 'token'),
  ]) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch { /* next */ }
  }
  throw new Error('未找到访问令牌');
}

(async () => {
  const token = readToken();
  const base = 'http://127.0.0.1:' + (Number(process.env.MEMORY_PORT) || 8787);
  const browser = await chromium.launch({ headless: true });

  const shot = async (file, viewport, theme, openAll) => {
    const page = await browser.newPage({ viewport });
    await page.goto(`${base}/?token=${encodeURIComponent(token)}#guide`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#page-guide.active', { timeout: 20000 });
    await page.waitForTimeout(1800);
    await page.evaluate(([t, all]) => {
      document.documentElement.dataset.theme = t;
      if (all) {
        document.querySelectorAll('[data-gd-chapter]').forEach((c, i) => { c.open = i < 4; });
        document.getElementById('gdProgressFill').style.width = '30%';
        document.getElementById('gdDoneCount').textContent = '3';
        document.getElementById('gdProgressPct').textContent = '30%';
      }
    }, [theme, openAll]);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(__dirname, file), fullPage: false });
    await page.close();
    console.log('已截图：' + file);
  };

  await shot('guide-desktop-light.png', { width: 1440, height: 1000 }, 'light', true);
  await shot('guide-desktop-dark.png', { width: 1440, height: 1000 }, 'dark', true);
  await shot('guide-phone.png', { width: 390, height: 844 }, 'light', true);
  await browser.close();
})();
