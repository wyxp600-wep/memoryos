# probe-endpoints.ps1 — 端点取证协议（先读后打 · P0 第 2 步）
# 判读基线：校准指纹（不存在路由的响应形状）= 对照组；4xx JSON 且 ≠ 校准指纹 = 路由在、handler 拒假载荷
# JSON 一律走 -d @临时文件（绕开 PowerShell 5.1 原生参数引号坑）
$ErrorActionPreference = "Continue"
$T = (Get-Content "$env:APPDATA\MemoryOS\data\token" -Raw).Trim()
$B = "http://127.0.0.1:8787"
$LOG = "C:\Users\WYX\Desktop\MemoryOS\outputs\ui-cleanup-A\endpoint-probes.log"
New-Item -ItemType Directory -Path (Split-Path $LOG) -Force | Out-Null
$lines = [System.Collections.Generic.List[string]]::new()
function L([string]$s) { $script:lines.Add($s); Write-Host $s }
$BODYTMP = [System.IO.Path]::GetTempFileName()

function Invoke-Api([string]$method, [string]$path, [string]$body = "", [switch]$noToken, [switch]$sse, [int]$maxTime = 5) {
    $tok = if ($noToken) { "" } else { "?token=$T" }
    $uri = "$B$path$tok"
    $outTmp = [System.IO.Path]::GetTempFileName()
    $a = @("-s", "-o", $outTmp, "-w", "%{http_code}", "-X", $method)
    if ($sse) { $a += @("-N", "--max-time", "$maxTime") }
    if ($body) {
        Set-Content -Path $BODYTMP -Value $body -Encoding ASCII
        $a += @("-H", "Content-Type: application/json", "--data", "@$BODYTMP")
    }
    $a += @($uri)
    $code = (& curl.exe @a 2>$null | Out-String).Trim()
    $bodyText = ""
    if ((Test-Path $outTmp) -and (Get-Item $outTmp).Length -gt 0) {
        $bodyText = (Get-Content $outTmp -Raw).Trim()
        if ($bodyText.Length -gt 200) { $bodyText = $bodyText.Substring(0, 200) + "…" }
    }
    Remove-Item $outTmp -ErrorAction SilentlyContinue
    return @{ code = $code; body = $bodyText }
}

function Probe([string]$label, [string]$method, [string]$path, [string]$body = "", [switch]$noToken) {
    $r = Invoke-Api $method $path $body -noToken:$noToken
    L ("{0,-50} {1,-6} {2,-4} | {3}" -f $label, $method, $r.code, $r.body)
    return $r
}

function ProbeSse([string]$label, [string]$path) {
    # $path 已含 ?token=（-noToken 防二次追加）
    $r = Invoke-Api "GET" $path "" -noToken -sse -maxTime 3
    $head = ($r.body -replace "`r?`n", " ⏎ ").Trim()
    L ("{0,-50} {1,-6} {2,-4} | {3}" -f $label, "GET-SSE", $r.code, $head)
    return $r
}

function Elapsed([scriptblock]$sb) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = & $sb
    $sw.Stop()
    return @{ result = $r; ms = [int]$sw.ElapsedMilliseconds }
}

L "=== 端点取证 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') · base=$B ==="

L "--- 第0步 校准指纹（对照组）---"
$calibAuth = Probe "校准·不存在路由(带凭据)" "GET" "/api/__definitely_missing__"
$calibNoAuth = Probe "校准·不存在路由(无凭据)" "GET" "/api/__definitely_missing__" -noToken
$ua = Probe "401对照·card-types(无凭据)" "GET" "/api/card-types" -noToken
L "判读基准：带凭据不存在路由=$($calibAuth.code)（body 形状：$($calibAuth.body.Substring(0,[Math]::Min(40,$calibAuth.body.Length)))）；无凭据应 401 JSON"

L "--- 第3步 GET 直打（200 = 真实形状）---"
Probe "GET /api/card-types（核键名 types）" "GET" "/api/card-types"
$g = Invoke-Api "GET" "/api/cards/graph"
L ("GET /api/cards/graph {0} | edges=$($g.body.Contains('"edges"')) profileMissing=$($g.body.Contains('"profileMissing"')) | 前160字：{1}" -f $g.code, $g.body)

L "--- 写端点假载荷（判据：4xx JSON 且 ≠ 校准指纹）---"
Probe "POST /api/cards {}（必填 title）" "POST" "/api/cards" "{}"
Probe "POST /api/card-types {}（必填 type_key）" "POST" "/api/card-types" "{}"
Probe "POST /api/agent-profiles {}（必填 name）" "POST" "/api/agent-profiles" "{}"
Probe "POST /api/cards/999999/retype（假 id）" "POST" "/api/cards/999999/retype" '{"kind":"task"}'
Probe "POST /api/cards/999999/dispatch-agent（假 id）" "POST" "/api/cards/999999/dispatch-agent" "{}"
Probe "DELETE /api/card-edges/999999（假边 id）" "DELETE" "/api/card-edges/999999"
Probe "GET /api/agent-cards/999999/state（假卡 id）" "GET" "/api/agent-cards/999999/state"
Probe "PUT /api/agent-profiles/999999（假档案 id）" "PUT" "/api/agent-profiles/999999" "{}"
Probe "DELETE /api/agent-profiles/999999（假档案 id）" "DELETE" "/api/agent-profiles/999999"
Probe "GET /api/cards/999999（假卡 id）" "GET" "/api/cards/999999"
Probe "PUT /api/cards/999999（假卡 id，meta 不收）" "PUT" "/api/cards/999999" "{}"
Probe "DELETE /api/cards/999999（假卡 id）" "DELETE" "/api/cards/999999"
Probe "DELETE /api/cards/999999/links（假卡，无存在性检查→no-op 200）" "DELETE" "/api/cards/999999/links?dst_card_id=1&kind=depends"

L "--- SSE 端点（GET 方法确认 + 假 id 行为，--max-time 3）---"
ProbeSse "GET /api/agent-cards/999999/exec/stream" "/api/agent-cards/999999/exec/stream?token=$T"
ProbeSse "GET /api/agent-cards/999999/live" "/api/agent-cards/999999/live?token=$T"

L "--- 专项1 · scan-agents/custom 前后双打（P1 缓存落地前；upsert 型走真实登记+清理）---"
$cn = "__probe_custom_" + (Get-Date -Format "HHmmss")
$t1 = Elapsed { Invoke-Api "GET" "/api/scan-agents" }
$reg = Probe "POST /api/scan-agents/custom（真实登记 $cn）" "POST" "/api/scan-agents/custom" ('{"name":"%s","path":"","configDir":""}' -f $cn)
$t2 = Elapsed { Invoke-Api "GET" "/api/scan-agents" }
$beforeHas = [bool]($t1.result.body -like "*$cn*")
$afterHas = [bool]($t2.result.body -like "*$cn*")
L "双打判读：登记前含 $cn = $beforeHas → 登记后 = $afterHas（并入=$true 则 P1 缓存须『登记成功清缓存戳』）｜scan 首调 $($t1.ms)ms 二调 $($t2.ms)ms（P1 前无缓存基线读数）"
$unreg = Invoke-Api "DELETE" "/api/scan-agents/custom" ('{"name":"%s"}' -f $cn)
L "清理：DELETE custom $cn → $($unreg.code) $($unreg.body)"

L "--- 专项2 · scan-agents 对账（清单 vs 用户 6 名字）---"
$scanFile = [System.IO.Path]::GetTempFileName()
curl.exe -s "$B/api/scan-agents?token=$T" -o $scanFile | Out-Null
$scanJson = Get-Content $scanFile -Raw | ConvertFrom-Json
L ("scan-agents: total={0} connected={1}" -f $scanJson.total, $scanJson.connected)
foreach ($n in @("trae", "dsh", "minimax", "workbuddy", "opencode", "mimocode")) {
    $hit = $scanJson.agents | Where-Object { $_.id -eq $n -or $_.name -like "*$n*" } | Select-Object -First 2
    $ids = ($hit | ForEach-Object { "$($_.id)(connected=$($_.connected))" }) -join " "
    L ("对账 {0,-12} → {1}" -f $n, $(if ($hit) { $ids } else { "未命中（需 custom 登记）" }))
}
Remove-Item $scanFile -ErrorAction SilentlyContinue

L "--- 专项3 · 废卡沙箱回环（真 id 探针；POST/DELETE card-edges 互为对方探针）---"
$doc = Invoke-Api "POST" "/api/cards" '{"title":"__probe_disposable__","kind":"doc"}'
$taskc = Invoke-Api "POST" "/api/cards" '{"title":"__probe_task__","kind":"task"}'
$hnd = Invoke-Api "POST" "/api/cards" '{"title":"__probe_handoff__","kind":"handoff","status":"done"}'
$docId = [int]($doc.body | ConvertFrom-Json).id
$taskId = [int]($taskc.body | ConvertFrom-Json).id
$hndId = [int]($hnd.body | ConvertFrom-Json).id
L "废卡三张：doc=$docId task=$taskId handoff=$hndId（$($doc.code)/$($taskc.code)/$($hnd.code)）"
$e1 = Invoke-Api "POST" "/api/card-edges" ('{"source_id":%s,"target_id":%s,"kind":"inject"}' -f $hndId, $taskId)
$edgeId = ($e1.body | ConvertFrom-Json).id
L "POST card-edges handoff→task inject → $($e1.code)（边 id=$edgeId；200=白名单+档位放行，4xx=契约破）"
$e2 = Invoke-Api "DELETE" "/api/card-edges/$edgeId"
L "DELETE card-edges/$edgeId（互探：POST 建出的边 DELETE 得通）→ $($e2.code) $($e2.body)"
$e3 = Invoke-Api "POST" "/api/card-edges" ('{"source_id":%s,"target_id":%s,"kind":"inject"}' -f $docId, $taskId)
L "POST card-edges doc→task（doc 无 inject_out 档位，预期 409）→ $($e3.code) $($e3.body)"
$gfile = [System.IO.Path]::GetTempFileName()
curl.exe -s "$B/api/cards/graph?token=$T" -o $gfile | Out-Null
$agentCard = (Get-Content $gfile -Raw | ConvertFrom-Json).nodes | Where-Object { $_.kind -eq "agent" } | Select-Object -First 1
Remove-Item $gfile -ErrorAction SilentlyContinue
if ($agentCard) {
    $st = Invoke-Api "GET" "/api/agent-cards/$($agentCard.id)/state"
    L "GET agent-cards/$($agentCard.id)/state（真 agent 卡）→ $($st.code) | $($st.body)"
} else {
    L "agent 卡：图中无 kind=agent 卡（取不到真 id，仅假 id 档已验）"
}
foreach ($cid in @($docId, $taskId, $hndId)) {
    $d = Invoke-Api "DELETE" "/api/cards/$cid"
    L "删除废卡 $cid → $($d.code) $($d.body)"
}
L "=== 探针结束 $(Get-Date -Format 'HH:mm:ss') ==="

Set-Content -Path $LOG -Value $lines -Encoding UTF8
Write-Host ""
Write-Host "全量日志：$LOG"
