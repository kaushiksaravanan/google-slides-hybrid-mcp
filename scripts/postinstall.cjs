#!/usr/bin/env node

/**
 * Google Slides Hybrid MCP — Post-install Script
 *
 * Runs automatically after `npm install`:
 * - Checks Node.js version >= 18
 * - Tests if sharp (optional dependency) loads correctly
 * - Prints a welcome message with next steps
 *
 * IMPORTANT: This script must NEVER cause npm install to fail.
 * All errors are caught and reported as warnings.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  green: isTTY ? '\x1b[32m' : '',
  red: isTTY ? '\x1b[31m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

const TICK = `${c.green}✓${c.reset}`;
const CROSS = `${c.red}✗${c.reset}`;
const WARN = `${c.yellow}⚠${c.reset}`;
const INFO = `${c.blue}ℹ${c.reset}`;

// ─────────────────────────────────────────────────────────────────────────────
// Main (wrapped in try/catch to never fail npm install)
// ─────────────────────────────────────────────────────────────────────────────

try {
  console.log('');
  console.log(`${c.bold}${c.blue}  Google Slides Hybrid MCP${c.reset}`);
  console.log(`${c.dim}  Post-install checks${c.reset}`);
  console.log('');

  // ── Check Node.js version ──────────────────────────────────────────────

  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);

  if (nodeMajor >= 18) {
    console.log(`  ${TICK} Node.js ${nodeVersion}`);
  } else {
    console.log(`  ${WARN} Node.js ${nodeVersion} — v18+ is required`);
    console.log(`    ${c.dim}Download from: https://nodejs.org/${c.reset}`);
  }

  // ── Check sharp (optional dependency) ──────────────────────────────────

  let sharpOk = false;
  try {
    require('sharp');
    sharpOk = true;
    console.log(`  ${TICK} sharp library loaded (vision layer available)`);
  } catch {
    try {
      // sharp might need a rebuild for the current platform
      const { execSync } = require('child_process');
      execSync('npm rebuild sharp 2>&1', { stdio: 'pipe' });
      require('sharp');
      sharpOk = true;
      console.log(`  ${TICK} sharp library loaded after rebuild (vision layer available)`);
    } catch {
      console.log(`  ${WARN} sharp library not available (vision layer will be disabled)`);
      console.log(`    ${c.dim}This is optional. To fix: npm rebuild sharp${c.reset}`);
    }
  }

  // ── Check if .env exists ───────────────────────────────────────────────

  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  const envExamplePath = path.join(__dirname, '..', '.env.example');

  if (fs.existsSync(envPath)) {
    console.log(`  ${TICK} .env file found`);
  } else if (fs.existsSync(envExamplePath)) {
    console.log(`  ${INFO} .env file not found (setup required)`);
  }

  // ── Welcome message ────────────────────────────────────────────────────

  console.log('');
  console.log(`${c.dim}  ─────────────────────────────────────────────${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}Get started:${c.reset}`);
  console.log('');
  console.log(`    ${c.cyan}npm run setup${c.reset}     ${c.dim}Interactive setup wizard (recommended)${c.reset}`);
  console.log(`    ${c.cyan}npm run doctor${c.reset}    ${c.dim}Check installation health${c.reset}`);
  console.log(`    ${c.cyan}npm start${c.reset}         ${c.dim}Start the MCP server${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Documentation: README.md${c.reset}`);
  console.log('');
} catch (error) {
  // NEVER fail npm install — just print a warning
  console.log('');
  console.log(`  ${WARN} Post-install check encountered an issue: ${error.message || error}`);
  console.log(`  ${c.dim}This is harmless. Run 'npm run doctor' to diagnose.${c.reset}`);
  console.log('');
}
