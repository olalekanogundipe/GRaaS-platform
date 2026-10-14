# start-graas.ps1
# One command to start the whole GRaaS stack. 
# Usage: .\start-graas.ps1 [-Reset] [-Stop]

param(
    [switch]$Stop,
    [switch]$Reset
)

$ErrorActionPreference = "Stop"
$Root      = $PSScriptRoot
$LogDir    = Join-Path $Root "logs"
$GatewayDir = Join-Path $Root "gateway"
$ApiKey    = "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59"
$AdminKey  = "admin-master-key"

function Say($msg, $color = "Cyan") { Write-Host $msg -ForegroundColor $color }

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

function Start-Svc($name, $command, $arguments, $workDir) {
    $out = Join-Path $LogDir "$name.log"
    $err = Join-Path $LogDir "$name.err.log"
    
    # Use cmd /c to ensure npm scripts work correctly in Windows
    $fullCommand = "cmd /c $command $arguments"
    
    Start-Process -FilePath "cmd" -ArgumentList "/c", $command, $arguments -WorkingDirectory $workDir `
        -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden | Out-Null
    Say "  started $name" "Green"
}

# ---- Start Unified Gateway (Includes Agents) ----------------------------------------------------
Say "[4] Starting Unified GRaaS Platform (Gateway + Agents)..."
# We use 'npm start' which triggers src/server.js to start Gateway + Agents together
Start-Svc "unified-platform" "npm" "start" $GatewayDir

# ---- Stop ---------------------------------------------------------------------------------------
Say "[1] Stopping services..."
Stop-Ports @(3000, 3001, 8002, 8003)
if ($Stop) { Say "Stopped." "Green"; return }

if ($Reset) {
    Say "[2] Resetting local data..."
    if (Test-Path (Join-Path $GatewayDir "data")) { Remove-Item (Join-Path $GatewayDir "data") -Recurse -Force }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---- Prerequisites ------------------------------------------------------------------------------
Say "[3] Checking prerequisites..."
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js not found." }

# ---- Start Unified Gateway (Includes Agents) ----------------------------------------------------
Say "[4] Starting Unified GRaaS Platform (Gateway + Agents)..."
# We use 'npm start' which triggers src/server.js to start Gateway + Agents together
Start-Svc "unified-platform" "npm" "start" $GatewayDir

# Wait for the gateway to be ready
Say "[5] Waiting for Gateway to initialize Turso and start agents..."
Start-Sleep -Seconds 10 # Give it time to boot up all 3 services

# ---- Register & Approve Agents ------------------------------------------------------------------
Say "[6] Registering and approving default agents..."

$agents = @(
    @{ id = "node-fraud-checker"; cap = "fraud_check"; port = 8002 },
    @{ id = "research-agent"; cap = "research"; port = 8003 }
)

foreach ($agent in $agents) {
    try {
        # Register
        Invoke-RestMethod -Uri "http://localhost:3000/v1/agents/register" -Method Post -ContentType "application/json" -Body (@{
            agentId = $agent.id
            publicKey = "mock-key-$($agent.id)"
            endpoint = "http://localhost:$($agent.port)"
            capabilities = @($agent.cap)
        } | ConvertTo-Json) | Out-Null
        
        # Approve
        Invoke-RestMethod -Uri "http://localhost:3000/v1/admin/agents/$($agent.id)/approve" -Method Post -Headers @{ "x-admin-key" = $AdminKey } | Out-Null
        
        # Fund
        Invoke-RestMethod -Uri "http://localhost:3000/v1/agents/$($agent.id)/deposit" -Method Post -ContentType "application/json" -Body (@{ amount = 1000 } | ConvertTo-Json) | Out-Null
        
        Say "  [OK] $($agent.id) registered, approved, and funded." "Green"
    } catch {
        Say "  [WARN] Failed to setup $($agent.id): $($_.Exception.Message)" "Yellow"
    }
}

Say "`n🚀 ALL SERVICES RUNNING!" "Green"
Say "   Gateway: http://localhost:3000"
Say "   Dashboard: http://localhost:3000/graas (if running locally)"
Say "   Logs: $LogDir"
Say "`nTo stop: .\start-graas.ps1 -Stop"