# ─────────────────────────────────────────────────────────────────────────────
# Google Slides Hybrid MCP — One-Line Setup Script (Windows PowerShell)
# ─────────────────────────────────────────────────────────────────────────────
#
# Usage:
#   irm https://raw.githubusercontent.com/<owner>/google-slides-hybrid-mcp/main/scripts/setup.ps1 | iex
#
# Or locally:
#   .\scripts\setup.ps1
#
# This script:
#   1. Checks that Node.js >= 18 is installed
#   2. Verifies or sets up the project directory
#   3. Installs dependencies
#   4. Runs the interactive setup wizard
#   5. Prints next steps
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host $Message -ForegroundColor Magenta -NoNewline
    Write-Host ""
    Write-Host ("-" * 50) -ForegroundColor DarkGray
}

function Write-Pass {
    param([string]$Message)
    Write-Host "  " -NoNewline
    Write-Host "[PASS]" -ForegroundColor Green -NoNewline
    Write-Host " $Message"
}

function Write-Fail {
    param([string]$Message)
    Write-Host "  " -NoNewline
    Write-Host "[FAIL]" -ForegroundColor Red -NoNewline
    Write-Host " $Message"
}

function Write-Info {
    param([string]$Message)
    Write-Host "  " -NoNewline
    Write-Host "[INFO]" -ForegroundColor Blue -NoNewline
    Write-Host " $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Host "  " -NoNewline
    Write-Host "[WARN]" -ForegroundColor Yellow -NoNewline
    Write-Host " $Message"
}

# ── Banner ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Blue
Write-Host "  Google Slides Hybrid MCP - Quick Setup (Windows)         " -ForegroundColor White
Write-Host "===========================================================" -ForegroundColor Blue

# ── Step 1: Check Node.js ────────────────────────────────────────────────────

Write-Step "Step 1: Checking prerequisites"

# Check Node.js
try {
    $nodeVersion = (node --version 2>$null)
    if (-not $nodeVersion) {
        throw "not found"
    }
} catch {
    Write-Fail "Node.js is not installed."
    Write-Info "Download from: https://nodejs.org/ (v18 or later)"
    exit 1
}

$nodeMajor = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
if ($nodeMajor -lt 18) {
    Write-Fail "Node.js $nodeVersion is too old. Please upgrade to v18 or later."
    exit 1
}
Write-Pass "Node.js $nodeVersion"

# Check npm
try {
    $npmVersion = (npm --version 2>$null)
    if (-not $npmVersion) {
        throw "not found"
    }
} catch {
    Write-Fail "npm is not installed."
    exit 1
}
Write-Pass "npm v$npmVersion"

# ── Step 2: Get the project ──────────────────────────────────────────────────

Write-Step "Step 2: Project setup"

$projectDir = $null

# Check if we're already inside the project
if (Test-Path "package.json") {
    $pkgContent = Get-Content "package.json" -Raw
    if ($pkgContent -match '"google-slides-hybrid-mcp"') {
        Write-Pass "Already in project directory"
        $projectDir = Get-Location
    }
}

# Check if project exists as subdirectory
if (-not $projectDir -and (Test-Path "google-slides-hybrid-mcp\package.json")) {
    Write-Pass "Project directory found"
    $projectDir = Join-Path (Get-Location) "google-slides-hybrid-mcp"
    Set-Location $projectDir
}

# Try to clone
if (-not $projectDir) {
    $repoUrl = $env:REPO_URL
    if (-not $repoUrl) {
        Write-Fail "Cannot determine repository URL."
        Write-Info "Please clone the repo manually first, then re-run this script:"
        Write-Info "    git clone <repository-url>"
        Write-Info "    cd google-slides-hybrid-mcp"
        Write-Info "    .\scripts\setup.ps1"
        exit 1
    }

    try {
        Write-Info "Cloning repository..."
        git clone $repoUrl "google-slides-hybrid-mcp"
        $projectDir = Join-Path (Get-Location) "google-slides-hybrid-mcp"
        Set-Location $projectDir
        Write-Pass "Repository cloned"
    } catch {
        Write-Fail "Failed to clone repository: $_"
        exit 1
    }
}

# ── Step 3: Install dependencies ─────────────────────────────────────────────

Write-Step "Step 3: Installing dependencies"

if (Test-Path "node_modules") {
    Write-Info "node_modules exists - running npm install to update"
}

try {
    npm install --no-audit --no-fund 2>&1 | Select-Object -Last 1
    Write-Pass "Dependencies installed"
} catch {
    Write-Warn "npm install had some issues, but continuing..."
}

# ── Step 4: Run setup wizard ─────────────────────────────────────────────────

Write-Step "Step 4: Running setup wizard"
Write-Host ""

$tsxPath = Join-Path "node_modules" ".bin" "tsx.cmd"
$setupScript = Join-Path "src" "cli" "setup.ts"

if (Test-Path $tsxPath) {
    & $tsxPath $setupScript
} else {
    npx tsx $setupScript
}

# Check exit code
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Setup wizard exited with code $LASTEXITCODE"
}

# ── Done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Start the server:    " -NoNewline -ForegroundColor DarkGray
Write-Host "npm start" -ForegroundColor Cyan
Write-Host "  Run diagnostics:     " -NoNewline -ForegroundColor DarkGray
Write-Host "npm run doctor" -ForegroundColor Cyan
Write-Host "  Development mode:    " -NoNewline -ForegroundColor DarkGray
Write-Host "npm run dev" -ForegroundColor Cyan
Write-Host ""
