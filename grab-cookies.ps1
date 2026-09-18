param([string]$Domain = "bahn.de")

Write-Host "=== Chrome Cookie Extractor ===" -ForegroundColor Cyan

# Kill ALL Chrome processes first
$chromeProcs = Get-Process -Name chrome -ErrorAction SilentlyContinue
if ($chromeProcs) {
    Write-Host "Schliesse Chrome ($($chromeProcs.Count) Prozesse)..." -ForegroundColor Yellow
    $chromeProcs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

# Start Chrome with CDP
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chromePath)) {
    $chromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chromePath)) {
    $chromePath = "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
}

Write-Host "Starte Chrome mit CDP auf Port 9222..." -ForegroundColor Green
Start-Process $chromePath -ArgumentList "--remote-debugging-port=9222", "https://www.bahn.de/"

# Wait for CDP
$ready = $false
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $ver = Invoke-RestMethod -Uri "http://localhost:9222/json/version" -TimeoutSec 2
        if ($ver) { $ready = $true; break }
    } catch {}
    Write-Host "." -NoNewline
}
Write-Host ""

if (-not $ready) {
    Write-Host "CDP nicht erreichbar!" -ForegroundColor Red
    exit 1
}
Write-Host "CDP verbunden: $($ver.Browser)" -ForegroundColor Green

# Wait for bahn.de to load and sensor to run
Write-Host "Warte 10 Sekunden fuer Akamai Sensor..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

# Get tabs and find bahn.de
$tabs = Invoke-RestMethod -Uri "http://localhost:9222/json" -TimeoutSec 5
$tab = $tabs | Where-Object { $_.url -like "*bahn.de*" -and $_.type -eq "page" } | Select-Object -First 1
if (-not $tab) { $tab = $tabs | Where-Object { $_.type -eq "page" } | Select-Object -First 1 }

if (-not $tab -or -not $tab.webSocketDebuggerUrl) {
    Write-Host "Kein Tab gefunden!" -ForegroundColor Red
    exit 1
}

Write-Host "Tab: $($tab.url)" -ForegroundColor Cyan

# Connect via WebSocket and get cookies
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([System.Uri]$tab.webSocketDebuggerUrl, $ct).Wait()

$cmd = '{"id":1,"method":"Network.getCookies","params":{"urls":["https://www.bahn.de/"]}}'
$sendBuf = [System.Text.Encoding]::UTF8.GetBytes($cmd)
$ws.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList @(,$sendBuf)), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).Wait()

$recvBuf = New-Object byte[] 131072
$result = ""
do {
    $resp = $ws.ReceiveAsync((New-Object System.ArraySegment[byte] -ArgumentList @(,$recvBuf)), $ct).Result
    $result += [System.Text.Encoding]::UTF8.GetString($recvBuf, 0, $resp.Count)
} while (-not $resp.EndOfMessage)

$ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "", $ct).Wait()

$parsed = $result | ConvertFrom-Json
$allCookies = $parsed.result.cookies
$targetNames = @('_abck', 'ak_bmsc', 'bm_sz')
$found = $allCookies | Where-Object { $_.name -in $targetNames -and $_.domain -like "*bahn*" }

Write-Host "`n=== Cookies ===" -ForegroundColor Yellow
$cookieObj = @{}
foreach ($c in $found) {
    $cookieObj[$c.name] = $c.value
    $len = $c.value.Length
    $preview = if ($len -gt 60) { $c.value.Substring(0, 60) + "..." } else { $c.value }
    Write-Host "  $($c.name) ($len chars) = $preview" -ForegroundColor Green
}

if ($cookieObj.Count -gt 0) {
    $cookieObj | ConvertTo-Json | Out-File "bahn_cookies.json" -Encoding UTF8
    $header = ($cookieObj.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "; "
    $header | Out-File "bahn_cookie_header.txt" -Encoding UTF8
    Write-Host "`nExportiert: bahn_cookies.json + bahn_cookie_header.txt" -ForegroundColor Green
    Write-Host "`nCookie-Header zum Kopieren:" -ForegroundColor Yellow
    Write-Host $header
} else {
    Write-Host "Keine Akamai-Cookies gefunden!" -ForegroundColor Red
    Write-Host "Alle bahn.de Cookies:" -ForegroundColor Yellow
    ($allCookies | Where-Object { $_.domain -like "*bahn*" }) | ForEach-Object { Write-Host "  $($_.name) ($($_.domain))" }
}
