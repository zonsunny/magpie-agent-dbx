# One-line installer for Windows:
#   powershell -c "irm https://raw.githubusercontent.com/zonsunny/magpie-agent-dbx/main/install.ps1 | iex"
$ErrorActionPreference = 'Stop'
$Repo = 'github:zonsunny/magpie-agent-dbx'

$magpie = Get-Command magpie -ErrorAction SilentlyContinue
if (-not $magpie) {
  Write-Error "magpie not found on PATH. Install Magpie first, then run: magpie plugin add $Repo"
  exit 1
}

Write-Host "Installing $Repo ..."
& $magpie.Source plugin add $Repo
Write-Host 'Done. Open Magpie Agents page (or run `magpie ls`) and pick a model for DBX.'
