# 看板 P0–P3 回归

此目录验证父目录的实际 index.html/app.js/fonts，以及内核 dist 的真实静态路由与批量记忆模块。测试只使用隔离 HTTP 样例或内存 SQLite，不连接生产数据库，不发起 LLM 推理。

依赖 Node 24。首次运行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm test
```

顺序执行 P0 19 项、P1 33 项、P2 31 项、P3 24 项，共 107 项。测试依赖通过本目录锁文件解析，不依赖开发者桌面目录或系统 Chrome 的安装位置。

`baseline/` 为固定 Playwright 1.62.1 的 Windows Chromium 基准，含深浅主题、375px/1440px 规范页与对话框，共 8 张图。截图比较容忍单通道 24 色阶差，变化像素不得超过 200 且不得超过面积的 0.3%；尺寸不同直接失败。字体或系统镜像变化也可能导致差异，需要人工审查。`npm run baseline` 显式更新基准，CI 环境禁止更新。

`.github/workflows/ui-visual.yml` 在 Windows 执行相同入口并上传 P3 当前图和结果。本目录各阶段结果、普通截图、node_modules 和 actual 目录均不纳入版本控制，只有已审查基准入库。

`node serve-p3.cjs` 启动本机随机端口的样例预览，Ctrl+C 关闭。p1-ui-runtime.txt、p3-runtime.txt 与 p3-styleguide.html/css 为阶段构建片段；运行时使用已嵌入父目录 HTML/JS 的内容，不需要额外静态路由。内核 dist 即维护源码，没有 TypeScript 编译步骤。
