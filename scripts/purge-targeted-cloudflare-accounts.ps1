[CmdletBinding()]
param(
    [string]$BaseUrl = "https://cloudflare-container-networking.brightlambre22-6dd.workers.dev",
    [string[]]$AccountIds = @(
        "acct-ecc9fff5-6be1-4687-ad5e-a06112e0cf5c",
        "acct-952b303b-4b12-491d-9dd7-4947ebc03055",
        "acct-2f359f27-4eb4-4b74-8952-689a9884b2a5",
        "acct-f5cae73a-445f-42c7-bca9-1ea4556814e2",
        "acct-715b8575-55d4-4910-8dc3-10cca9035052",
        "acct-cb16e416-ef8c-4357-a445-6a42f3f96f93",
        "acct-c1377177-788d-40e8-9148-9b09b18d52a2",
        "acct-78bcaf07-607c-4110-9102-8565c1a68d41"
    ),
    [switch]$Execute
)

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")
$Endpoint = "$BaseUrl/api/admin/purge-accounts"

foreach ($id in $AccountIds) {
    if ($id -notmatch '^acct-[a-f0-9-]{36}$') {
        throw "Invalid account ID: $id"
    }
}
if (($AccountIds | Select-Object -Unique).Count -ne $AccountIds.Count) {
    throw "Duplicate account IDs supplied. Stopping."
}

Write-Host ""
Write-Host "Targeted Cloudflare account-data purge" -ForegroundColor Cyan
Write-Host "Endpoint: $Endpoint"
Write-Host "Accounts:  $($AccountIds.Count)"
$AccountIds | ForEach-Object { Write-Host "  $_" }
Write-Host ""
if (-not $Execute) {
    Write-Host "DRY RUN ONLY. No data will be deleted." -ForegroundColor Yellow
    Write-Host "After reviewing the inventory, rerun with -Execute to perform deletion."
} else {
    Write-Host "EXECUTE MODE: this permanently deletes data for the listed accounts." -ForegroundColor Red
    $approval = Read-Host 'Type PURGE SPECIFIED ACCOUNTS to continue'
    if ($approval -cne "PURGE SPECIFIED ACCOUNTS") {
        throw "Confirmation did not match. Nothing was requested for deletion."
    }
}

$secureCode = Read-Host "Enter your 5-digit admin access code" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCode)
try {
    $adminCode = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}

if ($adminCode -notmatch '^\d{5}$') {
    $adminCode = $null
    throw "Admin code must be exactly 5 digits."
}

$headers = @{ Authorization = "Bearer $adminCode" }
$body = @{
    account_ids = @($AccountIds)
    dry_run = (-not $Execute)
}
if ($Execute) {
    $body.confirm = "PURGE_SPECIFIED_ACCOUNTS"
}
$jsonBody = $body | ConvertTo-Json -Depth 5

try {
    $response = Invoke-RestMethod -Method Post -Uri $Endpoint -Headers $headers -ContentType "application/json" -Body $jsonBody -TimeoutSec 180
    $response | ConvertTo-Json -Depth 12
    if (-not $response.ok) {
        throw "The API reported one or more failures. Review the JSON results above before retrying."
    }
    if (-not $Execute) {
        Write-Host ""
        Write-Host "Dry run complete. No deletion was requested." -ForegroundColor Green
        Write-Host "Review snapshot counts and target IDs before running with -Execute."
    } else {
        Write-Host ""
        Write-Host "Purge request finished. Check every result and verify through the inventory endpoint." -ForegroundColor Yellow
        Write-Host "This does not delete the namespace itself or Cloudflare dashboard request metrics/history."
    }
} catch {
    Write-Error "Request failed: $($_.Exception.Message)"
    Write-Host "If the endpoint returns 404, the targeted purge Worker changes have not been deployed yet." -ForegroundColor Yellow
    throw
} finally {
    $adminCode = $null
    $headers = $null
    $jsonBody = $null
    $secureCode.Dispose()
}
