[CmdletBinding()]
param(
    # Supply the exact base URL printed by the Cloudflare Worker deployment.
    # Example shape only: https://<worker-name>.<account-subdomain>.workers.dev
    [string]$BaseUrl = "",
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

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    $BaseUrl = Read-Host "Enter the exact deployed Cloudflare Worker base URL (from its deployment details)"
}
$BaseUrl = $BaseUrl.Trim().TrimEnd("/")
$parsedBaseUrl = $null
if (-not [Uri]::TryCreate($BaseUrl, [UriKind]::Absolute, [ref]$parsedBaseUrl) -or
    $parsedBaseUrl.Scheme -ne "https" -or
    $parsedBaseUrl.AbsolutePath -ne "/" -or
    $parsedBaseUrl.Query -or $parsedBaseUrl.Fragment) {
    throw "BaseUrl must be the exact HTTPS Worker origin, for example https://<worker-name>.<account-subdomain>.workers.dev"
}
$BaseUrl = $parsedBaseUrl.GetLeftPart([UriPartial]::Authority)
$Endpoint = "$BaseUrl/api/admin/purge-accounts"

function Get-HttpStatusCode($ErrorRecord) {
    try {
        if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.StatusCode) {
            return [int]$ErrorRecord.Exception.Response.StatusCode
        }
    } catch {}
    return 0
}

foreach ($id in $AccountIds) {
    if ($id -notmatch '^acct-[a-f0-9-]{36}$') {
        throw "Invalid account ID: $id"
    }
}
if (($AccountIds | Select-Object -Unique).Count -ne $AccountIds.Count) {
    throw "Duplicate account IDs supplied. Stopping."
}

# Validate the supplied origin before prompting for the admin code or sending account IDs.
try {
    $health = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health" -TimeoutSec 30
} catch {
    $status = Get-HttpStatusCode $_
    throw "Could not verify $BaseUrl/health (HTTP $status). Use the exact URL printed by the Cloudflare Worker deployment. No purge request was sent."
}
if ($health.status -ne "ok" -or $health.service -ne "cloudflare-container-networking") {
    throw "The supplied URL did not return the expected Cloudflare Worker health response. Check the deployment URL. No purge request was sent."
}

# Probe the route without credentials or account IDs. This cannot trigger a purge:
# the endpoint must reject the request as unauthorized or report missing admin configuration.
$probeStatus = 0
try {
    $probe = Invoke-WebRequest -Method Post -Uri $Endpoint -ContentType "application/json" -Body "{}" -TimeoutSec 30 -ErrorAction Stop
    $probeStatus = [int]$probe.StatusCode
} catch {
    $probeStatus = Get-HttpStatusCode $_
}
if ($probeStatus -notin @(401, 503)) {
    if ($probeStatus -eq 404) {
        throw "The Worker URL responds to /health, but /api/admin/purge-accounts returns 404. The deployed Worker does not expose this route yet. No account IDs or admin code were sent; deploy the merged main branch and retry."
    }
    throw "Could not verify the targeted purge route (HTTP $probeStatus). Expected 401 or 503 from the unauthenticated safety probe. No account IDs or admin code were sent."
}

Write-Host ""
Write-Host "Targeted Cloudflare account-data purge" -ForegroundColor Cyan
Write-Host "Worker:    $BaseUrl"
Write-Host "Endpoint:  $Endpoint"
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
    throw
} finally {
    $adminCode = $null
    $headers = $null
    $jsonBody = $null
    $secureCode.Dispose()
}
