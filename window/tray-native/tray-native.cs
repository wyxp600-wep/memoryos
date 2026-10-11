// MemoryOS 托盘小助手（系统原生通道）
// 目的：用 Windows 系统原生的 Shell_NotifyIcon 注册托盘图标，取代 PowerShell 套壳方案。
// 关键点：
//   1. /target:winexe —— 天生无控制台窗口，不存在「黑窗藏不掉 / 用户关窗即杀进程」问题；
//   2. NOTIFYICONDATA.guidItem 固定 GUID —— 系统按 GUID 记住图标的显示偏好，
//      用户在系统设置里设一次「始终显示」后永久生效（Win11 用 PromotedIconCache 维护）；
//   3. 菜单动作写信号文件，由宿主软件轮询读取后执行真实动作，不跨进程调用；
//   4. 宿主进程消失则自退，不留孤儿。
// 用法：tray-native.exe --img <png> --cmd <文件> --log <文件> --pid <文件> --app-pid <数字> [--tip <文字>]
//
// 语法限 csc（.NET Framework 4.0，C# 5）：不使用字符串插值 / ?. / nameof。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class TrayNative
{
    // ---------- Win32 ----------
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct NOTIFYICONDATA
    {
        public int cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);

    // 客观判定：注册成功则能反查到图标在屏幕上的矩形（不依赖 GetLastError）
    [StructLayout(LayoutKind.Sequential)]
    public struct NOTIFYICONIDENTIFIER
    {
        public int cbSize;
        public IntPtr hWnd;
        public uint uID;
        public Guid guidItem;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }
    [DllImport("shell32.dll")]
    static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER id, out RECT rc);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern ushort RegisterClass(ref WNDCLASS lpWndClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowEx(uint ex, string cls, string win, uint style,
        int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);

    [DllImport("user32.dll")]
    static extern IntPtr DefWindowProc(IntPtr h, uint m, IntPtr w, IntPtr l);

    [DllImport("user32.dll")]
    static extern bool GetMessage(out MSG m, IntPtr h, uint min, uint max);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG m);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessage(ref MSG m);

    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);

    [DllImport("user32.dll")]
    static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool AppendMenu(IntPtr h, uint flags, IntPtr id, string text);

    // TPM_RETURNCMD 时返回值是菜单命令 ID，故签名用 uint
    [DllImport("user32.dll")]
    static extern uint TrackPopupMenu(IntPtr h, uint flags, int x, int y, int res, IntPtr owner, IntPtr rect);

    [DllImport("user32.dll")]
    static extern bool DestroyMenu(IntPtr h);

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr h);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr LoadIcon(IntPtr hInstance, IntPtr lpIconName);

    [DllImport("user32.dll")]
    static extern uint SetTimer(IntPtr h, uint id, uint ms, IntPtr proc);

    [DllImport("user32.dll")]
    static extern bool KillTimer(IntPtr h, uint id);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();

    [DllImport("kernel32.dll")]
    static extern uint GetCurrentProcessId();

    // ---------- 常量 ----------
    const uint NIM_ADD = 0x00000000;
    const uint NIM_MODIFY = 0x00000001;
    const uint NIM_DELETE = 0x00000002;
    const uint NIM_SETVERSION = 0x00000004;

    const uint NIF_MESSAGE = 0x00000001;
    const uint NIF_ICON = 0x00000002;
    const uint NIF_TIP = 0x00000004;
    const uint NIF_GUID = 0x00000020;

    const uint NOTIFYICON_VERSION_4 = 4;

    const uint WM_APP = 0x8000;
    const uint WM_COMMAND = 0x0111;
    const uint WM_USER = 0x0400;
    const uint WM_LBUTTONUP = 0x0202;
    const uint WM_RBUTTONUP = 0x0205;
    const uint WM_LBUTTONDBLCLK = 0x0203;
    const uint WM_CONTEXTMENU = 0x007B;
    const uint WM_TIMER = 0x0113;
    const uint WM_DESTROY = 0x0002;

    // NIN_SELECT / NIN_KEYSELECT（NOTIFYICON_VERSION_4 下由 LOWWORD(lParam) 上报）
    const uint NIN_SELECT = 0x0400;
    const uint NIN_KEYSELECT = 0x0401;
    const uint NIN_POPUPOPEN = 0x0406;
    const uint NIN_POPUPCLOSE = 0x0407;

    const uint MF_STRING = 0x00000000;
    const uint MF_SEPARATOR = 0x00000800;
    const uint TPM_RIGHTBUTTON = 0x0002;
    const uint TPM_RETURNCMD = 0x0100;
    const uint TPM_NONOTIFY = 0x0080;

    static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

    // 固定 GUID：系统据此记住该图标的显示偏好（PromotedIconCache）
    static readonly Guid TrayGuid = new Guid("8f4c2a1e-6b3d-4f2a-9c1e-2d5b7a9e4c6f");

    // ---------- 状态 ----------
    static string cmdFile = "tray-cmd.txt";
    static string logFile = "tray-native.log";
    static string pidFile = "tray-native.pid";
    static int appPid = 0;
    static IntPtr hwnd = IntPtr.Zero;
    static IntPtr hIcon = IntPtr.Zero;
    static NOTIFYICONDATA nid;
    static IntPtr hMenu = IntPtr.Zero;
    // 窗口过程委托必须由静态字段持有，否则被 GC 回收后调用即崩溃
    static DefWndProc procDelegate;

    // 菜单命令 ID
    const int CMD_SHOW = 101;
    const int CMD_BROWSER = 102;
    const int CMD_UPDATE = 103;
    const int CMD_RESTART_CORE = 104;
    const int CMD_RESTART_MCP = 105;
    const int CMD_RELAUNCH = 106;
    const int CMD_PIN = 107;
    const int CMD_QUIT = 199;

    static void W(string m)
    {
        try
        {
            File.AppendAllText(logFile,
                DateTime.Now.ToString("yyyy/MM/dd HH:mm:ss") + " " + m + "\r\n",
                Encoding.UTF8);
        }
        catch { }
    }

    static void Send(string cmd)
    {
        try
        {
            File.WriteAllText(cmdFile, cmd, Encoding.ASCII);
            W("cmd -> " + cmd);
        }
        catch (Exception e) { W("cmd write fail " + e.Message); }
    }

    static string Arg(string name, string def)
    {
        string[] a = Environment.GetCommandLineArgs();
        for (int i = 1; i < a.Length - 1; i++)
        {
            if (string.Equals(a[i], name, StringComparison.OrdinalIgnoreCase)) return a[i + 1];
        }
        return def;
    }

    [STAThread]
    static void Main()
    {
        string imgPath = Arg("--img", "tray.png");
        cmdFile = Arg("--cmd", cmdFile);
        logFile = Arg("--log", logFile);
        pidFile = Arg("--pid", pidFile);
        string tip = Arg("--tip", "MemoryOS 记忆系统");
        int.TryParse(Arg("--app-pid", "0"), out appPid);

        W("start selfPid=" + GetCurrentProcessId() + " appPid=" + appPid + " console=" + (GetConsoleWindow() != IntPtr.Zero));

        // 图标：PNG -> HICON
        try
        {
            Bitmap bmp = new Bitmap(imgPath);
            hIcon = bmp.GetHicon();
            bmp.Dispose();
            W("icon built from " + imgPath);
        }
        catch (Exception e)
        {
            W("icon fail " + e.Message);
            hIcon = IntPtr.Zero;
        }

        // 消息窗口：用「隐藏的顶层窗口」而非 message-only 窗口
        // —— Shell_NotifyIcon 对宿主窗口有要求，message-only 窗口（HWND_MESSAGE 作父）会被拒
        WNDCLASS wc = new WNDCLASS();
        procDelegate = new DefWndProc(WndProc);
        wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(procDelegate);
        wc.hInstance = IntPtr.Zero;
        wc.lpszClassName = "MemoryOSTrayNative";
        RegisterClass(ref wc);
        hwnd = CreateWindowEx(0, "MemoryOSTrayNative", "MemoryOSTrayNative", 0,
            0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        W("top-level hwnd=" + hwnd);
        if (hwnd == IntPtr.Zero) { W("no window, exit"); return; }

        // 注册托盘图标（带固定 GUID）
        nid = new NOTIFYICONDATA();
        nid.cbSize = Marshal.SizeOf(typeof(NOTIFYICONDATA));
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_GUID;
        nid.uCallbackMessage = WM_APP + 1;
        nid.hIcon = hIcon;
        nid.szTip = tip;
        nid.guidItem = TrayGuid;

        bool ok = Shell_NotifyIcon(NIM_ADD, ref nid);
        W("NIM_ADD(with GUID)=" + ok + " lastErr=" + Marshal.GetLastWin32Error() + " cbSize=" + nid.cbSize);
        if (!ok)
        {
            // 对照：去掉 NIF_GUID 再试（区分是 GUID 路径不被接受，还是注册本身失败）
            nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            ok = Shell_NotifyIcon(NIM_ADD, ref nid);
            W("NIM_ADD(no GUID)=" + ok + " lastErr=" + Marshal.GetLastWin32Error());
        }
        if (ok)
        {
            nid.uTimeoutOrVersion = NOTIFYICON_VERSION_4;
            bool v = Shell_NotifyIcon(NIM_SETVERSION, ref nid);
            W("NIM_SETVERSION(4)=" + v + " lastErr=" + Marshal.GetLastWin32Error());
        }

        // ★ 客观判定（不看返回值/错误码，直接问系统图标在不在）
        {
            NOTIFYICONIDENTIFIER id = new NOTIFYICONIDENTIFIER();
            id.cbSize = Marshal.SizeOf(typeof(NOTIFYICONIDENTIFIER));
            id.hWnd = hwnd;
            id.uID = 1;
            id.guidItem = TrayGuid;
            RECT rc;
            int hr = Shell_NotifyIconGetRect(ref id, out rc);
            W("GetRect hr=0x" + hr.ToString("X8") + " rect=(" + rc.left + "," + rc.top + "," + rc.right + "," + rc.bottom + ")");
            // 再用 NIM_MODIFY 交叉验证：图标存在则返回 true
            bool mod = Shell_NotifyIcon(NIM_MODIFY, ref nid);
            W("NIM_MODIFY(图标是否存在)=" + mod);
        }

        // ★ 对照实验：换系统自带图标再注册一次（排除「PNG 转 HICON 不被接受」这一可能）
        {
            IntPtr hSys = LoadIcon(IntPtr.Zero, new IntPtr(32512)); // IDI_APPLICATION
            NOTIFYICONDATA t = new NOTIFYICONDATA();
            t.cbSize = Marshal.SizeOf(typeof(NOTIFYICONDATA));
            t.hWnd = hwnd;
            t.uID = 99;
            t.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            t.uCallbackMessage = WM_APP + 1;
            t.hIcon = hSys;
            t.szTip = "MemoryOS sysicon probe";
            bool r = Shell_NotifyIcon(NIM_ADD, ref t);
            W("NIM_ADD(系统图标对照)=" + r + " hIcon=" + hSys);
            if (r) Shell_NotifyIcon(NIM_DELETE, ref t);
        }

        // 菜单
        hMenu = CreatePopupMenu();
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_SHOW), "打开 MemoryOS");
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_BROWSER), "在浏览器打开");
        AppendMenu(hMenu, MF_SEPARATOR, IntPtr.Zero, null);
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_UPDATE), "检查更新");
        AppendMenu(hMenu, MF_SEPARATOR, IntPtr.Zero, null);
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_RESTART_CORE), "重启内核");
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_RESTART_MCP), "重启 MCP 服务");
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_RELAUNCH), "重新启动");
        AppendMenu(hMenu, MF_SEPARATOR, IntPtr.Zero, null);
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_PIN), "让托盘图标常驻显示");
        AppendMenu(hMenu, MF_SEPARATOR, IntPtr.Zero, null);
        AppendMenu(hMenu, MF_STRING, new IntPtr(CMD_QUIT), "退出");

        // 自报 PID
        try { File.WriteAllText(pidFile, GetCurrentProcessId().ToString(), Encoding.ASCII); }
        catch { }

        W("ready");

        // 看门狗：宿主进程消失则自退
        SetTimer(hwnd, 1, 5000, IntPtr.Zero);

        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }

        // 清理
        Shell_NotifyIcon(NIM_DELETE, ref nid);
        if (hMenu != IntPtr.Zero) DestroyMenu(hMenu);
        if (hIcon != IntPtr.Zero) DestroyIcon(hIcon);
        try { File.Delete(pidFile); } catch { }
        W("exit");
    }

    delegate IntPtr DefWndProc(IntPtr h, uint m, IntPtr w, IntPtr l);

    static IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l)
    {
        switch (m)
        {
            case WM_APP + 1:
                HandleTrayEvent(l);
                return IntPtr.Zero;

            case WM_COMMAND:
                HandleMenuCommand(w.ToInt32() & 0xFFFF);
                return IntPtr.Zero;

            case WM_TIMER:
                if (appPid > 0)
                {
                    try
                    {
                        Process.GetProcessById(appPid);
                    }
                    catch
                    {
                        W("app gone, self exit");
                        PostMessage(hwnd, WM_DESTROY, IntPtr.Zero, IntPtr.Zero);
                    }
                }
                return IntPtr.Zero;

            case WM_DESTROY:
                PostQuit();
                return IntPtr.Zero;
        }
        return DefWindowProc(h, m, w, l);
    }

    [DllImport("user32.dll")]
    static extern void PostQuitMessage(int n);

    static void PostQuit() { PostQuitMessage(0); }

    static void HandleTrayEvent(IntPtr lParam)
    {
        // NOTIFYICON_VERSION_4：LOWORD(lParam) = 事件，HIWORD(lParam) = 图标 id；坐标在 wParam
        long raw = lParam.ToInt64();
        uint ev = (uint)(raw & 0xFFFF);
        W("tray event ev=0x" + ev.ToString("X4"));

        if (ev == WM_RBUTTONUP || ev == WM_CONTEXTMENU)
        {
            ShowMenu();
        }
        else if (ev == WM_LBUTTONDBLCLK || ev == NIN_SELECT || ev == NIN_KEYSELECT)
        {
            Send("show");
        }
        else if (ev == WM_LBUTTONUP)
        {
            ShowMenu();
        }
    }

    static void ShowMenu()
    {
        POINT pt;
        GetCursorPos(out pt);
        // 必须先让消息窗口成为前台，否则菜单不自动收起
        SetForegroundWindow(hwnd);
        uint cmd = TrackPopupMenu(hMenu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
            pt.x, pt.y, 0, hwnd, IntPtr.Zero);
        if (cmd != 0) HandleMenuCommand((int)cmd);
    }

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr h);

    static void HandleMenuCommand(int id)
    {
        switch (id)
        {
            case CMD_SHOW: Send("show"); break;
            case CMD_BROWSER: Send("browser"); break;
            case CMD_UPDATE: Send("update"); break;
            case CMD_RESTART_CORE: Send("restart-core"); break;
            case CMD_RESTART_MCP: Send("restart-mcp"); break;
            case CMD_RELAUNCH: Send("relaunch"); break;
            case CMD_PIN: Send("pin"); break;
            case CMD_QUIT: Send("quit"); break;
        }
    }
}
