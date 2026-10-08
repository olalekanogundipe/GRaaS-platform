Write-Host " Initializing GRaaS Platform Orchestrator..." -ForegroundColor Cyan

# 1. Nuke Ghost Processes
Write-Host "`n[1/6] Clearing ghost processes..." -ForegroundColor Yellow
@(3000, 3001, 8001, 8002) | ForEach-Object {
    (Get-NetTCPConnection -LocalPort $_ -ErrorAction SilentlyContinue).OwningProcess | 
    Select-Object -Unique | 
    Where-Object { $_ -ne 0 -and $_ -ne $PID } | 
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2

# 2. Wipe DB
Write-Host "[2/6] Wiping SQLite database..." -ForegroundColor Yellow
Remove-Item -Path "data\graas.db" -Force -ErrorAction SilentlyContinue

# 3. Fix BOM
Write-Host "[3/6] Ensuring gateway/policy.json is UTF-8 (No BOM)..." -ForegroundColor Yellow
if (Test-Path "gateway\policy.json") {
    $content = Get-Content "gateway\policy.json" -Raw
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Resolve-Path "gateway\policy.json").Path, $content, $utf8NoBom)
}

# 4. Start Gateway
Write-Host "[4/6] Starting Gateway (Port 3000)..." -ForegroundColor Yellow
$env:GATEWAY_API_KEYS="dev-key"
$env:ADMIN_API_KEY="dev-admin"
$env:INTERNAL_SECRET="internal-secret"
$env:CALL_TOKEN_SECRET="call-token-secret"
Start-Process -FilePath "node" -ArgumentList "src/index.js" -WorkingDirectory "gateway" -WindowStyle Minimized

Write-Host "      Waiting for Gateway..." -ForegroundColor Gray
for ($i=0; $i -lt 15; $i++) {
    try { Invoke-RestMethod -Uri "http://localhost:3000/healthz" -TimeoutSec 2 -ErrorAction Stop | Out-Null; break } catch { Start-Sleep 1 }
}
Write-Host "       Gateway healthy." -ForegroundColor Green

# 5. Start Agents
Write-Host "[5/6] Starting Agents..." -ForegroundColor Yellow
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "agents\node-agent" -WindowStyle Minimized
Start-Process -FilePath "python" -ArgumentList "main.py" -WorkingDirectory "agents\python-agent" -WindowStyle Minimized

Write-Host "      Waiting for agents to prove..." -ForegroundColor Gray
$headers = @{ "x-api-key" = "dev-key" }
for ($i=0; $i -lt 20; $i++) {
    try {
        $py = Invoke-RestMethod -Uri "http://localhost:3000/v1/agents/python-claim-processor" -Headers $headers -TimeoutSec 2
        $nd = Invoke-RestMethod -Uri "http://localhost:3000/v1/agents/node-fraud-checker" -Headers $headers -TimeoutSec 2
        if ($py.proven -and $nd.proven) { break }
    } catch {}
    Start-Sleep 1
}

$adminHeaders = @{ "x-admin-key" = "dev-admin" }
Invoke-RestMethod -Uri "http://localhost:3000/v1/admin/agents/python-claim-processor/approve" -Method Post -Headers $adminHeaders | Out-Null
Invoke-RestMethod -Uri "http://localhost:3000/v1/admin/agents/node-fraud-checker/approve" -Method Post -Headers $adminHeaders | Out-Null
Write-Host "       Agents ACTIVE." -ForegroundColor Green

# 6. Start MVP Server
Write-Host "[6/6] Starting MVP Server (Port 3001)..." -ForegroundColor Yellow
$env:PORT="3001"
$env:GRAAS_GATEWAY_URL="http://localhost:3000"
$env:GRAAS_API_KEY="dev-key"
Start-Process -FilePath "node" -ArgumentList "src/server.js" -WindowStyle Minimized

Write-Host "      Waiting for MVP Server..." -ForegroundColor Gray
for ($i=0; $i -lt 15; $i++) {
    try { Invoke-RestMethod -Uri "http://localhost:3001/meter" -TimeoutSec 2 -ErrorAction Stop | Out-Null; break } catch { Start-Sleep 1 }
}
Write-Host "       MVP Server healthy." -ForegroundColor Green

# 7. Seed
Write-Host "`n[FINAL] Seeding contract..." -ForegroundColor Yellow
$contractBody = @{ 
    contractId = "claim-v1"; providerId = "acme-insurance"; name = "ACME Insurance Claims"
    requiredCapabilities = @("read_claim", "fraud_check", "submit_claim", "flag_for_review")
    permittedActions = @("read_claim", "fraud_check", "submit_claim", "flag_for_review")
    prohibitedActions = @("auto_approve", "modify_applicant")
    pricePerResult = 500; commissionRate = 0.20
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "http://localhost:3001/seed/contract" -Method Post -ContentType "application/json" -Body $contractBody | Out-Null

Write-Host "`n GRaaS Platform fully operational!" -ForegroundColor Magenta
Write-Host "Run your test commands now!" -ForegroundColor Cyan
