# Every export from this PC's Dota 2 install, one after another, uploading to Hugging Face:
#   update  - what the game changed since the last export (the state files say what is done)
#   all     - everything again, as on the first run (after the datasets were lost)
# Started by "Update.cmd" or "Restore everything.cmd" next to it; or:
#   powershell -ExecutionPolicy Bypass -File export-local.ps1 -Mode all [-Game "<...>/dota 2 beta/game/dota"]
param(
  [ValidateSet("update", "all")] [string]$Mode = "update",
  [string]$Game = ""
)
$ErrorActionPreference = "Continue"
Set-Location -LiteralPath $PSScriptRoot

# The game: given, else found through Steam (its libraries, the one holding Dota 2, app 570)
function Find-Dota {
  $roots = @()
  foreach ($key in "HKCU:\Software\Valve\Steam", "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam") {
    try {
      $item = Get-ItemProperty -Path $key -ErrorAction Stop
      if ($item.SteamPath) { $roots += $item.SteamPath }
      if ($item.InstallPath) { $roots += $item.InstallPath }
    } catch {}
  }
  foreach ($root in $roots | Select-Object -Unique) {
    $vdf = Join-Path $root "steamapps\libraryfolders.vdf"
    if (-not (Test-Path -LiteralPath $vdf)) { continue }
    foreach ($match in [regex]::Matches((Get-Content -Raw -LiteralPath $vdf), '"path"\s+"([^"]+)"')) {
      # A library on a drive that is not there is skipped quietly
      $candidate = ($match.Groups[1].Value -replace '\\\\', '\') + "\steamapps\common\dota 2 beta\game\dota"
      if (Test-Path -LiteralPath ($candidate + "\pak01_dir.vpk") -ErrorAction SilentlyContinue) { return $candidate }
    }
  }
  return $null
}
if (-not $Game) { $Game = Find-Dota }
if (-not $Game -or -not (Test-Path -LiteralPath (Join-Path $Game "pak01_dir.vpk"))) {
  $Game = Read-Host "Dota 2 not found. Path to ...\dota 2 beta\game\dota"
}
$Game = $Game -replace '\\', '/'

# The Hugging Face token: temp\hf_token.txt (not in git), the environment, or asked for
if (-not $env:HF_TOKEN) {
  $tokenFile = Join-Path $PSScriptRoot "temp\hf_token.txt"
  if (Test-Path -LiteralPath $tokenFile) {
    $env:HF_TOKEN = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
  } else {
    $env:HF_TOKEN = Read-Host "Hugging Face token (write access)"
  }
}

# Converter and packages
if (-not (Test-Path -LiteralPath "vrf\Source2Viewer-CLI.exe")) {
  Write-Host "Source2Viewer-CLI.exe is missing in vrf\ (the release the workflow names, win-x64)" -ForegroundColor Red
  exit 1
}
if (-not (Test-Path -LiteralPath "node_modules")) { npm ci }

$force = @()
if ($Mode -eq "all") { $force = @("--force") }
Write-Host "Dota 2: $Game" -ForegroundColor Cyan
Write-Host "Mode: $Mode" -ForegroundColor Cyan

# In this order: the models (with their dynamic parameters, cube maps and cloth), the game data,
# the game's scripts and texts, the sounds, the particles (which list more models), the voice lines and sound lists (which
# need the sounds uploaded), the scenes, then the models the particles listed
$steps = @(
  @{ Name = "Models"; Args = @("index.js", "--game", $Game) + $force },
  @{ Name = "Game data"; Args = @("data.js", "--game", $Game) + $force },
  @{ Name = "Scripts and texts"; Args = @("gamefiles.js", "--game", $Game) + $force },
  @{ Name = "Pictures"; Args = @("images.js", "--game", $Game) + $force },
  @{ Name = "Videos"; Args = @("videos.js", "--game", $Game) + $force },
  @{ Name = "Sounds"; Args = @("sounds.js", "--game", $Game) + $force },
  @{ Name = "Particles"; Args = @("particles.js", "--game", $Game) + $force },
  @{ Name = "Voice lines and sound lists"; Args = @("audio.js", "--game", $Game) + $force },
  @{ Name = "Scenes"; Args = @("scenes.js", "--game", $Game) + $force },
  @{ Name = "Models the particles draw"; Args = @("index.js", "--game", $Game) },
  @{ Name = "Names of the files"; Args = @("names.js", "--game", $Game) + $force },
  @{ Name = "Lists of the datasets' files"; Args = @("files-list.js") }
)
$results = @()
$started = Get-Date
foreach ($step in $steps) {
  Write-Host ""
  Write-Host "=== $($step.Name) ===" -ForegroundColor Cyan
  $stepStart = Get-Date
  & node @($step.Args)
  $code = $LASTEXITCODE
  $minutes = [math]::Round(((Get-Date) - $stepStart).TotalMinutes, 1)
  $results += [pscustomobject]@{ Step = $step.Name; Result = $(if ($code -eq 0) { "ok" } else { "FAILED ($code)" }); Minutes = $minutes }
}

# The state files say what is uploaded; kept in git (pushed when you choose)
$stateFiles = @("state.json", "data-state.json", "gamefiles-state.json", "images-state.json", "videos-state.json", "sounds-state.json", "audio-state.json", "scenes-state.json", "particles-state.json", "particle-models.json", "files-state.json", "names-state.json") | Where-Object { Test-Path -LiteralPath $_ }
git add -- $stateFiles
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -q -m "Local export ($Mode)"
  Write-Host "State files committed (not pushed)" -ForegroundColor Cyan
}

Write-Host ""
$results | Format-Table -AutoSize
Write-Host ("Done in {0} min" -f [math]::Round(((Get-Date) - $started).TotalMinutes)) -ForegroundColor Cyan
