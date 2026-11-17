param(
 [Parameter(Mandatory=$true)][string]$PayloadZip,
 [Parameter(Mandatory=$true)][string]$OutputFile
)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7){throw '请使用 PowerShell 7。'}
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(-not (Test-Path -LiteralPath $compiler)){throw '缺少 Windows .NET Framework C# 编译器。'}
$PayloadZip=[IO.Path]::GetFullPath($PayloadZip)
$OutputFile=[IO.Path]::GetFullPath($OutputFile)
if($PayloadZip -eq $OutputFile){throw '输入与输出路径不能相同。'}
if(Test-Path -LiteralPath $OutputFile){throw '输出文件已存在，请保留旧文件并选择新路径。'}
New-Item -ItemType Directory -Force -Path (Split-Path $OutputFile -Parent) | Out-Null
$stub=$OutputFile+'.stub.exe'
Push-Location $PSScriptRoot
try{
 & $compiler /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ /win32manifest:Installer.manifest "/out:$stub" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:Microsoft.CSharp.dll Installer.cs
 if($LASTEXITCODE -ne 0){throw '安装程序编译失败。'}
}finally{Pop-Location}
$payload=[IO.File]::OpenRead($PayloadZip)
$stubStream=[IO.File]::OpenRead($stub)
$output=[IO.File]::Open($OutputFile,[IO.FileMode]::CreateNew)
try{
 $stubStream.CopyTo($output)
 $hash=[Security.Cryptography.SHA256]::HashData($payload)
 $payload.Position=0
 $payload.CopyTo($output)
 $output.Write([BitConverter]::GetBytes([long]$payload.Length))
 $output.Write($hash)
 $output.Write([Text.Encoding]::ASCII.GetBytes('MEMOSZIP'))
}finally{$payload.Dispose();$stubStream.Dispose();$output.Dispose()}
Get-Item -LiteralPath $OutputFile | Select-Object Name,Length
