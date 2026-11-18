using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Drawing;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;

// Offline, per-user installation. The payload is a ZIP followed by a fixed footer.
// No administrator rights, network downloads, registry changes or profile copies.
internal static class Installer
{
    const string Version = "0.1.5";
    const string Magic = "MEMOSZIP";
    [STAThread]
    static int Main(string[] args)
    {
        // .NET Framework 4.6.2+ path normalization; nested npm packages exceed MAX_PATH.
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        string destination = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "MemoryOS-Personal-" + Version);
        bool silent = false;
        foreach (string arg in args)
        {
            if (arg.Equals("/S", StringComparison.OrdinalIgnoreCase)) silent = true;
            else if (arg.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) destination = arg.Substring(3);
            else return 2;
        }
        if (silent)
        {
            try { Install(destination); return 0; }
            catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var form = new Form { Text = "MemoryOS 个人版 " + Version + " 安装", ClientSize = new Size(580, 245), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false };
        var title = new Label { Text = "安装 MemoryOS", Font = new Font("Microsoft YaHei UI", 16), Left = 24, Top = 20, Width = 510, Height = 40 };
        var note = new Label { Text = "包含个人版和本地检索模型。已有记忆保留在原数据目录。", Left = 24, Top = 68, Width = 535, Height = 34 };
        var location = new TextBox { Text = destination, Left = 24, Top = 108, Width = 440 };
        var browse = new Button { Text = "更改…", Left = 474, Top = 106, Width = 80 };
        var status = new Label { Text = "请选择一个尚不存在的安装文件夹。", Left = 24, Top = 147, Width = 530, Height = 36 };
        var shortcut = new CheckBox { Text = "创建桌面快捷方式", Checked = true, Left = 24, Top = 199, Width = 230 };
        var install = new Button { Text = "安装", Left = 454, Top = 196, Width = 100, Height = 30 };
        bool busy = false;
        browse.Click += delegate { using (var dialog = new FolderBrowserDialog()) { dialog.Description = "选择父文件夹，将在其中新建 MemoryOS-Personal-" + Version; if (dialog.ShowDialog() == DialogResult.OK) location.Text = Path.Combine(dialog.SelectedPath, "MemoryOS-Personal-" + Version); } };
        form.FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
        install.Click += async delegate {
            if (install.Text == "完成") { form.Close(); return; }
            string target = location.Text;
            bool makeShortcut = shortcut.Checked;
            busy = true; install.Enabled = browse.Enabled = location.Enabled = shortcut.Enabled = false;
            status.Text = "正在校验并安装，请稍候…";
            try
            {
                await Task.Run(delegate { Install(target); });
                string shortcutNote = "";
                if (makeShortcut) { try { CreateShortcut(target); } catch { shortcutNote = "快捷方式未创建，请从安装目录启动。"; } }
                status.Text = shortcutNote.Length > 0 ? "安装完成。" + shortcutNote : "安装完成。双击桌面快捷方式或安装目录中的 MemoryOS.exe 启动。";
                install.Text = "完成";
            }
            catch (Exception e) { status.Text = "未完成：" + e.Message; browse.Enabled = location.Enabled = shortcut.Enabled = true; }
            finally { busy = false; install.Enabled = true; }
        };
        form.Controls.AddRange(new Control[] { title, note, location, browse, status, shortcut, install });
        Application.Run(form);
        return 0;
    }

    static void Install(string destination)
    {
        destination = Path.GetFullPath(destination.Trim());
        if (Directory.Exists(destination) || File.Exists(destination)) throw new IOException("安装文件夹已存在，请选择一个新文件夹。原有文件未改动。");
        var parent = Directory.GetParent(destination);
        if (parent == null) throw new IOException("不能安装到磁盘根目录。");
        Directory.CreateDirectory(parent.FullName);
        string staging = Path.Combine(parent.FullName, ".memoryos-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            using (var self = File.OpenRead(Application.ExecutablePath))
            {
                if (self.Length < 48) throw new InvalidDataException("安装包不完整。");
                self.Seek(-48, SeekOrigin.End);
                var footer = new byte[48]; ReadExactly(self, footer, 0, footer.Length);
                if (Encoding.ASCII.GetString(footer, 40, 8) != Magic) throw new InvalidDataException("安装包尾标记无效。");
                long payloadLength = BitConverter.ToInt64(footer, 0);
                long offset = self.Length - 48 - payloadLength;
                if (payloadLength <= 0 || offset < 0) throw new InvalidDataException("安装包大小无效。");
                using (var segment = new SegmentStream(self, offset, payloadLength))
                using (var sha = SHA256.Create())
                {
                    byte[] hash = sha.ComputeHash(segment);
                    for (int i = 0; i < hash.Length; i++) if (hash[i] != footer[8 + i]) throw new InvalidDataException("安装包校验失败，请重新下载。");
                    segment.Position = 0;
                    using (var zip = new ZipArchive(segment, ZipArchiveMode.Read, true))
                    {
                        foreach (var entry in zip.Entries)
                        {
                            string target = Path.GetFullPath(Path.Combine(staging, entry.FullName));
                            if (!target.StartsWith(staging + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装包包含越界路径。");
                            if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                            Directory.CreateDirectory(Path.GetDirectoryName(target));
                            using (var input = entry.Open()) using (var output = new FileStream(target, FileMode.CreateNew)) input.CopyTo(output);
                        }
                    }
                }
            }
            string application = Path.Combine(staging, "MemoryOS");
            if (!File.Exists(Path.Combine(application, "MemoryOS.exe")) || !File.Exists(Path.Combine(application, "resources", "app.asar"))) throw new InvalidDataException("安装包缺少程序入口。");
            Directory.Move(application, destination);
        }
        finally
        {
            // Only remove the random staging directory that this invocation created.
            string resolved = Path.GetFullPath(staging);
            if (Path.GetDirectoryName(resolved).Equals(parent.FullName, StringComparison.OrdinalIgnoreCase) && Path.GetFileName(resolved).StartsWith(".memoryos-install-", StringComparison.Ordinal))
                Directory.Delete(resolved, true);
        }
    }

    static void CreateShortcut(string directory)
    {
        // WScript COM requires an STA thread; invoked from the UI after extraction.
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        dynamic shell = Activator.CreateInstance(type);
        dynamic link = shell.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "MemoryOS 个人版 " + Version + ".lnk"));
        link.TargetPath = Path.Combine(Path.GetFullPath(directory), "MemoryOS.exe");
        link.WorkingDirectory = Path.GetFullPath(directory);
        link.IconLocation = link.TargetPath + ",0";
        link.Save();
    }

    static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        while (count > 0) { int n = stream.Read(buffer, offset, count); if (n == 0) throw new EndOfStreamException(); offset += n; count -= n; }
    }

    sealed class SegmentStream : Stream
    {
        readonly Stream stream; readonly long start, length; long position;
        public SegmentStream(Stream source, long offset, long size) { stream = source; start = offset; length = size; }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
        public override int Read(byte[] buffer, int offset, int count) { stream.Position = start + position; int n = stream.Read(buffer, offset, (int)Math.Min(count, length - position)); position += n; return n; }
        public override long Seek(long offset, SeekOrigin origin) { long next = origin == SeekOrigin.Begin ? offset : origin == SeekOrigin.Current ? position + offset : length + offset; if (next < 0 || next > length) throw new IOException("无效读取范围。"); position = next; return position; }
        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }
}
