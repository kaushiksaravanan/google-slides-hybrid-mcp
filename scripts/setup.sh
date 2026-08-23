#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Google Slides Hybrid MCP — One-Line Setup Script (macOS / Linux)
# ─────────────────────────────────────────────────────────────────────────────
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/google-slides-hybrid-mcp/main/scripts/setup.sh | bash
#
# Or locally:
#   bash scripts/setup.sh
#
# This script:
#   1. Checks that Node.js >= 18 is installed
#   2. Clones the repo (if not already in it) or verifies we're in the project
#   3. Installs dependencies
#   4. Runs the interactive setup wizard
#   5. Prints next steps
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  BOLD="\033[1m"
  DIM="\033[2m"
  RED="\033[31m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  BLUE="\033[34m"
  CYAN="\033[36m"
  RESET="\033[0m"
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" CYAN="" RESET=""
fi

TICK="${GREEN}✓${RESET}"
CROSS="${RED}✗${RESET}"
ARROW="${CYAN}→${RESET}"
INFO="${BLUE}ℹ${RESET}"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo -e "  $*"; }
step() { echo -e "\n${BOLD}${BLUE}$1${RESET}"; echo -e "${DIM}$(printf '─%.0s' {1..50})${RESET}"; }

die() {
  echo -e "\n  ${CROSS} ${RED}$1${RESET}" >&2
  exit 1
}

# ── Banner ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${BLUE}║${RESET}  ${BOLD}Google Slides Hybrid MCP — Quick Setup${RESET}              ${BOLD}${BLUE}║${RESET}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════╝${RESET}"

# ── Step 1: Check Node.js ────────────────────────────────────────────────────

step "Step 1: Checking prerequisites"

if ! command -v node &> /dev/null; then
  die "Node.js is not installed. Download from https://nodejs.org/ (v18+)"
fi

NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js $NODE_VERSION is too old. Please upgrade to v18 or later."
fi

log "${TICK} Node.js ${NODE_VERSION}"

if ! command -v npm &> /dev/null; then
  die "npm is not installed."
fi

NPM_VERSION=$(npm --version)
log "${TICK} npm v${NPM_VERSION}"

# ── Step 2: Get the project ──────────────────────────────────────────────────

step "Step 2: Project setup"

# Check if we're already inside the project
if [ -f "package.json" ] && grep -q '"google-slides-hybrid-mcp"' package.json 2>/dev/null; then
  log "${TICK} Already in project directory"
  PROJECT_DIR="$(pwd)"
elif [ -d "google-slides-hybrid-mcp" ]; then
  log "${TICK} Project directory found"
  PROJECT_DIR="$(pwd)/google-slides-hybrid-mcp"
  cd "$PROJECT_DIR"
else
  # Try to clone
  if command -v git &> /dev/null; then
    REPO_URL="${REPO_URL:-https://github.com/<owner>/google-slides-hybrid-mcp.git}"
    if [ "$REPO_URL" = "https://github.com/<owner>/google-slides-hybrid-mcp.git" ]; then
      log "${INFO} No REPO_URL set. Checking if we can clone..."
      log "${CROSS} Cannot determine repository URL."
      log ""
      log "${ARROW} Please clone the repo manually first, then re-run this script:"
      log "    git clone <repository-url>"
      log "    cd google-slides-hybrid-mcp"
      log "    bash scripts/setup.sh"
      exit 1
    fi

    log "${ARROW} Cloning repository..."
    git clone "$REPO_URL" google-slides-hybrid-mcp
    PROJECT_DIR="$(pwd)/google-slides-hybrid-mcp"
    cd "$PROJECT_DIR"
    log "${TICK} Repository cloned"
  else
    die "git is not installed and project directory not found. Please clone the repo manually."
  fi
fi

# ── Step 3: Install dependencies ─────────────────────────────────────────────

step "Step 3: Installing dependencies"

if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  log "${INFO} node_modules exists — running npm install to ensure everything is up to date"
fi

npm install --no-audit --no-fund 2>&1 | tail -1 || true
log "${TICK} Dependencies installed"

# ── Step 4: Run setup wizard ─────────────────────────────────────────────────

step "Step 4: Running setup wizard"
echo ""

# Use tsx if available, otherwise npx tsx
if [ -f "node_modules/.bin/tsx" ]; then
  node_modules/.bin/tsx src/cli/setup.ts
else
  npx tsx src/cli/setup.ts
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}Setup complete!${RESET}"
echo ""
echo -e "  ${DIM}Start the server:${RESET}   ${CYAN}npm start${RESET}"
echo -e "  ${DIM}Run diagnostics:${RESET}    ${CYAN}npm run doctor${RESET}"
echo -e "  ${DIM}Development mode:${RESET}   ${CYAN}npm run dev${RESET}"
echo ""
