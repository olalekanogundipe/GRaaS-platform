# GRaaS Platform MVP Test Script for PowerShell

$baseUrl = "http://localhost:3000"

Write-Host "1. Seeding Result Contract..." -ForegroundColor Cyan
$seedBody = @{
    contractId = "claim-v1"
    providerId = "acme-health"
    pricePerResult = 250
} | ConvertTo-Json

try {
    $seedRes = Invoke-RestMethod -Uri "$baseUrl/seed/contract" -Method Post -Body $seedBody -ContentType "application/json"
    $seedRes | ConvertTo-Json -Depth 5
} catch {
    Write-Host "Error seeding contract: $_" -ForegroundColor Red
    exit
}

Write-Host "`n2. RaaS Creator submitting execution..." -ForegroundColor Cyan
$execBody = @{
    contractId = "claim-v1"
    inputs = @{
        claimId = "CLM-1001"
        amount = 500
    }
} | ConvertTo-Json -Depth 5

try {
    $execRes = Invoke-RestMethod -Uri "$baseUrl/executions" -Method Post -Body $execBody -ContentType "application/json"
    $execRes | ConvertTo-Json -Depth 5
    $execId = $execRes.executionId
} catch {
    Write-Host "Error creating execution: $_" -ForegroundColor Red
    exit
}

Write-Host "`n3. Verifying and Certifying execution (ID: $execId)..." -ForegroundColor Cyan
try {
    $verifyRes = Invoke-RestMethod -Uri "$baseUrl/executions/$execId/verify" -Method Post
    $verifyRes | ConvertTo-Json -Depth 5
    $certId = $verifyRes.certificateId
} catch {
    Write-Host "Error verifying execution: $_" -ForegroundColor Red
    exit
}

if ($certId) {
    Write-Host "`n4. Fetching Result Certificate..." -ForegroundColor Cyan
    try {
        $certRes = Invoke-RestMethod -Uri "$baseUrl/certificates/$certId"
        $certRes | ConvertTo-Json -Depth 5
    } catch {
        Write-Host "Error fetching certificate: $_" -ForegroundColor Red
    }
}

Write-Host "`n5. Checking Billing Meter..." -ForegroundColor Cyan
try {
    $meterRes = Invoke-RestMethod -Uri "$baseUrl/meter"
    $meterRes | ConvertTo-Json -Depth 5
} catch {
    Write-Host "Error fetching meter: $_" -ForegroundColor Red
}

Write-Host "`nTest completed." -ForegroundColor Green
