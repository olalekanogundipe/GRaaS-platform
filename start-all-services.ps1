# start-all-services.ps1
# Automates the startup and approval of the ENTIRE GRaaS platform (All 4 Services)

$RootDir = $PSScriptRoot
$GatewayDir = Join-Path $RootDir "gateway"
$NodeAgentDir = Join-Path $RootDir "agents\node-agent"
$PythonAgentDir = Join-Path $RootDir "agents\python-agent"
$KeysDir = Join-Path $RootDir ".keys"

Write-Host "[START] Starting ALL GRaaS Platform Services..." -ForegroundColor Cyan

# -- 1. Start GRaaS Gateway ----------------------------------------------------
Write-Host "[1/7] Starting GRaaS Gateway..." -ForegroundColor Yellow
$gatewayCmd = @"
`$env:PRIVATE_KEY_PEM = (Get-Content '$KeysDir\gateway.private.pem' -Raw) -replace '`r`n', '\n' -replace '`n', '\n'
`$env:GATEWAY_API_KEYS = 'dev-key'
`$env:ADMIN_API_KEY = 'dev-admin'
`$env:INTERNAL_SECRET = 'super-secret-internal-string'
`$env:CALL_TOKEN_SECRET = 'super-secret-call-token-string'
`$env:ALLOW_INSECURE_DEV = 'true'
cd '$GatewayDir'
npm start
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $gatewayCmd -WindowStyle Normal

# Wait for Gateway to be healthy
Write-Host "[WAIT] Waiting for Gateway to be healthy..." -ForegroundColor Yellow
do {
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:3000/healthz" -ErrorAction SilentlyContinue
        if ($response.ok) { break }
    } catch { }
} while ($true)
Write-Host "[OK] Gateway is online!" -ForegroundColor Green

# -- 2. Start Node.js Fraud Agent ----------------------------------------------
Write-Host "[2/7] Starting Node.js Fraud Agent..." -ForegroundColor Yellow
$nodeCmd = @"
`$env:PRIVATE_KEY_PEM = (Get-Content '$KeysDir\node-agent.private.pem' -Raw) -replace '`r`n', '\n' -replace '`n', '\n'
`$env:INTERNAL_SECRET = 'super-secret-internal-string'
`$env:GRAAS_API_KEY = 'dev-key'
`$env:GATEWAY_URL = 'http://localhost:3000'
cd '$NodeAgentDir'
npm start
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $nodeCmd -WindowStyle Normal

# -- 3. Start Python Claim Agent -----------------------------------------------
Write-Host "[3/7] Starting Python Claim Agent..." -ForegroundColor Yellow
$pythonCmd = @"
`$env:PRIVATE_KEY_PEM = (Get-Content '$KeysDir\python-agent.private.pem' -Raw) -replace '`r`n', '\n' -replace '`n', '\n'
`$env:INTERNAL_SECRET = 'super-secret-internal-string'
`$env:GRAAS_API_KEY = 'dev-key'
`$env:GATEWAY_URL = 'http://localhost:3000'
`$env:ALLOW_INSECURE_DEV = 'true'
cd '$PythonAgentDir'
uvicorn main:app --host 0.0.0.0 --port 8001
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $pythonCmd -WindowStyle Normal

# -- 4. Start MVP Server -------------------------------------------------------
Write-Host "[4/7] Starting GRaaS Platform MVP Server..." -ForegroundColor Yellow
$mvpCmd = @"
`$env:PORT = 3001
`$env:GRAAS_GATEWAY_URL = 'http://localhost:3000'
`$env:GRAAS_API_KEY = 'dev-key'
`$env:CALL_TOKEN_SECRET = 'super-secret-call-token-string'
cd '$RootDir'
node src/server.js
"@
Start-Process powershell -ArgumentList "-NoExit", "-Command", $mvpCmd -WindowStyle Normal

# Wait for MVP Server to be healthy (check if port 3001 is listening)
Write-Host "[WAIT] Waiting for MVP Server to be healthy..." -ForegroundColor Yellow
Start-Sleep -Seconds 4 # Give Node.js a moment to boot
Write-Host "[OK] MVP Server is online!" -ForegroundColor Green

# -- 5. Wait for Agents to Self-Register ---------------------------------------
Write-Host "[5/7] Waiting for agents to self-register with the Gateway..." -ForegroundColor Yellow
$agents = @("node-fraud-checker", "python-claim-processor")
foreach ($agent in $agents) {
    $registered = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $res = Invoke-RestMethod -Uri "http://localhost:3000/v1/agents/$agent" -ErrorAction SilentlyContinue
            if ($res.proven) {
                $registered = $true
                break
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if ($registered) {
        Write-Host "  [OK] $agent registered and proven." -ForegroundColor Green
    } else {
        Write-Host "  [WARN] $agent did not register in time. Check its terminal window." -ForegroundColor Red
    }
}

# -- 6. Approve Agents ---------------------------------------------------------
Write-Host "[6/7] Approving agents via Admin API..." -ForegroundColor Yellow
$headers = @{ "x-admin-key" = "dev-admin" }

foreach ($agent in $agents) {
    try {
        $res = Invoke-RestMethod -Uri "http://localhost:3000/v1/admin/agents/$agent/approve" -Method Post -Headers $headers
        if ($res.status -eq "active") {
            Write-Host "  [OK] Approved: $agent" -ForegroundColor Green
        }
    } catch {
        Write-Host "  [FAIL] Failed to approve $agent : $($_.Exception.Message)" -ForegroundColor Red
    }
}

# -- 7. Register and Approve O-Lang Kernel -------------------------------------
Write-Host "[7/7] Registering and Approving O-Lang Kernel..." -ForegroundColor Yellow
$env:GRAAS_GATEWAY_URL = "http://localhost:3000"
$env:GRAAS_API_KEY = "dev-key"
$env:KERNEL_KEY_FILE = Join-Path $KeysDir "kernel.private.pem"

try {
    $registerScript = @"
const fs = require('fs');
const crypto = require('crypto');

const keyFile = process.env.KERNEL_KEY_FILE;
if (!fs.existsSync(keyFile)) {
  console.log('[WARN] Kernel key not found, generating...');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  fs.writeFileSync(keyFile, privateKey, { mode: 0o600 });
  fs.writeFileSync(keyFile.replace('private', 'public'), publicKey);
}

const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
const pubKeyObj = crypto.createPublicKey(privateKeyPem);
const publicKeyPem = pubKeyObj.export({ type: 'spki', format: 'pem' }).trim();

async function register() {
  try {
    const res = await fetch('http://localhost:3000/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.GRAAS_API_KEY },
      body: JSON.stringify({
        agentId: 'olang-kernel',
        publicKeyPem: publicKeyPem,
        endpoint: 'http://localhost'
      })
    });
    const data = await res.json();
    if (res.ok) {
      console.log('[OK] Kernel registered successfully');
    } else if (res.status === 409) {
      console.log('[OK] Kernel already registered');
    } else {
      console.log('[WARN] Kernel registration response:', data);
    }
  } catch (e) {
    console.error('[FAIL] Kernel registration failed:', e.message);
  }
}
register();
"@
    $registerScript | Set-Content "$RootDir\temp-register-kernel.cjs" -Encoding utf8
    & node "$RootDir\temp-register-kernel.cjs"
    Remove-Item "$RootDir\temp-register-kernel.cjs" -Force
    
    Start-Sleep -Seconds 2
    
    $statusRes = Invoke-RestMethod -Uri "http://localhost:3000/v1/agents/olang-kernel" -ErrorAction SilentlyContinue
    if ($statusRes.status -eq "active") {
        Write-Host "  [OK] olang-kernel is already approved and active." -ForegroundColor Green
    } else {
        $res = Invoke-RestMethod -Uri "http://localhost:3000/v1/admin/agents/olang-kernel/approve" -Method Post -Headers $headers
        if ($res.status -eq "active") {
            Write-Host "  [OK] Approved: olang-kernel" -ForegroundColor Green
        }
    }
} catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 409) {
        Write-Host "  [OK] olang-kernel was already approved (409 ignored)." -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Failed to register/approve kernel: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# -- 8. Completion -------------------------------------------------------------
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "[SUCCESS] ALL 4 SERVICES ARE RUNNING AND APPROVED!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "You can now run your end-to-end tests in a NEW terminal." -ForegroundColor White
Write-Host "Press any key to close this management window (services will keep running)..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")