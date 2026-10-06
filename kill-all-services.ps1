# kill-all-services.ps1
# Stops all GRaaS platform services and optionally cleans up state

$RootDir = $PSScriptRoot
$DataDir = Join-Path $RootDir "data"

Write-Host "[STOP] Stopping GRaaS Platform Services..." -ForegroundColor Cyan

# Helper function to kill process by port
function Stop-ServiceOnPort {
    param(
        [int]$Port,
        [string]$ServiceName
    )
    
    try {
        $connections = netstat -ano | Select-String ":$Port\s"
        if ($connections) {
            $processIds = $connections | ForEach-Object {
                ($_ -split '\s+')[-1]
            } | Select-Object -Unique | Where-Object { $_ -ne '0' -and $_ -ne '' }
            
            foreach ($processId in $processIds) {
                try {
                    $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
                    if ($proc) {
                        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
                        Write-Host "  [OK] Stopped ${ServiceName} (PID: $processId on port $Port)" -ForegroundColor Green
                    }
                } catch {
                    Write-Host "  [WARN] Could not stop PID $processId for ${ServiceName}" -ForegroundColor Yellow
                }
            }
        } else {
            Write-Host "  [SKIP] ${ServiceName} not running on port $Port" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  [ERR] Error checking port $Port for ${ServiceName}: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# -- 1. Stop GRaaS Gateway (port 3000) ----------------------------------------
Write-Host "[1/4] Stopping GRaaS Gateway..." -ForegroundColor Yellow
Stop-ServiceOnPort -Port 3000 -ServiceName "GRaaS Gateway"

# -- 2. Stop MVP Server (port 3001) -------------------------------------------
Write-Host "[2/4] Stopping MVP Server..." -ForegroundColor Yellow
Stop-ServiceOnPort -Port 3001 -ServiceName "MVP Server"

# -- 3. Stop Python Claim Agent (port 8001) -----------------------------------
Write-Host "[3/4] Stopping Python Claim Agent..." -ForegroundColor Yellow
Stop-ServiceOnPort -Port 8001 -ServiceName "Python Claim Agent"

# -- 4. Stop Node.js Fraud Agent (any remaining node processes) ---------------
Write-Host "[4/4] Stopping Node.js Fraud Agent..." -ForegroundColor Yellow
$nodeProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match "node-agent|fraud" -or $_.MainWindowTitle -match "node-agent"
}
if ($nodeProcesses) {
    foreach ($proc in $nodeProcesses) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  [OK] Stopped Node.js Fraud Agent (PID: $($proc.Id))" -ForegroundColor Green
    }
} else {
    Write-Host "  [SKIP] No Node.js Fraud Agent processes found" -ForegroundColor Yellow
}

# -- 5. Kill any stray PowerShell windows from start-all-services.ps1 ---------
Write-Host "[5/5] Cleaning up stray PowerShell windows..." -ForegroundColor Yellow
$strayPowerShells = Get-Process -Name "powershell" -ErrorAction SilentlyContinue | Where-Object {
    $_.Id -ne $PID -and $_.MainWindowTitle -match "npm start|uvicorn|node"
}
if ($strayPowerShells) {
    foreach ($proc in $strayPowerShells) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "  [OK] Closed stray window (PID: $($proc.Id))" -ForegroundColor Green
    }
} else {
    Write-Host "  [SKIP] No stray PowerShell windows found" -ForegroundColor Yellow
}

# -- 6. Optional: Clean up temp files and state -------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "[QUESTION] Do you want to reset to a completely fresh state?" -ForegroundColor Yellow
Write-Host "  This will delete:" -ForegroundColor White
Write-Host "    - SQLite database (data/graas.db)" -ForegroundColor White
Write-Host "    - Audit logs (logs/)" -ForegroundColor White
Write-Host "    - Temp registration files" -ForegroundColor White
Write-Host ""
$reset = Read-Host "Type 'yes' to reset, or press Enter to skip"

if ($reset -eq 'yes') {
    Write-Host ""
    Write-Host "[RESET] Cleaning up state..." -ForegroundColor Yellow
    
    # Delete SQLite database
    if (Test-Path $DataDir) {
        Remove-Item -Path $DataDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  [OK] Deleted SQLite database" -ForegroundColor Green
    }
    
    # Delete logs
    $logsDir = Join-Path $RootDir "logs"
    if (Test-Path $logsDir) {
        Remove-Item -Path $logsDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  [OK] Deleted logs" -ForegroundColor Green
    }
    
    # Delete temp registration files
    $tempFiles = Get-ChildItem -Path $RootDir -Filter "temp-*.cjs" -ErrorAction SilentlyContinue
    foreach ($file in $tempFiles) {
        Remove-Item -Path $file.FullName -Force -ErrorAction SilentlyContinue
        Write-Host "  [OK] Deleted temp file: $($file.Name)" -ForegroundColor Green
    }
    
    Write-Host "[RESET] State reset complete!" -ForegroundColor Green
} else {
    Write-Host "[SKIP] State preserved." -ForegroundColor Yellow
}

# -- 7. Completion ------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "[SUCCESS] ALL SERVICES STOPPED!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "You can now run '.\start-all-services.ps1' to start fresh." -ForegroundColor White
Write-Host "Press any key to close..." -ForegroundColor Yellow
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")