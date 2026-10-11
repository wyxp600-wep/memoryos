"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");
const { app, Tray, Menu, nativeImage } = require("electron");

/** 托盘（自持 tray） */
let tray = null;

function safeLog(log, ...a) {
  if (typeof log === "function") log("[Tray]", ...a);
  else console.log("[Tray]", ...a);
}

/**
 * P0 托盘根治（2026-10-10）：图标改为「内存建图」——fs.readFileSync 可直读 asar，
 * 从 buffer 构建 nativeImage，彻底绕开 createFromPath 读不了 asar / 拷贝落盘失败等路径问题。
 * 主选多尺寸 tray.ico（16/24/32/48/256，Windows 原生格式，显式取 32x32 条目）；
 * 失败依次回退：tray.png 内存建图 → 数据目录拷贝路径（旧链路）。每一步都落日志。
 */
function loadTrayImage(o, log) {
  const assets = path.join(__dirname, "..", "assets");
  try {
    const icoBuf = fs.readFileSync(path.join(assets, "tray.ico"));
    let img = nativeImage.createFromBuffer(icoBuf, { width: 32, height: 32 });
    if (img.isEmpty()) img = nativeImage.createFromBuffer(icoBuf);
    safeLog(log, "ico 内存建图 isEmpty=" + img.isEmpty() + " size=" + JSON.stringify(img.getSize()));
    if (!img.isEmpty()) return img;
  } catch (e) {
    safeLog(log, "ico 建图失败，回退 png:", (e && e.message) || String(e));
  }
  try {
    const pngBuf = fs.readFileSync(path.join(assets, "tray.png"));
    const img = nativeImage.createFromBuffer(pngBuf);
    safeLog(log, "png 内存建图 isEmpty=" + img.isEmpty() + " size=" + JSON.stringify(img.getSize()));
    if (!img.isEmpty()) return img.resize({ width: 32, height: 32 });
  } catch (e) {
    safeLog(log, "png 建图失败，回退拷贝路径:", (e && e.message) || String(e));
  }
  const iconPath = o.trayIconPath || path.join(assets, "tray.png");
  const rawImg = nativeImage.createFromPath(iconPath);
  safeLog(log, "路径建图 isEmpty=" + rawImg.isEmpty() + " path=" + iconPath);
  return rawImg.resize({ width: 32, height: 32 });
}

/* ---------- 系统原生通道托盘小助手（2026-10-10） ----------
   背景：2026-10-07 Windows 更新后，本机对 Electron/Chromium 的托盘注册整体静默拒收
   （getBounds 恒 0，最小 Electron 对照程序同样失败），但 Win32 NotifyIcon 通道正常
   （原生测试图标用户已目视确认可见）。故 Electron 托盘未获认领时，启动一个隐藏的
   PowerShell 小助手走 Win32 NotifyIcon 挂图标 + 右键菜单，菜单动作经信号文件交回软件。
   脚本内嵌于此、运行时以 UTF-8 BOM 落盘到用户数据目录（asar 内路径 PowerShell 读不到）。
   小助手随软件退出（before-quit 主动杀）；软件崩溃后 5 秒内靠 PID 看门狗自退，不留孤儿。 */
/* 脚本结构（2026-10-10 本机实测标定）：
   ① 图标用 PNG→HICON（用户目视验证唯一可显示做法；ExtractAssociatedIcon 会得到不可见图标）
   ② 消息泵用轮询 DoEvents（Start-Sleep 150ms），**不可用 Application::Run()**——
      实测 Application::Run() 会导致图标完全不可见；轮询泵下图标可见且右键菜单可弹可点。
   ③ 菜单动作写信号文件，由 Electron 侧轮询读取后执行真实动作（不跨进程调用）。
   ④ 路径/进程号在生成脚本时以字面量写入（实测字面量处理器可靠，避免 scriptblock 变量捕获风险）。 */
const BRIDGE_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "function W([string]$m) {",
  "  try { Add-Content -Path '__LOG__' -Value ((Get-Date -Format 'yyyy/MM/dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {}",
  "}",
  "$ni = New-Object System.Windows.Forms.NotifyIcon",
  "try {",
  "  $bmp = [System.Drawing.Bitmap]::FromFile('__IMG__')",
  "  $hicon = $bmp.GetHicon()",
  "  $ni.Icon = [System.Drawing.Icon]::FromHandle($hicon)",
  "  W 'icon ok'",
  "} catch {",
  "  W ('icon fail ' + $_.Exception.Message)",
  "  try { $ni.Icon = [System.Drawing.SystemIcons]::Application } catch {}",
  "}",
  "$ni.Text = 'MemoryOS 记忆系统'",
  "$menu = New-Object System.Windows.Forms.ContextMenuStrip",
  "$mi1 = New-Object System.Windows.Forms.ToolStripMenuItem('打开 MemoryOS')",
  "$mi2 = New-Object System.Windows.Forms.ToolStripMenuItem('在浏览器打开')",
  "$mi3 = New-Object System.Windows.Forms.ToolStripMenuItem('检查更新')",
  "$mi4 = New-Object System.Windows.Forms.ToolStripMenuItem('重启内核')",
  "$mi5 = New-Object System.Windows.Forms.ToolStripMenuItem('重启 MCP 服务')",
  "$mi6 = New-Object System.Windows.Forms.ToolStripMenuItem('重新启动')",
  "$mi7 = New-Object System.Windows.Forms.ToolStripMenuItem('退出')",
  "[void]$menu.Items.Add($mi1)",
  "[void]$menu.Items.Add($mi2)",
  "[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))",
  "[void]$menu.Items.Add($mi3)",
  "[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))",
  "[void]$menu.Items.Add($mi4)",
  "[void]$menu.Items.Add($mi5)",
  "[void]$menu.Items.Add($mi6)",
  "[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))",
  "[void]$menu.Items.Add($mi7)",
  "$ni.ContextMenuStrip = $menu",
  "$mi1.Add_Click({ try { [System.IO.File]::WriteAllText('__CMD__', 'show', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$mi2.Add_Click({ try { [System.IO.File]::WriteAllText('__CMD__', 'browser', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$mi3.Add_Click({ try { [System.IO.File]::WriteAllText('__CMD__', 'update', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$mi4.Add_Click({ try { [System.IO.File]::WriteAllText('__CMD__', 'restart-core', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$mi5.Add_Click({ try { [System.IO.File]::WriteAllText('__CMD__', 'restart-mcp', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$mi6.Add_Click({ try { [System.IO.File]::WriteAllText('__CMD__', 'relaunch', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$mi7.Add_Click({ try { [System.IO.File]::WriteAllText('__CMD__', 'quit', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$ni.Add_DoubleClick({ try { [System.IO.File]::WriteAllText('__CMD__', 'show', [System.Text.Encoding]::ASCII) } catch { W ('cmd fail ' + $_.Exception.Message) } })",
  "$ni.Visible = $true",
  "try { [System.IO.File]::WriteAllText('__PIDFILE__', [string]$PID, [System.Text.Encoding]::ASCII) } catch {}",
  "W ('bridge started appPid=__PID__ selfPid=' + $PID)",
  "# 图标已注册完成，此刻再隐藏自身控制台（实测：注册后再隐藏不影响图标显示）",
  "Start-Sleep -Milliseconds 600",
  "try {",
  "  Add-Type -Namespace WinApi -Name C -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c);'",
  "  $h = [WinApi.C]::GetConsoleWindow()",
  "  if ($h -ne [IntPtr]::Zero) { [void][WinApi.C]::ShowWindow($h, 0); W 'console hidden' } else { W 'no console handle' }",
  "} catch { W ('console hide fail ' + $_.Exception.Message) }",
  "try { $ni.ShowBalloonTip(4000, 'MemoryOS', '托盘图标已就绪。若任务栏未见图标：点右下角 ^ 展开隐藏图标即可找到。', [System.Windows.Forms.ToolTipIcon]::Info); W 'balloon sent' } catch { W ('balloon fail ' + $_.Exception.Message) }",
  "$sw = [System.Diagnostics.Stopwatch]::StartNew()",
  "$lastWatch = 0.0",
  "while ($true) {",
  "  [System.Windows.Forms.Application]::DoEvents()",
  "  Start-Sleep -Milliseconds 150",
  "  if (($sw.Elapsed.TotalSeconds - $lastWatch) -ge 5) {",
  "    $lastWatch = $sw.Elapsed.TotalSeconds",
  "    if ($null -eq (Get-Process -Id __PID__ -ErrorAction SilentlyContinue)) { W 'app gone, bridge self-exit'; break }",
  "  }",
  "}",
  "$ni.Visible = $false",
  "$ni.Dispose()",
  "try { Remove-Item -LiteralPath '__PIDFILE__' -ErrorAction SilentlyContinue } catch {}",
  "W 'bridge exited'",
].join("\r\n");

let bridgeProc = null;
let bridgeStarted = false;
let cmdTimer = null;
let quitHookBound = false;

function bridgeDir() {
  return path.join(app.getPath("userData"), "bridge");
}

function stopTrayBridge() {
  if (cmdTimer) { clearInterval(cmdTimer); cmdTimer = null; }
  // VBS 拉起时 wscript 秒退，句柄不可靠 → 改为读小助手自写的 PID 文件精确终止
  try {
    const pidFile = path.join(bridgeDir(), "tray-bridge.pid");
    if (fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, "utf8").trim();
      if (/^\d+$/.test(pid)) {
        execFile("taskkill", ["/PID", pid, "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }
      fs.unlinkSync(pidFile);
    }
  } catch { /* 已退出 */ }
  bridgeProc = null;
  bridgeStarted = false;
}

function startTrayBridge(o) {
  const { shell, port, TOKEN, log, onShowMain, onUpdateCheck, onRestartCore, onRestartMcp, onQuit } = o;
  if (bridgeStarted) return;
  try {
    const dir = bridgeDir();
    fs.mkdirSync(dir, { recursive: true });
    const ps1 = path.join(dir, "tray-bridge.ps1");
    const vbs = path.join(dir, "tray-bridge.vbs");
    const cmdFile = path.join(dir, "tray-cmd.txt");
    const logFile = path.join(dir, "tray-bridge.log");
    const pidFile = path.join(dir, "tray-bridge.pid");
    // GDI+ 读不了 asar 内路径：先把 tray.png 拷到真实目录给小助手用
    const imgOut = path.join(dir, "tray.png");
    fs.copyFileSync(path.join(__dirname, "..", "assets", "tray.png"), imgOut);
    for (const f of [cmdFile, pidFile]) { try { fs.unlinkSync(f); } catch { /* 无残留 */ } }
    // 路径/进程号以字面量写进脚本（实测字面量处理器可靠）；单引号需转义成 '' 才能安全内嵌 PS 单引号串
    const lit = (s) => String(s).replace(/'/g, "''");
    const script = BRIDGE_SCRIPT
      .replace(/__CMD__/g, lit(cmdFile))
      .replace(/__LOG__/g, lit(logFile))
      .replace(/__IMG__/g, lit(imgOut))
      .replace(/__PIDFILE__/g, lit(pidFile))
      .replace(/__PID__/g, String(process.pid));
    fs.writeFileSync(ps1, String.fromCharCode(0xfeff) + script, "utf8"); // 前缀为 UTF-8 BOM，PS 5.1 才能正确读中文标签
    // ★ 启动方式（2026-10-10 本机实测标定，五个方案逐一对比得出）：
    //   ✗ Electron 直 spawn + windowsHide：CREATE_NO_WINDOW → 图标不可见
    //   ✗ VBS sh.Run(..., 0, False)（创建即隐藏控制台）→ 图标不可见
    //   ✗ VBS + powershell -WindowStyle Hidden → 图标不可见
    //   ✓ VBS sh.Run(..., 1, False)（控制台按正常方式创建）→ 图标可见，控制台由脚本在注册后自行隐藏
    //   结论：图标注册必须在"控制台正常创建"的进程上下文里完成；隐藏动作要发生在注册之后。
    const vbsBody = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""${ps1}""", 1, False`,
    ].join("\r\n");
    fs.writeFileSync(vbs, vbsBody, "utf8");
    bridgeProc = spawn("wscript.exe", ["//B", vbs], { windowsHide: true, stdio: "ignore" });
    bridgeStarted = true;
    bridgeProc.on("exit", () => { bridgeProc = null; });
    safeLog(log, "托盘小助手已拉起（VBS 零窗口 → PowerShell）脚本=" + ps1);
    setTimeout(() => {
      try {
        const p = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "(尚无 PID 文件)";
        safeLog(log, "小助手自报 PID=" + p);
      } catch { /* 忽略 */ }
    }, 3000);
    const actions = {
      show: () => onShowMain(),
      browser: () => shell.openExternal(`http://127.0.0.1:${port}/?token=${encodeURIComponent(TOKEN)}`),
      update: () => { if (onUpdateCheck) onUpdateCheck(); },
      "restart-core": () => { if (onRestartCore) onRestartCore(); },
      "restart-mcp": () => { if (onRestartMcp) onRestartMcp(); },
      relaunch: () => { app.relaunch(); app.quit(); },
      quit: () => { if (onQuit) onQuit(); else app.quit(); },
    };
    cmdTimer = setInterval(() => {
      try {
        if (!fs.existsSync(cmdFile)) return;
        const cmd = fs.readFileSync(cmdFile, "utf8").trim();
        fs.unlinkSync(cmdFile);
        const fn = actions[cmd];
        if (!fn) { safeLog(log, "小助手未知命令:", cmd); return; }
        safeLog(log, "小助手命令:", cmd);
        fn();
      } catch { /* 忽略瞬时读写冲突 */ }
    }, 400);
    if (!quitHookBound) { app.on("before-quit", stopTrayBridge); quitHookBound = true; }
  } catch (e) {
    safeLog(log, "托盘小助手启动失败:", (e && e.message) || String(e));
  }
}

function createTray(o) {
  const { shell, port, TOKEN, log, onShowMain, onUpdateCheck, onRestartCore, onRestartMcp, onQuit } = o;
  const img = loadTrayImage(o, log);
  // P0 诊断2（2026-10-10）：补发稳定 GUID（系统按 GUID 认领图标；无 GUID 时个别 Win11 构建会静默丢弃注册）
  tray = new Tray(img);
  try {
    tray.setGUID("8f4c2a1e-6b3d-4f2a-9c1e-2d5b7a9e4c6f");
    safeLog(log, "setGUID 已设置");
  } catch (e) {
    safeLog(log, "setGUID 失败（旧版不支持，忽略）:", (e && e.message) || String(e));
  }
  safeLog(log, "Tray 创建成功（带图创建+GUID 路径）");
  const menu = Menu.buildFromTemplate([
    { label: "打开 MemoryOS", click: () => onShowMain() },
    { label: "在浏览器打开", click: () => shell.openExternal(`http://127.0.0.1:${port}/?token=${encodeURIComponent(TOKEN)}`) },
    { label: "检查更新", click: () => onUpdateCheck() },
    { label: "重启内核", click: () => { if (onRestartCore) onRestartCore(); } },
    // ★ 2026-09-13：整应用重启（relaunch + quit；before-quit 钩子先 killChildren 释放 8787，新实例复用原端口）
        { label: "重启 MCP 服务", click: () => { if (onRestartMcp) onRestartMcp(); } },
    { label: "重新启动", click: () => { app.relaunch(); app.quit(); } },
    { type: "separator" },
    { label: "退出", click: () => { if (onQuit) onQuit(); else app.quit(); } },
  ]);
  tray.setToolTip("MemoryOS 记忆系统");
  tray.setContextMenu(menu);
  // P0 诊断（2026-10-10）：getBounds 为 0 = 系统没认这个图标；气球事件不触发 = 通知链路被系统吞
  const dumpState = (tag) => {
    try {
      const b = tray.getBounds();
      safeLog(log, tag + " getBounds=" + JSON.stringify(b) + " destroyed=" + tray.isDestroyed());
    } catch (e) {
      safeLog(log, tag + " getBounds 失败:", (e && e.message) || String(e));
    }
  };
  tray.on("click", () => safeLog(log, "事件 click"));
  tray.on("balloon-show", () => safeLog(log, "事件 balloon-show"));
  tray.on("balloon-closed", () => safeLog(log, "事件 balloon-closed"));
  tray.on("balloon-click", () => safeLog(log, "事件 balloon-click"));
  tray.on("double-click", () => onShowMain());
  dumpState("创建后");
  // 自动换招：5 秒后系统仍不认（bounds=0）→ 销毁后改用「真实文件路径」方式重建托盘
  setTimeout(() => {
    let b = { width: 0, height: 0 };
    try { b = tray.getBounds(); } catch { /* 视为 0 */ }
    if (b && b.width > 0) { dumpState("5s 复查"); return; }
    safeLog(log, "图标未获系统确认（bounds=0），改用文件路径方式重建托盘");
    try { tray.destroy(); } catch { /* 已销毁 */ }
    try {
      const icoOut = path.join(app.getPath("userData"), "tray.ico");
      fs.copyFileSync(path.join(__dirname, "..", "assets", "tray.ico"), icoOut);
      tray = new Tray(icoOut);
      tray.setToolTip("MemoryOS 记忆系统");
      tray.setContextMenu(menu);
      tray.on("double-click", () => onShowMain());
      dumpState("路径重建后");
    } catch (e) {
      safeLog(log, "路径重建失败:", (e && e.message) || String(e));
    }
    // 终极兜底：Electron 托盘注册仍被系统拒收（10-07 更新后 Electron 全线如此，
    // 最小对照程序实证）→ 切系统原生通道小助手（Win32 NotifyIcon，已验证可显示）
    let b2 = { width: 0, height: 0 };
    try { if (tray && !tray.isDestroyed()) b2 = tray.getBounds(); } catch { /* 视为 0 */ }
    if (!b2 || !(b2.width > 0)) {
      safeLog(log, "系统仍拒收 Electron 托盘注册，切换系统原生通道小助手");
      startTrayBridge(o);
    }
  }, 5000);
  // P0 自证气球（2026-10-10）：托盘注册是否被系统接受一弹便知（Win11 以通知形式呈现）。
  // 能弹 = 托盘活着（图标看不见就是被收纳/隐藏，走系统设置引导）；弹不出 = 注册被拒，看同日志定位。
  setTimeout(() => {
    try {
      tray.displayBalloon({
        iconType: "info",
        title: "MemoryOS 托盘图标已就绪",
        content: "若任务栏未见图标：点右下角 ^ 看隐藏图标，或在 设置>个性化>任务栏 中把 MemoryOS 图标设为「显示」。",
      });
      safeLog(log, "自证气球已发送");
    } catch (e) {
      safeLog(log, "气球发送失败:", (e && e.message) || String(e));
    }
  }, 3000);
  return tray;
}

module.exports = { createTray };