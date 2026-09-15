# LLM 配置修复验收：密钥持久化(DPAPI) + 即时生效(无重启) + 测试连接
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\WYX\Desktop\MemoryOS\resources\memoryos'
$tmp  = Join-Path $env:TEMP 'memoryos-cfgtest'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Copy-Item "$env:APPDATA\MemoryOS\config.json" (Join-Path $tmp 'config.json') -Force
$tok = (Get-Content (Join-Path $repo 'data\token') -Raw).Trim()
$port = 8791
$base = "http://127.0.0.1:$port"
$H = @{ 'x-memory-token' = $tok }
$HJ = @{ 'x-memory-token' = $tok; 'Content-Type' = 'application/json' }
$pass = 0; $fail = 0
function Check($name, $cond, $detail = '') {
  if ($cond) { $script:pass++; "✓ $name$(if($detail){" — $detail"})" }
  else { $script:fail++; "✗ $name$(if($detail){" — $detail"})" }
}

# 起内核（临时 data 目录；真实 DB 只读用）
$env:MEMORYOS_DATA_DIR = $tmp
$env:MEMORY_DB = Join-Path $repo 'data\memory.db'
$env:MEMORY_PORT = "$port"
Start-Process -FilePath 'node' -ArgumentList 'dist\dashboard.js' -WorkingDirectory $repo -WindowStyle Hidden
$up = $false
for ($i = 0; $i -lt 30; $i++) { try { Invoke-RestMethod "$base/api/summary" -Headers $H -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Milliseconds 700 } }
if (-not $up) { "✗ 内核未起来，终止"; exit 1 }

# ① 保存假密钥（模拟设置页填密钥）
$r1 = Invoke-RestMethod "$base/api/config" -Method Post -Headers $HJ -Body (@{ llmKey = 'sk-fake-test-abc123' } | ConvertTo-Json)
Check '保存密钥返回 ok' ($r1.ok -eq $true) "note=$($r1.note)"
Check '仅 LLM 改动 → 不再要求重启内核' ($r1.restartRequired -eq $false)

# ② GET 状态：密钥状态真实化
$c = Invoke-RestMethod "$base/api/config" -Headers $H
Check 'llmKeySet=true' ($c.llmKeySet -eq $true) "source=$($c.llmKeySource)"
Check 'llmKeySource=encrypted' ($c.llmKeySource -eq 'encrypted')
Check '生效端点已归一化为完整端点' ($c.llmEffective.url -match '/chat/completions$') $c.llmEffective.url

# ③ 磁盘检查：密文在、明文不在
$disk = Get-Content (Join-Path $tmp 'config.json') -Raw
Check 'config.json 含 llmKeyEnc（密文落盘）' ($disk -match 'llmKeyEnc')
Check 'config.json 不含明文密钥' (-not ($disk -match 'sk-fake-test-abc123'))

# ④ 测试连接：本地 Ollama 应成功
$t1 = Invoke-RestMethod "$base/api/config/test-llm" -Method Post -Headers $HJ -Body (@{ llmUrl = 'http://127.0.0.1:11434/v1'; llmModel = 'qwen3:8b' } | ConvertTo-Json)
Check '测试连接（本地 Ollama，base 写法）成功' ($t1.ok -eq $true) "url=$($t1.url) 耗时=$($t1.latencyMs)ms"

# ⑤ 测试连接：云端 agnes（无密钥）应给出可读错误而非盲失败
$t2 = Invoke-RestMethod "$base/api/config/test-llm" -Method Post -Headers $HJ -Body (@{ llmUrl = 'https://api.agnes-ai.cn/v1'; llmModel = 'agnes-3.0-flash'; timeoutMs = 15000 } | ConvertTo-Json)
Check '云端无密钥 → 明确报错（非 404=URL 归一化正确）' ($t2.ok -eq $false) "HTTP=$($t2.status) hint=$($t2.hint)"

# ⑥ 即时生效：改 URL/model 后不重启，agent 状态立刻反映
$r2 = Invoke-RestMethod "$base/api/config" -Method Post -Headers $HJ -Body (@{ llmUrl = 'http://127.0.0.1:11434/v1'; llmModel = 'qwen3:8b' } | ConvertTo-Json)
$st = Invoke-RestMethod "$base/api/agent/status" -Headers $H
Check '内核未重启，agent 状态已用新端点' ($st.llm.model -eq 'qwen3:8b' -and $st.llm.baseUrl -eq 'http://127.0.0.1:11434/v1') "model=$($st.llm.model) url=$($st.llm.baseUrl)"
Check 'agent 也拿到已存密钥' ($st.llm.keySet -eq $true)

# ⑦ 同进程现读（llm.js）
$live = & node (Join-Path $repo 'dist\tmp-llm-livecheck.mjs') 2>&1
$live | ForEach-Object { "  $_" }
Check 'llm.js 同进程现读生效' ($live -match '现读生效')

# ⑧ 清除密钥
Invoke-RestMethod "$base/api/config" -Method Post -Headers $HJ -Body (@{ clearLlmKey = $true } | ConvertTo-Json) | Out-Null
$c2 = Invoke-RestMethod "$base/api/config" -Headers $H
$disk2 = Get-Content (Join-Path $tmp 'config.json') -Raw
Check '清除后 llmKeySet=false 且磁盘无密文' ($c2.llmKeySet -eq $false -and -not ($disk2 -match 'llmKeyEnc'))

"`n结果：$pass 通过 / $fail 失败"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*dist\dashboard.js*" -and $_.CommandLine -like "*$port*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
exit $fail
