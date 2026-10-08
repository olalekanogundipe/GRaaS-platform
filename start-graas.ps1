# start-graas.ps1
# One command to start the whole GRaaS stack in this window. Logs go to .\logs\<service>.log
#
#   .\start-graas.ps1            stop old processes, start everything, register + approve agents, seed the contract
#   .\start-graas.ps1 -Test      same, then run the fraud claim (CLM-002) and the clean claim (CLM-001)
#   .\start-graas.ps1 -Stop      stop everything and exit
#   .\start-graas.ps1 -Reset     also delete .\data (local database) before starting
#
# Development only. The API key below is a fixed dev value so your test commands keep working.

param(
    [switch]$Stop,
    [switch]$Test,
    [switch]$Reset
)

$ErrorActionPreference = "Stop"
$Root      = $PSScriptRoot
$LogDir    = Join-Path $Root "logs"
$KeysDir   = Join-Path $Root ".keys"
$ApiKey    = "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59"
$GatewayUrl = "http://127.0.0.1:3000"
$MvpUrl     = "http://127.0.0.1:3001"

function Say($msg, $color = "Cyan") { Write-Host $msg -ForegroundColor $color }

function New-Secret {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    ([Convert]::ToBase64String($bytes)).Replace("+", "a").Replace("/", "b").TrimEnd("=")
}

# Each service gets only the settings it needs: clear everything sensitive before setting a service's own.
function Reset-Env {
    foreach ($n in @("PRIVATE_KEY_PEM", "GATEWAY_API_KEYS", "ADMIN_API_KEY", "INTERNAL_SECRET", "CALL_TOKEN_SECRET",
                     "ALLOW_INSECURE_DEV", "GRAAS_API_KEY", "GATEWAY_URL", "GRAAS_GATEWAY_URL", "KERNEL_KEY_FILE",
                     "OLANG_AUDIT_PRIVATE_KEY", "PORT")) {
        Remove-Item "Env:$n" -ErrorAction SilentlyContinue
    }
}

function Stop-Ports([int[]]$Ports) {
    foreach ($port in $Ports) {
        $owners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($procId in $owners) {
            if ($procId -and $procId -ne 0) {
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                Say "  stopped process $procId on port $port" "Yellow"
            }
        }
    }
}

function Test-Port([int]$Port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect("127.0.0.1", $Port); return $true } catch { return $false } finally { $c.Close() }
}

function Show-Log($name) {
    foreach ($f in @("$name.err.log", "$name.log")) {
        $p = Join-Path $LogDir $f
        if ((Test-Path $p) -and (Get-Item $p).Length -gt 0) {
            Say "--- last lines of logs\$f ---" "Yellow"
            Get-Content $p -Tail 15
        }
    }
}

function Wait-Until([scriptblock]$Check, [int]$Seconds, [string]$What, [string]$LogName) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        try { if (& $Check) { Say "  [OK] $What" "Green"; return } } catch { }
        Start-Sleep -Seconds 1
    }
    Say "  [FAIL] $What did not become ready in $Seconds seconds." "Red"
    if ($LogName) { Show-Log $LogName }
    throw "$What failed to start"
}

function Pem-ForEnv($file) { (Get-Content $file -Raw) -replace "`r?`n", "\n" }

function Start-Svc($name, $file, $arguments, $workDir) {
    $out = Join-Path $LogDir "$name.log"
    $err = Join-Path $LogDir "$name.err.log"
    Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $workDir `
        -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden | Out-Null
}

# ---- Stop ---------------------------------------------------------------------------------------
Say "[1] Stopping anything already running on ports 3000, 3001, 8001, 8002..."
Stop-Ports @(3000, 3001, 8001, 8002)
if ($Stop) { Say "Stopped." "Green"; return }

if ($Reset -and (Test-Path (Join-Path $Root "data"))) {
    Remove-Item (Join-Path $Root "data") -Recurse -Force
    Say "  deleted .\data" "Yellow"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Get-ChildItem $LogDir -Filter "*.log" | Remove-Item -Force -ErrorAction SilentlyContinue

# ---- Prerequisites ------------------------------------------------------------------------------
Say "[2] Checking prerequisites..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed or not on PATH." }
Say "  node $(node -v)" "Green"

foreach ($dir in @($Root, (Join-Path $Root "gateway"), (Join-Path $Root "agents\node-agent"))) {
    if (-not (Test-Path (Join-Path $dir "node_modules"))) {
        Say "  installing npm packages in $dir ..." "Yellow"
        Push-Location $dir; npm install --no-audit --no-fund | Out-Null; Pop-Location
    }
}

# ---- Keys (created only if missing; private keys are never printed) ----------------------------
Say "[3] Checking dev keys in .keys ..."
New-Item -ItemType Directory -Force -Path $KeysDir | Out-Null
$keyScript = Join-Path $LogDir "make-keys.cjs"
@'
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const dir = process.argv[2];
for (const n of ["gateway", "kernel", "node-agent", "python-agent", "audit"]) {
  const priv = path.join(dir, n + ".private.pem"), pub = path.join(dir, n + ".public.pem");
  if (fs.existsSync(priv) && fs.existsSync(pub)) continue;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  fs.writeFileSync(priv, privateKey, { mode: 0o600 }); fs.writeFileSync(pub, publicKey);
  console.log("  created " + n + " key");
}
'@ | Set-Content $keyScript -Encoding utf8
node $keyScript $KeysDir
Remove-Item $keyScript -Force

# ---- Shared settings ----------------------------------------------------------------------------
$AdminKey       = New-Secret
$InternalSecret = New-Secret
$CallSecret     = New-Secret
$KernelKeyFile  = Join-Path $KeysDir "kernel.private.pem"

# ---- Gateway ------------------------------------------------------------------------------------
Say "[4] Starting gateway..."
Reset-Env
$env:PRIVATE_KEY_PEM     = Pem-ForEnv (Join-Path $KeysDir "gateway.private.pem")
$env:GATEWAY_API_KEYS    = $ApiKey
$env:ADMIN_API_KEY       = $AdminKey
$env:INTERNAL_SECRET     = $InternalSecret
$env:CALL_TOKEN_SECRET   = $CallSecret
$env:ALLOW_INSECURE_DEV  = "true"
$env:PORT                = "3000"
Start-Svc "gateway" "node" "src/index.js" (Join-Path $Root "gateway")
Wait-Until { (Invoke-RestMethod "$GatewayUrl/healthz").ok } 30 "Gateway on :3000" "gateway"

# ---- Node fraud agent ---------------------------------------------------------------------------
Say "[5] Starting node fraud agent..."
Reset-Env
$env:PRIVATE_KEY_PEM = Pem-ForEnv (Join-Path $KeysDir "node-agent.private.pem")
$env:INTERNAL_SECRET = $InternalSecret
$env:GRAAS_API_KEY   = $ApiKey
$env:GATEWAY_URL     = "http://localhost:3000"
$env:PORT            = "8002"
Start-Svc "node-agent" "node" "server.js" (Join-Path $Root "agents\node-agent")
Wait-Until { Test-Port 8002 } 20 "Node fraud agent on :8002" "node-agent"

# ---- Python claim agent (optional) --------------------------------------------------------------
Say "[6] Starting python claim agent (optional)..."
$pyOk = $false
if (Get-Command python -ErrorAction SilentlyContinue) {
    try {
        $null = & python -c "import uvicorn, fastapi" 2>&1
        if ($LASTEXITCODE -eq 0) { $pyOk = $true }
    } catch { }
}
if ($pyOk) {
    Reset-Env
    $env:PRIVATE_KEY_PEM = Pem-ForEnv (Join-Path $KeysDir "python-agent.private.pem")
    $env:GRAAS_API_KEY   = $ApiKey
    $env:INTERNAL_SECRET = $InternalSecret
    $env:PORT            = "8001"
    Start-Svc "python-agent" "python" "-m uvicorn main:app --host 0.0.0.0 --port 8001" (Join-Path $Root "agents\python-agent")
    Wait-Until { Test-Port 8001 } 20 "Python claim agent on :8001" "python-agent"
} else {
    Say "  [SKIP] python with uvicorn and fastapi not found. The claim-v1 flow does not need it." "Yellow"
}

# ---- Register the kernel (proof of possession), then approve everyone ---------------------------
Say "[7] Registering the O-Lang kernel with the gateway..."
$regScript = Join-Path $LogDir "register-kernel.cjs"
@'
const path = require("path");
const { GraasSession, loadOrCreateKey } = require(path.join(process.argv[2], "src", "olang-kernel", "src", "runtime", "graasSession.cjs"));
(async () => {
  const s = new GraasSession({ gatewayUrl: process.env.GRAAS_GATEWAY_URL, apiKey: process.env.GRAAS_API_KEY,
                               privateKeyPem: loadOrCreateKey({ file: process.env.KERNEL_KEY_FILE }) });
  console.log("  kernel registration: " + await s.register());
})().catch((e) => {
  console.error("  kernel registration failed: " + (e && e.message));
  if (e && e.status !== undefined) console.error("  http status: " + e.status);
  if (e && e.code !== undefined) console.error("  code: " + e.code);
  if (e && e.detail !== undefined) console.error("  detail: " + e.detail);
  process.exit(1);
});
'@ | Set-Content $regScript -Encoding utf8
$env:GRAAS_GATEWAY_URL = $GatewayUrl
$env:GRAAS_API_KEY     = $ApiKey
$env:KERNEL_KEY_FILE   = $KernelKeyFile
node $regScript $Root
if ($LASTEXITCODE -ne 0) { throw "Kernel registration failed (see message above)." }
Remove-Item $regScript -Force

Say "[8] Waiting for agents to prove their keys, then approving..."
$agents = @("olang-kernel", "node-fraud-checker")
if ($pyOk) { $agents += "python-claim-processor" }
foreach ($a in $agents) {
    try {
        Wait-Until { (Invoke-RestMethod "$GatewayUrl/v1/agents/$a").proven } 30 "$a proven" $null
    } catch {
        if ($a -eq "python-claim-processor") {
            # Optional agent: the claim-v1 flow does not use it, so carry on and show why it failed.
            Say "  [SKIP] python-claim-processor did not register. Continuing without it (claim-v1 does not need it)." "Yellow"
            Show-Log "python-agent"
            continue
        }
        throw
    }
    try {
        Invoke-RestMethod "$GatewayUrl/v1/admin/agents/$a/approve" -Method Post -Headers @{ "x-admin-key" = $AdminKey } | Out-Null
        Say "  [OK] approved $a" "Green"
    } catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 409) { Say "  [OK] $a already approved" "Green" }
        else { Say "  [FAIL] could not approve ${a}: $($_.Exception.Message)" "Red"; throw }
    }
}

# ---- MVP server ---------------------------------------------------------------------------------
Say "[9] Starting MVP server..."
Reset-Env
$env:PORT                      = "3001"
$env:GRAAS_GATEWAY_URL         = $GatewayUrl
$env:GRAAS_API_KEY             = $ApiKey
$env:CALL_TOKEN_SECRET         = $CallSecret
$env:KERNEL_KEY_FILE           = $KernelKeyFile      # same key the kernel registered with
$env:OLANG_AUDIT_PRIVATE_KEY   = Join-Path $KeysDir "audit.private.pem"
Start-Svc "mvp-server" "node" "src/server.js" $Root
Wait-Until { Test-Port 3001 } 30 "MVP server on :3001" "mvp-server"

Say "[10] Seeding contract claim-v1..."
$seed = @{
    contractId = "claim-v1"; providerId = "acme-health"; name = "Claim Processor"
    requiredCapabilities = @("read_claim", "fraud_check", "submit_claim", "flag_for_review")
    pricePerResult = 500
} | ConvertTo-Json
try {
    Invoke-RestMethod "$MvpUrl/seed/contract" -Method Post -ContentType "application/json" -Body $seed | Out-Null
    Say "  [OK] claim-v1 seeded" "Green"
} catch { Say "  [WARN] seeding failed: $($_.Exception.Message)" "Yellow"; Show-Log "mvp-server" }

Say "`nALL SERVICES ARE RUNNING. Logs: $LogDir" "Green"
Say "Gateway :3000   MVP server :3001   Node fraud agent :8002   Python agent :8001 (if present)"
Say "Stop everything with: .\start-graas.ps1 -Stop"

# ---- Optional test run --------------------------------------------------------------------------
if ($Test) {
    foreach ($claim in @("CLM-002", "CLM-001")) {
        Say "`nTEST: claim $claim" "Magenta"
        $body = @{ contractId = "claim-v1"; inputs = @{ claimId = $claim } } | ConvertTo-Json
        try {
            $r = Invoke-RestMethod "$MvpUrl/executions" -Method Post -ContentType "application/json" -Body $body
            $v = Invoke-RestMethod "$MvpUrl/executions/$($r.executionId)/verify" -Method Post
            Say "  Status: $($v.status)   Billable: $($v.billable)" "Green"
        } catch {
            Say "  [FAIL] $($_.Exception.Message)" "Red"
            if ($_.ErrorDetails.Message) { Say "  $($_.ErrorDetails.Message)" "Red" }
            Show-Log "mvp-server"; Show-Log "gateway"
        }
    }
}
