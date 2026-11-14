# Local Gmap Worker: turns this Windows PC into a gmap.scan worker for the
# Local Gmap Worker API service (../server.mjs, hosted on Railway).
#
# It asks the service for a Google Maps job, reads the businesses from Google Maps
# on this PC's own internet line, and posts them back. Only outbound requests:
# nothing to open on the router.
#
# No browser. Maps fills its result list from /search?tbm=map, 20 businesses a
# page, each with its phone, website, address, rating, categories, coordinates
# and place id. This reads those pages directly, one after another, paging with
# the pb offset. The field positions are gosom's ParseSearchResults
# (github.com/gosom/google-maps-scraper, gmaps/multiple.go, MIT) plus the
# place id at 78 (gosom gmaps/entry.go). On 2026-10-29 the factory sweep of
# Taman Daya read 802 businesses in 4 minutes this way; scraper.tech read 839.
#
# The sweep is the service's (strategy.mjs): "<word> in <place>" for every word of
# the keyword's family, then for a Business scan "shop/company in <street>" for
# the streets the first pass found. The words come from the service on every job.
#
# It also takes web.fetch jobs: one page read on this PC's line and returned as
# markdown, text or html, in place of Jina Reader or Tavily extract. fetch.py
# does that with Scrapling's parts (no browser) in a Python of its own, which
# this sets up under %LOCALAPPDATA% on first start. Scans work without it.
# The same Python runs site.audit jobs (audit.py): an SEO and GEO benchmark of
# one website, a few dozen polite requests to that site.
#
# ads.research jobs (ads.mjs, on the same Node) read who advertises in one country and
# industry from Google's Ads Transparency Center and Meta's Ad Library. Google needs only
# the Node; Meta's page is opened in the browser web.shot uses.
#
# web.shot jobs (shot.mjs, on the portable Node the lookups use) take a proof
# screenshot of one page with the Microsoft Edge Windows already has, headless
# on a throwaway profile. Nothing is downloaded for it; a PC without Edge does
# not take shots.
#
# Windows PowerShell 5.1, ASCII only (5.1 reads a BOM-less script as ANSI).
param([ValidateSet('on', 'off', '')][string]$Autostart = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path $PSScriptRoot -Parent
# LOCAL_GMAP_WORKER_DATA runs a second, test worker beside this PC's real one: its own
# data folder and lock, and no Startup or desktop shortcut.
$TestData = [string]$env:LOCAL_GMAP_WORKER_DATA
$Data = $(if ($TestData) { [IO.Path]::GetFullPath($TestData) } else { Join-Path $env:LOCALAPPDATA 'LocalGmapWorker' })
$LogFile = Join-Path $Data 'worker.log'
New-Item -ItemType Directory -Force $Data | Out-Null

function Log([string]$Message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
  Write-Host $line
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) { Move-Item $LogFile "$LogFile.old" -Force }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
}

# ---------------------------------------------------------------- autostart

if ($Autostart) {
  $startup = [Environment]::GetFolderPath('Startup')
  $link = Join-Path $startup 'Local Gmap Worker.lnk'
  if ($Autostart -eq 'on') {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = Join-Path $Root 'Start Local Gmap Worker.cmd'
    $shortcut.WorkingDirectory = $Root
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Local Gmap Worker'
    $shortcut.Save()
    Write-Host "Autostart is on: the worker starts, minimised, every time you sign in to Windows."
    Write-Host "Shortcut: $link"
  } else {
    if (Test-Path $link) { Remove-Item $link -Force }
    Write-Host 'Autostart is off.'
  }
  [IO.File]::WriteAllText((Join-Path $Data 'autostart-configured.txt'), 'configured')
  exit 0
}

# ------------------------------------------------------------------- config

function Read-EnvFile([string]$File) {
  $out = @{}
  if (-not (Test-Path $File)) { return $out }
  foreach ($line in Get-Content $File) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
    $i = $t.IndexOf('=')
    $out[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim().Trim('"')
  }
  return $out
}

$Cfg = Read-EnvFile (Join-Path $Root 'worker.env')
$Lab = ([string]$Cfg['HUB_URL']).TrimEnd('/')
$Key = [string]$Cfg['WORKER_KEY']
if (-not $Lab -or -not $Key) {
  Log 'worker.env is missing HUB_URL or WORKER_KEY. Download the package again from the service: GET /api/worker/package.'
  exit 2
}
$Name = [string]$Cfg['WORKER_NAME']
if (-not $Name) { $Name = 'pc-' + ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9-]', '-') }
# Pause between two Google requests. 1 request a second was never refused in testing.
$PaceMs = 500
if ($Cfg['GMAP_PACE_MS']) { $PaceMs = [Math]::Max(0, [int]$Cfg['GMAP_PACE_MS']) }
# WEB_FETCH=off keeps this PC to Maps scans.
$FetchOn = ([string]$Cfg['WEB_FETCH']).ToLower() -ne 'off'
# WEB_SHOT=off keeps this PC from taking screenshots; SHOT_BROWSER names another
# Chromium browser (Chrome) instead of Edge.
$ShotOn = ([string]$Cfg['WEB_SHOT']).ToLower() -ne 'off'
$ShotBrowser = [string]$Cfg['SHOT_BROWSER']
$script:Types = 'gmap.scan'
# Time kept back from the job's deadline to post the result.
$PostMarginSec = 60
# After Google refuses this line, claim nothing for this long.
$BlockedRestSec = 1800
$Page = 20
$MaxPages = 15
# Where a search starts before the place's own centre is known. The query text
# places it ("factory in Taman Daya" lands in Johor Bahru from here too).
$DefaultCentre = @(3.139, 101.6869)

# One worker per PC: autostart and a double click must not run two.
$MutexName = 'Local\LocalGmapWorker'
if ($TestData) { $MutexName += '-' + (($Data.ToLower() -replace '[^a-z0-9]', '-').Trim('-')) }
$mutex = New-Object Threading.Mutex($false, $MutexName)
if (-not $mutex.WaitOne(0)) {
  Write-Host 'The Local Gmap Worker is already running on this PC.'
  exit 2
}

# A worker that died mid-lookup leaves its handler file behind.
Get-ChildItem -LiteralPath $Data -Filter 'lookup-*.mjs' -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# Enable sign-in startup once on first setup. Disabling it later stays disabled.
$AutostartMark = Join-Path $Data 'autostart-configured.txt'
if (-not $TestData -and -not (Test-Path $AutostartMark)) {
  try {
    $startupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Local Gmap Worker.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startupLink)
    $shortcut.TargetPath = Join-Path $Root 'Start Local Gmap Worker.cmd'
    $shortcut.WorkingDirectory = $Root
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    [IO.File]::WriteAllText($AutostartMark, 'configured')
    Log 'autostart enabled for Windows sign-in'
  } catch { Log "could not enable autostart: $($_.Exception.Message)" }
}

Get-ChildItem $Root -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

# "Local Worker v2" on the desktop, made on first start. Later starts only point
# it at this folder again if the folder moved; one the user deleted stays gone.
$DesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Local Worker v2.lnk'
$DesktopMark = Join-Path $Data 'desktop-shortcut.txt'
if (-not $TestData -and (-not (Test-Path $DesktopMark) -or (Test-Path $DesktopLink))) {
  try {
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($DesktopLink)
    $target = Join-Path $Root 'Start Local Gmap Worker.cmd'
    if ($shortcut.TargetPath -ne $target) {
      $shortcut.TargetPath = $target
      $shortcut.WorkingDirectory = $Root
      $shortcut.Description = 'Local Worker v2: Maps scans and web pages for the service'
      $shortcut.Save()
      Log "desktop shortcut: $DesktopLink"
    }
    [IO.File]::WriteAllText($DesktopMark, $DesktopLink)
  } catch { Log "no desktop shortcut: $($_.Exception.Message)" }
}

# Keep the PC awake while a job runs; Windows sleeping mid-scan loses the job.
Add-Type -Namespace LocalGmapWorker -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
function Stay-Awake([bool]$On) {
  if ($On) { [void][LocalGmapWorker.Power]::SetThreadExecutionState([uint32]2147483649) }
  else { [void][LocalGmapWorker.Power]::SetThreadExecutionState([uint32]2147483648) }
}

# ConvertFrom-Json on 5.1 is slow on Google's deeply nested arrays; this is not.
Add-Type -AssemblyName System.Web.Extensions
$Json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$Json.MaxJsonLength = [int]::MaxValue
$Json.RecursionLimit = 10000
$Invariant = [Globalization.CultureInfo]::InvariantCulture

# ----------------------------------------------------------------- service

# Every request goes through here. On 5.1, Invoke-WebRequest's -TimeoutSec does
# not cover reading the body, so a line that stalls mid-answer held a scan for
# 175 minutes on 2026-11-01, far past its 20-minute lease. ReadWriteTimeout
# bounds every read. Any HTTP status comes back as {status, body}; only a
# request that got no answer at all throws.
function Invoke-Http([string]$Method, [string]$Uri, [hashtable]$Headers = @{}, [byte[]]$Body = $null, [int]$TimeoutSec = 60) {
  $req = [Net.HttpWebRequest]::Create($Uri)
  $req.Method = $Method
  $req.Timeout = $TimeoutSec * 1000
  $req.ReadWriteTimeout = $TimeoutSec * 1000
  $req.AutomaticDecompression = [Net.DecompressionMethods]'GZip, Deflate'
  foreach ($name in $Headers.Keys) {
    if ($name -eq 'user-agent') { $req.UserAgent = $Headers[$name] } else { $req.Headers[$name] = $Headers[$name] }
  }
  $resp = $null
  try {
    if ($null -ne $Body) {
      $req.ContentType = 'application/json; charset=utf-8'
      $req.ContentLength = $Body.Length
      $out = $req.GetRequestStream()
      try { $out.Write($Body, 0, $Body.Length) } finally { $out.Close() }
    }
    $resp = $req.GetResponse()
  } catch {
    # PowerShell wraps the WebException; an HTTP error status still carries a response.
    $e = $_.Exception
    while ($e -and $e -isnot [Net.WebException]) { $e = $e.InnerException }
    if (-not $e) { throw }
    if (-not $e.Response) { throw $e }
    $resp = $e.Response
  }
  try {
    $buffer = New-Object IO.MemoryStream
    $resp.GetResponseStream().CopyTo($buffer)
    return @{ status = [int]$resp.StatusCode; body = [Text.Encoding]::UTF8.GetString($buffer.ToArray()) }
  } finally { $resp.Close() }
}

function Invoke-Hub([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutSec = 60) {
  # Assigned, not taken from an `if`: PowerShell would unroll the array.
  $bytes = $null
  if ($null -ne $Body) { $bytes = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 30 -Compress)) }
  return Invoke-Http $Method ($Lab + $Path) @{ authorization = 'Bearer ' + $Key } $bytes $TimeoutSec
}

$script:JobId = $null
$script:LastBeat = Get-Date
function Send-Beat {
  if (((Get-Date) - $script:LastBeat).TotalSeconds -lt 30) { return }
  $script:LastBeat = Get-Date
  try { [void](Invoke-Hub 'POST' '/api/jobs/heartbeat' @{ worker = $Name; types = @($script:Types.Split(',')); jobId = $script:JobId; chatBrowsers = (Get-ChatBrowsers) } 20) } catch { }
}

# ------------------------------------------------------------- google maps

# One element of Google's nested arrays, or $null. Arrays come back whole: a
# plain `return` would unroll them into the pipeline.
function At($Value, [int[]]$Path) {
  foreach ($i in $Path) {
    if ($Value -isnot [array] -or $i -ge $Value.Count) { return $null }
    $Value = $Value[$i]
  }
  if ($Value -is [array]) { return , $Value }
  return $Value
}

function Get-Pb([double]$Lat, [double]$Lon, [int]$Offset) {
  return '!4m12!1m3!1d3826.902183192154!2d' + $Lon.ToString('0.0000', $Invariant) + '!3d' + $Lat.ToString('0.0000', $Invariant) +
    '!2m3!1f0!2f0!3f0!3m2!1i600!2i800!4f15.0!7i' + $Page + '!8i' + $Offset +
    '!10b1!12m22!1m3!18b1!30b1!34e1!2m3!5m1!6e2!20e3!4b0!10b1!12b1!13b1!16b1!17m1!3e1!20m3!5e2!6b1!14b1!46m1!1b0' +
    '!96b1!19m4!2m3!1i360!2i120!4i8'
}

function Text($Value) { if ($null -ne $Value -and [string]$Value -ne '') { return [string]$Value } return $null }

$script:Requests = 0
$script:Blocked = $null
$UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

# One page of one search: up to 20 businesses.
function Get-ListPage([string]$Query, [double]$Lat, [double]$Lon, [int]$Offset) {
  $url = 'https://www.google.com/search?tbm=map&authuser=0&hl=en&gl=my&q=' + [uri]::EscapeDataString($Query) +
    '&pb=' + [uri]::EscapeDataString((Get-Pb $Lat $Lon $Offset))
  $script:Requests++
  $r = Invoke-Http 'GET' $url @{ 'user-agent' = $UserAgent; 'accept-language' = 'en' } $null 30
  if ($r.status -eq 429 -or $r.status -eq 403) { $script:Blocked = "Google refused this line (HTTP $($r.status))"; return @() }
  if ($r.status -ne 200) { throw "Google answered HTTP $($r.status)" }
  $text = $r.body
  if ($text -match 'unusual traffic|/sorry/index|recaptcha') { $script:Blocked = 'Google asked this line for a captcha'; return @() }
  $data = $Json.DeserializeObject($text.Substring($text.IndexOf("`n") + 1))
  $items = At $data @(0, 1)
  $rows = New-Object System.Collections.ArrayList
  if ($null -eq $items) { return @() }
  # From 0: a query that matches one place puts that place at 0; a list starts with a header, which has no name and is skipped below.
  for ($i = 0; $i -lt $items.Count; $i++) {
    $b = At $items[$i] @(14)
    if ($null -eq $b) { continue }
    $name = Text (At $b @(11))
    if (-not $name) { continue }
    $parts = At $b @(2)
    $reviews = At $b @(4, 8)
    $placeId = Text (At $b @(78))
    [void]$rows.Add([ordered]@{
      name = $name
      rating = $(if ($null -ne (At $b @(4, 7))) { [double](At $b @(4, 7)) } else { $null })
      reviews = $(if ($null -ne $reviews) { [int]$reviews } else { $null })
      category = Text (At $b @(13, 0))
      address = $(if ($parts) { ($parts | ForEach-Object { [string]$_ }) -join ', ' } else { $null })
      phone = Text (At $b @(178, 0, 0))
      website = Text (At $b @(7, 0))
      mapsUrl = $(if ($placeId) { 'https://www.google.com/maps/place/?q=place_id:' + $placeId } else { $null })
      place_id = $placeId
      latitude = At $b @(9, 2)
      longitude = At $b @(9, 3)
    })
  }
  return , $rows.ToArray()
}

# ------------------------------------------------------------------- sweep

function Squash([string]$Value) { return ($Value.ToLower() -replace '[^a-z0-9]', '') }

# The names an address must carry to be in the place: the first comma segment,
# split on "/".
function Get-AreaNames([string]$Place) {
  return @(($Place.Split(',')[0]).Split('/') | ForEach-Object { Squash $_ } | Where-Object { $_.Length -ge 3 })
}

function Test-InArea([string]$Address, $Names) {
  if (-not $Names.Count) { return $true }
  $a = Squash $Address
  foreach ($n in $Names) { if ($a.Contains($n)) { return $true } }
  return $false
}

$script:Found = [ordered]@{}
$script:InArea = 0
# Every page of one search, until a short page, the page cap, `max` in-area
# places, the deadline, or Google refusing. Returns how many places were new.
function Search-All([string]$Query, [double[]]$Centre, $Names, [int]$Max, [datetime]$Deadline) {
  $added = 0
  for ($p = 0; $p -lt $MaxPages; $p++) {
    if ($script:Blocked -or (Get-Date) -ge $Deadline -or $script:InArea -ge $Max) { break }
    Send-Beat
    $rows = $null
    foreach ($try in 1, 2) {
      try { $rows = Get-ListPage $Query $Centre[0] $Centre[1] ($p * $Page); break }
      catch { Log "  '$Query' page $p failed ($($_.Exception.Message)); $(if ($try -eq 1) { 'trying again' } else { 'skipping the rest of this search' })" }
    }
    if ($null -eq $rows) { break }
    foreach ($row in $rows) {
      $key = if ($row.place_id) { $row.place_id } else { $row.name + '|' + $row.address }
      if ($script:Found.Contains($key)) { continue }
      $script:Found[$key] = $row
      $added++
      if (Test-InArea $row.address $Names) { $script:InArea++ }
    }
    if ($rows.Count -lt $Page) { break }
    if ($PaceMs) { Start-Sleep -Milliseconds $PaceMs }
  }
  return $added
}

function Get-Median($Values) {
  $v = @($Values | Where-Object { $null -ne $_ } | ForEach-Object { [double]$_ } | Sort-Object)
  if (-not $v.Count) { return $null }
  return $v[[int][Math]::Floor($v.Count / 2)]
}

# The streets named in these addresses, most businesses first.
function Get-Streets($Businesses) {
  $counts = @{}; $names = @{}
  foreach ($b in $Businesses) {
    foreach ($part in ([string]$b.address).Split(',')) {
      $m = [regex]::Match($part, '^\s*(?:jalan|jln\.?)\s+(.+?)\s*$', 'IgnoreCase')
      if (-not $m.Success) { continue }
      $s = $m.Groups[1].Value
      if ($s.Length -gt 40 -or $s -match '[^\x20-\x7e]|\b\d{5}\b|\bjalan\b|\bjln\b') { continue }
      $street = 'Jalan ' + ($s -replace '\s+', ' ')
      $k = Squash $street
      $counts[$k] = 1 + [int]$counts[$k]; $names[$k] = $street
    }
  }
  return @($counts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { $names[$_.Key] })
}

function Invoke-Scan($Job, $Strategy) {
  $started = Get-Date
  $p = $Job.payload
  $locationOnly = $p.searchMode -eq 'location_only'
  $keyword = if ($locationOnly) { '' } else { ([string]$p.keyword).Trim() }
  $place = if ($locationOnly) { ([string]$(if ($p.originalPlace) { $p.originalPlace } elseif ($p.place) { $p.place } else { $p.keyword })).Trim() } else { ([string]$p.place).Trim() }
  if (-not $keyword -and -not $place) { throw 'gmap.scan needs a keyword or place' }
  $max = if ([int]$p.max -gt 0) { [int]$p.max } else { [int]$Strategy.defaultMax }
  $timeoutSec = [Math]::Max(120, [int]($Job.timeoutMs / 1000))
  $deadline = $started.AddSeconds([Math]::Max(60, $timeoutSec - $PostMarginSec))
  $script:Requests = 0; $script:Blocked = $null; $script:Found = [ordered]@{}; $script:InArea = 0

  $family = $null
  if ($place) {
    $fam = if ($keyword) { $Strategy.families.($keyword.ToLower()) } else { $Strategy.families.business }
    if ($fam) { $family = @($fam) }
  }
  $names = if ($family) { Get-AreaNames $place } else { @() }
  $centre = $DefaultCentre
  $swept = New-Object System.Collections.ArrayList
  $streets = $null

  if ($family) {
    $query = if ($keyword) { "$keyword in $place" } else { $place }
    $searches = 0
    foreach ($word in $family) {
      if ($script:Blocked -or (Get-Date) -ge $deadline -or $script:InArea -ge $max) { break }
      $q = "$word in $place"
      $added = Search-All $q $centre $names $max $deadline
      $searches++
      [void]$swept.Add([ordered]@{ keyword = $word; added = $added })
      # After the first search, pin the rest to the place's own centre.
      if ($searches -eq 1) {
        $here = @($script:Found.Values | Where-Object { Test-InArea $_.address $names })
        $lat = Get-Median ($here | ForEach-Object { $_.latitude })
        $lng = Get-Median ($here | ForEach-Object { $_.longitude })
        if ($null -ne $lat -and $null -ne $lng) { $centre = @($lat, $lng) }
        Log ("  map centre of {0}: {1}" -f $place, ($centre -join ','))
      }
      Log "  '$q': +$added (in $place so far: $($script:InArea), requests: $($script:Requests))"
    }
    # Business only: street by street, two searches a street.
    if (($keyword -eq '' -or $keyword.ToLower() -eq 'business') -and -not $script:Blocked -and $script:InArea -lt $max -and (Get-Date) -lt $deadline) {
      $list = Get-Streets @($script:Found.Values | Where-Object { Test-InArea $_.address $names })
      $streets = [ordered]@{ total = $list.Count; searched = 0; added = 0 }
      Log "  streets: $($list.Count)"
      foreach ($street in $list) {
        if ($script:Blocked -or (Get-Date) -ge $deadline -or $script:InArea -ge $max) { break }
        foreach ($form in $Strategy.streetForms) { $streets.added += Search-All "$form in $street, $place" $centre $names $max $deadline }
        $streets.searched++
      }
      Log "  streets searched: $($streets.searched) of $($streets.total), +$($streets.added)"
    }
  } else {
    $query = if ($place) { "$keyword in $place" } else { $keyword }
    [void](Search-All $query $centre $names $max $deadline)
  }

  $all = @($script:Found.Values)
  $kept = $all
  $outside = 0
  if ($family -and $names.Count) {
    $inside = @($all | Where-Object { Test-InArea $_.address $names })
    # Below this share the place name is not how addresses are written there: keep everything.
    if ($inside.Count -ge $all.Count * [double]$Strategy.areaMatchFloor) { $kept = $inside; $outside = $all.Count - $inside.Count }
  }
  $businesses = @($kept | Select-Object -First $max | ForEach-Object { $_.Remove('latitude'); $_.Remove('longitude'); $_ })
  if (-not $businesses.Count -and $script:Blocked) { throw "$($script:Blocked) before any business was read" }
  if ($family -and -not $businesses.Count) { throw "no businesses found for $query" }
  return [ordered]@{
    query = $query; keyword = $keyword; place = $(if ($place) { $place } else { $null })
    businesses = $businesses; found = $businesses.Count; capped = ($businesses.Count -ge $max)
    blocked = $false; blockedReason = $null; limitedView = $false
    categories = $(if ($swept.Count) { $swept.ToArray() } else { $null })
    outsideArea = $outside; streets = $streets; skippedSearches = $null; scrolls = 0
    provider = 'maps-list-local'; worker = $Name
    mapCentre = ($centre | ForEach-Object { ([double]$_).ToString($Invariant) }) -join ','
    googleRequests = $script:Requests
    stoppedEarly = $script:Blocked
    tookMs = [int]((Get-Date) - $started).TotalMilliseconds; at = (Get-Date).ToUniversalTime().ToString('o')
  }
}

# ---------------------------------------------------------------- web pages

$PyVersion = '3.12.10'
$PyDir = Join-Path $Data 'python'
$PyExe = Join-Path $PyDir 'python.exe'
# Pinned: fetch.py calls a private Scrapling helper. Changing a version here
# reinstalls on every PC's next start.
$FetchPackages = @('scrapling==0.5', 'curl_cffi==0.17.0', 'markdownify==1.2.3')
$FetchStamp = Join-Path $PyDir 'installed.txt'
$script:FetchReady = $false
$script:NextSetup = Get-Date
# The PDF reader, on its own, so a failure here leaves web pages working. Without
# its declared dependencies: fetch.py turns pymupdf4llm's layout model off, so
# pymupdf_layout, onnxruntime and networkx are left out (161 MB, not 245).
# numpy, tabulate and psutil are what it still imports.
$PdfPackages = @('pymupdf4llm==2.1', 'pymupdf==2.1', 'numpy==2.5.4', 'tabulate==0.10.0', 'psutil==7.2.2')
$PdfStamp = Join-Path $PyDir 'pdf-installed.txt'
$script:PdfReady = $false
$script:NextPdfSetup = Get-Date

# Python's embeddable build and the fetch packages, once. False if it failed;
# the worker then takes scans only and tries again in an hour.
function Install-Fetcher {
  $want = "$PyVersion " + ($FetchPackages -join ' ')
  if ((Test-Path $PyExe) -and (Test-Path $FetchStamp) -and ([IO.File]::ReadAllText($FetchStamp).Trim() -eq $want)) { return $true }
  Log 'setting up page fetching: Python and Scrapling, about 60 MB, once'
  try {
    if (-not (Test-Path $FetchStamp) -or -not ([IO.File]::ReadAllText($FetchStamp)).StartsWith("$PyVersion ")) {
      if (Test-Path $PyDir) { Remove-Item $PyDir -Recurse -Force }
      $zip = Join-Path $Data 'python.zip'
      (New-Object Net.WebClient).DownloadFile("https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip", $zip)
      Expand-Archive $zip $PyDir -Force
      Remove-Item $zip -Force
      # The embeddable build ignores site-packages, so pip too, until its ._pth file allows it.
      $pth = (Get-ChildItem $PyDir -Filter 'python*._pth' | Select-Object -First 1).FullName
      [IO.File]::WriteAllText($pth, ([IO.File]::ReadAllText($pth) -replace '(?m)^#\s*import site', 'import site'))
      $getPip = Join-Path $PyDir 'get-pip.py'
      (New-Object Net.WebClient).DownloadFile('https://bootstrap.pypa.io/get-pip.py', $getPip)
      & $PyExe $getPip --quiet --no-warn-script-location
      if ($LASTEXITCODE) { throw "get-pip exited $LASTEXITCODE" }
    }
    & $PyExe -m pip install --quiet --disable-pip-version-check --no-warn-script-location @FetchPackages
    if ($LASTEXITCODE) { throw "pip exited $LASTEXITCODE" }
    & $PyExe -I -c 'import curl_cffi, markdownify, scrapling.parser, scrapling.core.shell'
    if ($LASTEXITCODE) { throw 'the packages installed but do not load' }
    [IO.File]::WriteAllText($FetchStamp, $want)
    Log 'page fetching is ready'
    return $true
  } catch {
    Log "page fetching is off for now: setup failed ($($_.Exception.Message)). Trying again in an hour."
    return $false
  }
}

# pymupdf4llm into the same Python, once page fetching works. Until then a PDF
# job fails with "still being set up".
function Install-PdfReader {
  $want = $PdfPackages -join ' '
  if ((Test-Path $PdfStamp) -and ([IO.File]::ReadAllText($PdfStamp).Trim() -eq $want)) { return $true }
  Log 'setting up PDF reading: PyMuPDF, about 160 MB, once'
  try {
    & $PyExe -m pip install --quiet --disable-pip-version-check --no-warn-script-location --no-deps @PdfPackages
    if ($LASTEXITCODE) { throw "pip exited $LASTEXITCODE" }
    & $PyExe -I -c 'import pymupdf, pymupdf4llm'
    if ($LASTEXITCODE) { throw 'the packages installed but do not load' }
    [IO.File]::WriteAllText($PdfStamp, $want)
    Log 'PDF reading is ready'
    return $true
  } catch {
    Log "PDF reading is off for now: setup failed ($($_.Exception.Message)). Trying again in an hour."
    return $false
  }
}

# LinkedIn scraping was removed: LinkedIn blocked it too often. On every start,
# delete what it left on this PC, if anything: the login cookies, the old venv
# and stamps, the scraper in this worker's own Python, and the old scripts.
# Playwright's own uninstall drops only browsers no other Playwright here uses.
function Remove-LinkedInLeftovers {
  $stamp = Join-Path $Data 'linkedin-installed.txt'
  $found = @(Get-ChildItem -LiteralPath $Data -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'linkedin*' })
  $old = @(@('linkedin_job.py', 'linkedin_login.py', 'linkedin_signin.ps1') | ForEach-Object { Join-Path $PSScriptRoot $_ })
  $old += Join-Path (Split-Path $PSScriptRoot -Parent) 'LinkedIn sign in.cmd'
  $old = @($old | Where-Object { Test-Path -LiteralPath $_ })
  if (-not $found.Count -and -not $old.Count) { return }
  Log 'LinkedIn scraping was removed: deleting its login session, browser and packages from this PC'
  if ((Test-Path -LiteralPath $stamp) -and (Test-Path -LiteralPath $PyExe) -and [IO.File]::ReadAllText($stamp).Trim().StartsWith($PyExe + ' ')) {
    & $PyExe -m playwright uninstall | Out-Null
    & $PyExe -m pip uninstall --yes --quiet --disable-pip-version-check linkedin-scraper playwright | Out-Null
  }
  foreach ($item in $found) {
    try { Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop }
    catch { Log "  could not delete $($item.Name): $($_.Exception.Message)" }
  }
  foreach ($file in $old) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
}

# One web.fetch job, by fetch.py in its own process; it gets the payload in a
# file and prints one JSON line.
function Invoke-Fetch($Job) {
  $p = $Job.payload
  $file = Join-Path $Data "fetch-$($Job.id).json"
  $spec = @{ url = $p.url; format = $p.format; mainContent = ($p.mainContent -ne $false); timeoutMs = [int]$Job.timeoutMs }
  # Opt-in fields: an error page kept as an answer, and the response headers with the redirect hops.
  if ($p.keepErrors -eq $true) { $spec.keepErrors = $true }
  if ($p.headers -eq $true) { $spec.headers = $true }
  [IO.File]::WriteAllText($file, ($spec | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo $PyExe
    $psi.Arguments = '-I "' + (Join-Path $PSScriptRoot 'fetch.py') + '" "' + $file + '"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $proc = [Diagnostics.Process]::Start($psi)
    # Both streams at once: a full stderr pipe would stall the child.
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit([int]$Job.timeoutMs + 10000)) {
      try { $proc.Kill() } catch { }
      throw "the page took longer than $([int]($Job.timeoutMs / 1000)) s"
    }
    $proc.WaitForExit()
    # The answer is the last line: a library that prints to stdout must not break it.
    $line = @($out.Result.Trim() -split "`r?`n")[-1]
    if (-not $line) { throw "fetch.py answered nothing: $($err.Result.Trim())" }
    $r = $line | ConvertFrom-Json
    if (-not $r.ok) { throw [string]$r.error }
    $r.result | Add-Member worker $Name
    return $r.result
  } finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
}

# One site.audit job, by audit.py (with fetch.py's reader) in its own process.
function Invoke-Audit($Job) {
  $p = $Job.payload
  $file = Join-Path $Data "audit-$($Job.id).json"
  $spec = @{ url = $p.url; maxPages = $p.maxPages; botTest = ($p.botTest -ne $false); timeoutMs = [int]$Job.timeoutMs }
  [IO.File]::WriteAllText($file, ($spec | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo $PyExe
    $psi.Arguments = '-I "' + (Join-Path $PSScriptRoot 'audit.py') + '" "' + $file + '"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $proc = [Diagnostics.Process]::Start($psi)
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit([int]$Job.timeoutMs + 10000)) {
      try { $proc.Kill() } catch { }
      throw "the audit took longer than $([int]($Job.timeoutMs / 1000)) s"
    }
    $proc.WaitForExit()
    $line = @($out.Result.Trim() -split "`r?`n")[-1]
    if (-not $line) { throw "audit.py answered nothing: $($err.Result.Trim())" }
    $r = $line | ConvertFrom-Json
    if (-not $r.ok) { throw [string]$r.error }
    $r.result | Add-Member worker $Name
    return $r.result
  } finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
}

# --------------------------------------------------------------- screenshots

# The browser web.shot drives: SHOT_BROWSER, else the Edge Windows installs.
function Find-ShotBrowser {
  if (-not $ShotOn) { return $null }
  $candidates = @(
    $ShotBrowser
    (Join-Path ([string]${env:ProgramFiles(x86)}) 'Microsoft\Edge\Application\msedge.exe')
    (Join-Path ([string]$env:ProgramFiles) 'Microsoft\Edge\Application\msedge.exe')
    (Join-Path ([string]$env:LOCALAPPDATA) 'Microsoft\Edge\Application\msedge.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return $c } }
  return $null
}

# One web.shot job, by shot.mjs on the portable Node, with the payload in a file.
function Invoke-Shot($Job) {
  $p = $Job.payload
  $file = Join-Path $Data "shot-$($Job.id).json"
  $spec = @{ url = $p.url; device = $p.device; find = $p.find; waitMs = $p.waitMs; quality = $p.quality; timeoutMs = [int]$Job.timeoutMs; browser = $script:ShotExe }
  [IO.File]::WriteAllText($file, ($spec | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  $proc = $null
  try {
    $nodeCmd = if ($NodeExe -and (Test-Path -LiteralPath $NodeExe)) { $NodeExe } else { 'node' }
    $psi = New-Object Diagnostics.ProcessStartInfo $nodeCmd
    $psi.Arguments = (@((Join-Path $PSScriptRoot 'shot.mjs'), $file) | ForEach-Object { Quote-NodeArgument $_ }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $proc = [Diagnostics.Process]::Start($psi)
    # Both streams at once: a full stderr pipe would stall the child.
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit([int]$Job.timeoutMs + 10000)) {
      try { $proc.Kill() } catch { }
      throw "the screenshot took longer than $([int]($Job.timeoutMs / 1000)) s"
    }
    $proc.WaitForExit()
    # The answer is the last line.
    $line = @($out.Result.Trim() -split "`r?`n")[-1]
    if (-not $line) { throw "shot.mjs answered nothing: $($err.Result.Trim())" }
    $r = $line | ConvertFrom-Json
    if (-not $r.ok) { throw [string]$r.error }
    $r.result | Add-Member worker $Name
    return $r.result
  } finally {
    if ($proc) { $proc.Dispose() }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  }
}

# -------------------------------------------------------------- site lookup

# Pinned from nodejs.org/dist/index.json and this release's SHASUMS256.txt.
$NodeVersion = 'v24.22.2'
$NodeSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
$NodeDir = Join-Path $Data 'node'
$NodeExe = Join-Path $NodeDir 'node.exe'
$NodeStamp = Join-Path $NodeDir 'installed.txt'
$LookupRunner = Join-Path $PSScriptRoot 'run-handler.mjs'
$script:NodeReady = $false
$script:NextNodeSetup = Get-Date
$script:NodeSetup = $null

# Portable Node, once. Failure only disables lookup; retry in an hour.
function Install-Node {
  $zip = Join-Path $Data 'node.zip'
  $archive = $null
  try {
    if ((Test-Path -LiteralPath $NodeExe) -and (Test-Path -LiteralPath $NodeStamp) -and ([IO.File]::ReadAllText($NodeStamp).Trim() -eq $NodeVersion)) { return $true }
    Log "setting up site lookup: portable Node $NodeVersion, once"
    New-Item -ItemType Directory -Force $NodeDir | Out-Null
    $client = New-Object Net.WebClient
    try { $client.DownloadFile("https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip", $zip) }
    finally { $client.Dispose() }
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $NodeSha256) { throw 'Node download SHA256 mismatch' }
    # Only the runtime is needed; do not install npm or change the PC's PATH.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    $entry = $archive.GetEntry("node-$NodeVersion-win-x64/node.exe")
    if (-not $entry) { throw 'Node archive has no runtime' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $NodeExe, $true)
    $actual = & $NodeExe --version
    if ($LASTEXITCODE -or $actual -ne $NodeVersion) { throw 'Node runtime version check failed' }
    [IO.File]::WriteAllText($NodeStamp, $NodeVersion)
    Log 'site lookup is ready'
    return $true
  } catch {
    Log "site lookup is off for now: setup failed ($($_.Exception.Message)). Trying again in an hour."
    return $false
  } finally {
    if ($archive) { $archive.Dispose() }
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  }
}

# Setup runs in the background so downloads never hold up other job types.
function Update-NodeSetup {
  if ($script:NodeSetup -and $script:NodeSetup.State -in 'Completed', 'Failed', 'Stopped') {
    $answer = @(Receive-Job $script:NodeSetup -ErrorAction SilentlyContinue)
    $script:NodeReady = $script:NodeSetup.State -eq 'Completed' -and $answer.Count -gt 0 -and $answer[-1] -eq $true
    Remove-Job $script:NodeSetup -Force
    $script:NodeSetup = $null
    $script:NextNodeSetup = (Get-Date).AddHours(1)
  }
  if (-not $script:NodeReady -and -not $script:NodeSetup -and (Get-Date) -ge $script:NextNodeSetup) {
    $script:NextNodeSetup = (Get-Date).AddHours(1)
    try {
      $settings = @{ Data = $Data; LogFile = $LogFile; NodeVersion = $NodeVersion; NodeSha256 = $NodeSha256; NodeDir = $NodeDir; NodeExe = $NodeExe; NodeStamp = $NodeStamp }
      $script:NodeSetup = Start-Job -ArgumentList $settings, ${function:Install-Node}.ToString(), ${function:Log}.ToString() -ScriptBlock {
        param($settings, $install, $logger)
        $ErrorActionPreference = 'Stop'
        $ProgressPreference = 'SilentlyContinue'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        foreach ($key in $settings.Keys) { Set-Variable -Name $key -Value $settings[$key] }
        Set-Item Function:Log ([scriptblock]::Create($logger))
        Set-Item Function:Install-Node ([scriptblock]::Create($install))
        Install-Node
      }
    } catch { Log "site lookup setup could not start: $($_.Exception.Message). Trying again in an hour." }
  }
}

# Windows argv quoting: preserve embedded quotes and trailing backslashes.
function Quote-NodeArgument([string]$Value) {
  return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

# One site.lookup job. The handler's return value is passed through unchanged.
function Invoke-Lookup($Job) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $p = $Job.payload
  $file = Join-Path $Data ('lookup-' + [guid]::NewGuid().ToString('N') + '.mjs')
  $proc = $null
  try {
    [IO.File]::WriteAllText($file, [string]$p.source, (New-Object Text.UTF8Encoding $false))
    $psi = New-Object Diagnostics.ProcessStartInfo $NodeExe
    # --use-system-ca: the empty environment below has no NODE_USE_SYSTEM_CA, and some
    # government sites chain to CAs only the Windows store has.
    $args_ = @('--permission', '--use-system-ca', "--allow-fs-read=$file", "--allow-fs-read=$LookupRunner", $LookupRunner, $file, [string]$p.keyword)
    $psi.Arguments = ($args_ | ForEach-Object { Quote-NodeArgument $_ }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    # Held open, never written: the runner exits when this worker dies and it closes.
    $psi.RedirectStandardInput = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    # Do not pass worker credentials or inherited NODE_OPTIONS to a handler.
    $psi.EnvironmentVariables.Clear()
    $psi.EnvironmentVariables['SystemRoot'] = $env:SystemRoot
    $proc = [Diagnostics.Process]::Start($psi)
    # Both streams at once: a full stderr pipe would stall the child.
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit([int]$Job.timeoutMs)) {
      try { $proc.Kill(); $proc.WaitForExit() } catch { }
      throw "timed out after $([int]$Job.timeoutMs) ms"
    }
    $proc.WaitForExit()
    # The answer is the last line: a handler that prints must not break it.
    $line = @($out.Result.Trim() -split "`r?`n")[-1]
    if (-not $line) { throw 'handler printed nothing' }
    try { $r = $line | ConvertFrom-Json } catch { throw 'handler runner returned invalid JSON' }
    if ($r.ok -eq $false) { throw "handler threw: $($r.error)" }
    if ($r.ok -ne $true) { throw 'handler runner returned an invalid answer' }
    return [ordered]@{
      handler = $p.handler; version = $p.version; worker = $Name
      tookMs = [long]$watch.ElapsedMilliseconds; meta = $r.meta; result = $r.result
    }
  } finally {
    if ($proc) {
      if (-not $proc.HasExited) { try { $proc.Kill(); $proc.WaitForExit() } catch { } }
      $proc.Dispose()
    }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

# ----------------------------------------------------------------- chat bridge

$script:ChatBridge = $null

# Starts the local ChatGPT bridge server on port 8765 if not already running.
function Start-ChatBridge {
  if ($script:ChatBridge -and -not $script:ChatBridge.HasExited) { return }
  $bridgeScript = Join-Path $PSScriptRoot 'chat_bridge.mjs'
  if (-not (Test-Path -LiteralPath $bridgeScript) -or -not $script:NodeReady) { return }
  try {
    $nodeCmd = if ($NodeExe -and (Test-Path -LiteralPath $NodeExe)) { $NodeExe } else { 'node' }
    $psi = New-Object Diagnostics.ProcessStartInfo $nodeCmd
    $psi.Arguments = (Quote-NodeArgument $bridgeScript)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $script:ChatBridge = [Diagnostics.Process]::Start($psi)
  } catch { }
}

# True when a ChatGPT browser is connected. Without one, this PC must not take chat.ask:
# a job taken with no tab fails at once and the question waits out its timeout.
function Test-ChatTab {
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
    return [bool]$h.ready
  } catch { return $false }
}

# Names of browser connections, or null when the bridge cannot report them.
function Get-ChatBrowsers {
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
    if ($null -eq $h.browsers) { return $null }
    return ,@($h.browsers | Where-Object { $_.ready } | ForEach-Object { [string]$_.name })
  } catch { return $null }
}

# One chat.ask job, by chat.mjs on the portable Node, with the payload in a file.
function Invoke-Chat($Job) {
  $p = $Job.payload
  $file = Join-Path $Data "chat-$($Job.id).json"
  $spec = @{ id = $Job.id; prompt = $p.prompt; timeoutMs = [int]$Job.timeoutMs }
  [IO.File]::WriteAllText($file, ($spec | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  $proc = $null
  try {
    $nodeCmd = if ($NodeExe -and (Test-Path -LiteralPath $NodeExe)) { $NodeExe } else { 'node' }
    $psi = New-Object Diagnostics.ProcessStartInfo $nodeCmd
    $psi.Arguments = (@((Join-Path $PSScriptRoot 'chat.mjs'), $file) | ForEach-Object { Quote-NodeArgument $_ }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $proc = [Diagnostics.Process]::Start($psi)
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    $deadline = (Get-Date).AddMilliseconds([int]$Job.timeoutMs + 10000)
    while (-not $proc.WaitForExit(1000)) {
      Send-Beat
      if ((Get-Date) -ge $deadline) {
        try { $proc.Kill() } catch { }
        throw "chat took longer than $([int]($Job.timeoutMs / 1000)) s"
      }
    }
    $proc.WaitForExit()
    $line = @($out.Result.Trim() -split "`r?`n")[-1]
    if (-not $line) { throw "chat.mjs answered nothing: $($err.Result.Trim())" }
    $r = $line | ConvertFrom-Json
    if (-not $r.ok) { throw [string]$r.error }
    $r.result | Add-Member worker $Name
    return $r.result
  } finally {
    if ($proc) { $proc.Dispose() }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  }
}

# One ads.research job, by ads.mjs on the portable Node, with the payload in a file.
# Google's Ads Transparency Center needs only Node; Meta's Ad Library also needs the
# browser web.shot uses, and without one the job still returns Google's side, labelled.
function Invoke-Ads($Job) {
  $p = $Job.payload
  $file = Join-Path $Data "ads-$($Job.id).json"
  $spec = @{ country = $p.country; countryName = $p.countryName; industry = $p.industry; terms = @($p.terms); googleQueries = @($p.googleQueries); googleRegion = $p.googleRegion; maxMetaAds = $p.maxMetaAds; maxMetaTerms = $p.maxMetaTerms; maxGoogleAdvertisers = $p.maxGoogleAdvertisers; maxGoogleDomains = $p.maxGoogleDomains; activeOnly = $p.activeOnly; timeoutMs = [int]$Job.timeoutMs; browser = $script:ShotExe }
  [IO.File]::WriteAllText($file, ($spec | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  $proc = $null
  try {
    $nodeCmd = if ($NodeExe -and (Test-Path -LiteralPath $NodeExe)) { $NodeExe } else { 'node' }
    $psi = New-Object Diagnostics.ProcessStartInfo $nodeCmd
    $psi.Arguments = (@((Join-Path $PSScriptRoot 'ads.mjs'), $file) | ForEach-Object { Quote-NodeArgument $_ }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $proc = [Diagnostics.Process]::Start($psi)
    # Both streams at once: a full stderr pipe would stall the child.
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit([int]$Job.timeoutMs + 10000)) {
      # The whole tree: Kill() ends node only and would leave its headless browser running.
      try { & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null } catch { }
      try { $proc.Kill() } catch { }
      throw "the ads research took longer than $([int]($Job.timeoutMs / 1000)) s"
    }
    $proc.WaitForExit()
    # The answer is the last line.
    $line = @($out.Result.Trim() -split "`r?`n")[-1]
    if (-not $line) { throw "ads.mjs answered nothing: $($err.Result.Trim())" }
    $r = $line | ConvertFrom-Json
    if (-not $r.ok) { throw [string]$r.error }
    $r.result | Add-Member worker $Name
    return $r.result
  } finally {
    if ($proc) { $proc.Dispose() }
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  }
}

# ------------------------------------------------------------------ results

# Post a result, retrying the service for a few minutes. If it never takes it,
# keep a copy on disk rather than lose the scan. The job's payload rides along:
# when a service restart has lost the job, the service files the scan again
# under the same id, so the caller polling it still gets it.
function Send-Result([string]$Id, $Payload, [bool]$Ok, $Result, [string]$ErrorText, [int]$RetryAfterMs = 0, [string]$Type = 'gmap.scan') {
  $body = @{ worker = $Name; type = $Type; ok = $Ok; result = $Result; error = $(if ($ErrorText) { $ErrorText } else { $null }); payload = $Payload }
  # Tells the service to stop handing this worker jobs while Google rests it.
  if ($RetryAfterMs) { $body.retryAfterMs = $RetryAfterMs }
  foreach ($wait in 0, 10, 30, 60, 120) {
    Start-Sleep -Seconds $wait
    try {
      $r = Invoke-Hub 'POST' "/api/jobs/$Id/result" $body 120
      if ($r.status -eq 200) { return }
      # The service has already settled this job (cancelled, or finished elsewhere): a copy would never be taken.
      if ($r.status -eq 409) { Log "  job $Id is already settled by the service; not kept"; return }
      Log "  the service answered HTTP $($r.status) to the result: $($r.body)"
      if ($r.status -in 400, 403, 404, 409) { break }
    } catch { Log "  could not post the result: $($_.Exception.Message)" }
  }
  $dir = Join-Path $Data 'unsaved'
  New-Item -ItemType Directory -Force $dir | Out-Null
  [IO.File]::WriteAllText((Join-Path $dir "$Id.json"), ($body | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding $false))
  Log "  result kept at $dir\$Id.json"
}

# Offer the service every kept scan, once per start: one kept while the service
# was down is saved when it is back. A scan the service takes moves to
# unsaved\sent; one it refuses stays, with the reason in the log.
$script:Offered = @{}
function Send-Unsaved {
  $dir = Join-Path $Data 'unsaved'
  if (-not (Test-Path $dir)) { return }
  foreach ($file in Get-ChildItem $dir -Filter '*.json' -File) {
    if ($script:Offered.ContainsKey($file.Name)) { continue }
    $script:Offered[$file.Name] = $true
    try {
      $text = [IO.File]::ReadAllText($file.FullName)
      $bytes = [Text.Encoding]::UTF8.GetBytes($text)
      $r = Invoke-Http 'POST' "$Lab/api/jobs/$($file.BaseName)/result" @{ authorization = 'Bearer ' + $Key } $bytes 120
      if ($r.status -eq 200) {
        $sent = Join-Path $dir 'sent'
        New-Item -ItemType Directory -Force $sent | Out-Null
        Move-Item $file.FullName (Join-Path $sent $file.Name) -Force
        Log "kept result $($file.BaseName) saved by the service"
      } else { Log "kept result $($file.BaseName): the service answered HTTP $($r.status): $($r.body)" }
    } catch { Log "kept result $($file.BaseName) not sent: $($_.Exception.Message)" }
  }
}

# --------------------------------------------------------------------- main

Log "Local Gmap Worker '$Name' -> $Lab (Google Maps list pages, $PaceMs ms apart; web pages $(if ($FetchOn) { 'on' } else { 'off' }))"
Remove-LinkedInLeftovers
$script:ShotExe = Find-ShotBrowser
if ($script:ShotExe) { Log "screenshots: $($script:ShotExe)" } elseif ($ShotOn) { Log 'screenshots are off: no Microsoft Edge on this PC (SHOT_BROWSER in worker.env names another browser)' }
$backoff = 5
# While Google rests this line, keep taking the other ready job types.
$restUntil = Get-Date
while ($true) {
  try {
    Send-Unsaved
    Update-NodeSetup
    if ($FetchOn -and -not $script:FetchReady -and (Get-Date) -ge $script:NextSetup) {
      $script:FetchReady = Install-Fetcher
      $script:NextSetup = (Get-Date).AddHours(1)
    }
    if ($script:FetchReady -and -not $script:PdfReady -and (Get-Date) -ge $script:NextPdfSetup) {
      $script:PdfReady = Install-PdfReader
      $script:NextPdfSetup = (Get-Date).AddHours(1)
    }
    Start-ChatBridge
    $resting = (Get-Date) -lt $restUntil
    # Emit only ready types; empty subexpressions in an array stop PS 5.1's pipeline early.
    $script:Types = (@(
      if (-not $resting) { 'gmap.scan' }
      if ($script:FetchReady) { 'web.fetch' }
      if ($script:FetchReady) { 'site.audit' }
      if ($script:NodeReady) { 'site.lookup' }
      if ($script:NodeReady -and $script:ShotExe) { 'web.shot' }
      if ($script:NodeReady -and (Test-ChatTab)) { 'chat.ask' }
      if ($script:NodeReady) { 'ads.research' }
    )) -join ','
    if (-not $script:Types) { Start-Sleep -Seconds ([Math]::Min(25, [Math]::Max(1, [int]($restUntil - (Get-Date)).TotalSeconds))); continue }
    $chatBrowsers = Get-ChatBrowsers
    $chatQuery = '&chatReady=' + $(if ($script:Types.Split(',') -contains 'chat.ask') { '1' } else { '0' }) + '&chatBrowsers=' + [uri]::EscapeDataString((ConvertTo-Json -InputObject $chatBrowsers -Compress))
    $r = Invoke-Hub 'GET' ("/api/jobs/next?worker=$([uri]::EscapeDataString($Name))&types=$($script:Types)&wait=25$chatQuery") $null 45
    if ($r.status -eq 204) { $backoff = 5; continue }
    if ($r.status -eq 401 -or $r.status -eq 403) {
      Log "the service refused this worker's key (HTTP $($r.status)). Its API_KEY was probably rotated; download the package again (GET /api/worker/package). Retrying in 10 minutes."
      Start-Sleep -Seconds 600; continue
    }
    if ($r.status -ne 200) { throw "the service answered HTTP $($r.status): $($r.body)" }
    $backoff = 5
    $job = ($r.body | ConvertFrom-Json).job
    $script:JobId = $job.id
    $script:LastBeat = (Get-Date).AddSeconds(-60)
    if ($job.type -eq 'site.lookup') {
      Log "job $($job.id): lookup $($job.payload.handler)"
      $payload = @{}
      foreach ($property in $job.payload.PSObject.Properties) {
        if ($property.Name -ne 'source') { $payload[$property.Name] = $property.Value }
      }
      try {
        $result = Invoke-Lookup $job
        Log "job $($job.id): lookup finished in $($result.tookMs) ms"
        Send-Result $job.id $payload $true $result '' 0 'site.lookup'
      } catch {
        Log "job $($job.id) failed: $($_.Exception.Message)"
        Send-Result $job.id $payload $false $null ([string]$_.Exception.Message) 0 'site.lookup'
      } finally { $script:JobId = $null }
      continue
    }
    if ($job.type -eq 'site.audit') {
      Log "job $($job.id): audit $($job.payload.url)"
      try {
        $result = Invoke-Audit $job
        Log "job $($job.id): SEO $($result.scores.seo), GEO $($result.scores.geo), $(@($result.pages).Count) pages in $($result.tookMs) ms"
        Send-Result $job.id $job.payload $true $result '' 0 'site.audit'
      } catch {
        Log "job $($job.id) failed: $($_.Exception.Message)"
        Send-Result $job.id $job.payload $false $null ([string]$_.Exception.Message) 0 'site.audit'
      } finally { $script:JobId = $null }
      continue
    }
    if ($job.type -eq 'web.shot') {
      Log "job $($job.id): shot $($job.payload.url) ($($job.payload.device))"
      try {
        $result = Invoke-Shot $job
        Log "job $($job.id): HTTP $($result.status), $(if ($result.blocked) { 'a bot check, no image' } else { "found $($result.found)" }) in $($result.tookMs) ms"
        Send-Result $job.id $job.payload $true $result '' 0 'web.shot'
      } catch {
        Log "job $($job.id) failed: $($_.Exception.Message)"
        Send-Result $job.id $job.payload $false $null ([string]$_.Exception.Message) 0 'web.shot'
      } finally { $script:JobId = $null }
      continue
    }
    if ($job.type -eq 'web.fetch') {
      Log "job $($job.id): fetch $($job.payload.url)"
      try {
        $result = Invoke-Fetch $job
        Log "job $($job.id): HTTP $($result.status), $($result.length) characters of $($result.format) in $($result.tookMs) ms"
        Send-Result $job.id $job.payload $true $result '' 0 'web.fetch'
      } catch {
        Log "job $($job.id) failed: $($_.Exception.Message)"
        Send-Result $job.id $job.payload $false $null ([string]$_.Exception.Message) 0 'web.fetch'
      } finally { $script:JobId = $null }
      continue
    }
    if ($job.type -eq 'chat.ask') {
      Log "job $($job.id): chat $($job.payload.prompt)"
      try {
        $result = Invoke-Chat $job
        Log "job $($job.id): chat finished in $($result.tookMs) ms"
        Send-Result $job.id $job.payload $true $result '' 0 'chat.ask'
      } catch {
        Log "job $($job.id) failed: $($_.Exception.Message)"
        Send-Result $job.id $job.payload $false $null ([string]$_.Exception.Message) 0 'chat.ask'
      } finally { $script:JobId = $null }
      continue
    }
    if ($job.type -eq 'ads.research') {
      Log "job $($job.id): ads $($job.payload.industry) in $($job.payload.country)"
      Stay-Awake $true
      try {
        $result = Invoke-Ads $job
        Log "job $($job.id): ads $($result.summary.advertisers) advertisers (Google $($result.summary.googleAdvertisers), Meta $($result.summary.metaAdvertisers)) in $([Math]::Round($result.tookMs / 1000)) s"
        Send-Result $job.id $job.payload $true $result '' 0 'ads.research'
      } catch {
        Log "job $($job.id) failed: $($_.Exception.Message)"
        Send-Result $job.id $job.payload $false $null ([string]$_.Exception.Message) 0 'ads.research'
      } finally {
        Stay-Awake $false
        $script:JobId = $null
      }
      continue
    }
    Log "job $($job.id): $($job.payload.keyword) in $($job.payload.place) (max $($job.payload.max))"
    Stay-Awake $true
    $rest = 0
    try {
      $sr = Invoke-Hub 'GET' '/api/worker/strategy'
      if ($sr.status -ne 200) { throw "the service gave no sweep strategy (HTTP $($sr.status))" }
      $result = Invoke-Scan $job ($sr.body | ConvertFrom-Json)
      if ($result.stoppedEarly) { $rest = $BlockedRestSec; Log "  stopped early: $($result.stoppedEarly)" }
      Log "job $($job.id): $($result.found) businesses from $($result.googleRequests) Google requests in $([Math]::Round($result.tookMs / 60000, 1)) min"
      Send-Result $job.id $job.payload $true $result '' ($rest * 1000)
    } catch {
      if ($script:Blocked) { $rest = $BlockedRestSec }
      Log "job $($job.id) failed: $($_.Exception.Message)"
      Send-Result $job.id $job.payload $false $null ([string]$_.Exception.Message) ($rest * 1000)
    } finally {
      Stay-Awake $false
      $script:JobId = $null
    }
    if ($rest) {
      Log "no Maps jobs for $([Math]::Round($rest / 60)) min: Google refused this line$(if ($script:FetchReady) { '. Still taking web pages.' })"
      $restUntil = (Get-Date).AddSeconds($rest)
    }
  } catch {
    Log "service unreachable or error: $($_.Exception.Message). Retrying in $backoff s."
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min(60, $backoff * 2)
  }
}
