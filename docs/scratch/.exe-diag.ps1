
$ErrorActionPreference = 'Continue'
Write-Host "=== [1] exe-debug.log ==="
$dl = 'C:\Users\WYX\Desktop\MemoryOS\exe-debug.log'
if (Test-Path $dl) { Get-Content $dl -Tail 20 } else { Write-Host "NOT EXIST - main.js never reached first line" }

Write-Host ""
Write-Host "=== [2] 启动 MemoryOS.exe（清掉 ELECTRON_RUN_AS_NODE）==="
$env:ELECTRON_RUN_AS_NODE = ''
$exe = 'C:\Users\WYX\Desktop\MemoryOS\MemoryOS.exe'
$proc = Start-Process -FilePath $exe -PassThru -ErrorAction SilentlyContinue
if ($null -eq $proc) {
    Write-Host "Start-Process 被拒（可能是沙箱/杀软拦截）"
} else {
    Write-Host ("Started pid=" + $proc.Id)
    Start-Sleep -Seconds 6
    if (-not $proc.HasExited) {
        Write-Host ("STILL RUNNING after 6s, pid=" + $proc.Id + " - exe shell may be alive!")
        $proc | Stop-Process -Force
        Write-Host "killed test process"
    } else {
        Write-Host ("EXITED code=" + $proc.ExitCode)
    }
}

Write-Host ""
Write-Host "=== [3] exe-debug.log 复查 ==="
if (Test-Path $dl) { Get-Content $dl -Tail 20 } else { Write-Host "仍不存在" }

Write-Host ""
Write-Host "=== [4] Defender 状态 ==="
try {
    $d = Get-MpComputerStatus -ErrorAction Stop
    Write-Host ("AV enabled=" + $d.AntivirusEnabled + " RT=" + $d.RealTimeProtectionEnabled)
} catch { Write-Host "Defender 查询失败" }

Write-Host ""
Write-Host "=== [5] 重启 dashboard ==="
Set-Location 'C:\Users\WYX\Desktop\MemoryOS\resources\memoryos'
$env:MEMORY_DB = 'C:\Users\WYX\Desktop\MemoryOS\resources\memoryos\data\memory.db'
$env:MEMORY_PORT = '8787'
$env:EMBED_MODE = 'local'
$env:EMBED_CACHE_DIR = 'C:\Users\WYX\Desktop\MemoryOS\resources\memoryos\models'
$np = Start-Process -FilePath '.\runtime\node.exe' -ArgumentList 'dist\dashboard.js' -PassThru -WindowStyle Hidden
Write-Host ("dashboard started pid=" + $np.Id)
