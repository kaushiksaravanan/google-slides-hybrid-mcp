# Google Slides Hybrid MCP Server

A production-ready Model Context Protocol (MCP) server that provides AI assistants with full control over Google Slides presentations through three complementary layers: **REST API**, **Live Browser Automation**, and **Vision-Based Design Analysis**.

> **53 tools** across 3 layers, unified by a single orchestrator. Create, edit, analyze, and perfect presentations entirely through natural language.

---

## Quick Start (2 minutes)

### Option 1: Interactive Setup (Recommended)

```bash
git clone <repository-url> && cd google-slides-hybrid-mcp
npm install
npm run setup       # Interactive wizard: credentials, token, config, build
```

The setup wizard walks you through everything — Google Cloud credentials, OAuth token, and configuration — then builds the project automatically.

### Option 2: Manual Setup

```bash
git clone <repository-url> && cd google-slides-hybrid-mcp
npm install && npm run build
cp .env.example .env           # Edit with your Google OAuth credentials
npm run get-token              # Opens browser for OAuth consent flow
npm start                      # Start the MCP server
```

### Option 3: One-liner (macOS / Linux)

```bash
bash scripts/setup.sh
```

### Option 4: One-liner (Windows PowerShell)

```powershell
.\scripts\setup.ps1
```

### Verify Installation

```bash
npm run doctor                 # Checks everything is working
```

### After Setup

Add the server to your MCP client (Claude Desktop, Cursor, Windsurf, or OpenCode):

```json
{
  "mcpServers": {
    "google-slides-hybrid": {
      "command": "node",
      "args": ["/path/to/google-slides-hybrid-mcp/build/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "your-secret",
        "GOOGLE_REFRESH_TOKEN": "your-token"
      }
    }
  }
}
```

Pre-made configs are available in `configs/` for each MCP client.

### CLI Commands

| Command | Description |
|---|---|
| `npm run setup` | Interactive setup wizard |
| `npm run doctor` | Run diagnostics / health check |
| `npm start` | Start the MCP server |
| `npm run dev` | Start in development mode (tsx) |
| `npm run get-token` | Get a new OAuth refresh token |
| `npm run cli -- --help` | Show all CLI commands |

---

## Architecture

```
 MCP Client (Claude / Cursor / Windsurf / OpenCode)
        |
        |  stdio (JSON-RPC)
        v
 +-----------------------------------------+
 |       Hybrid Orchestrator               |
 |  Routes tool calls to the right layer   |
 |  Manages cross-layer workflows          |
 +-----------+------------+----------------+
             |            |            |
    +--------+--+  +------+------+  +--+----------+
    | API Layer |  | Browser     |  | Vision      |
    | slides_*  |  | Layer       |  | Layer       |
    | 19 tools  |  | live_*      |  | vision_*    |
    |           |  | 23 tools    |  | 11 tools    |
    +-----------+  +------+------+  +--+----------+
         |                |               |
         v                v               v
   Google Slides    Chrome Extension    sharp
   REST API         + WebSocket         (image
   (googleapis)     Bridge              analysis)
```

**API Layer** (`slides_*`) — Programmatic CRUD via Google Slides REST API. Create presentations, add slides/text/images/shapes/tables, apply layouts, convert Markdown to slides, export PDFs, share links, and extract content.

**Browser Layer** (`live_*`) — Real-time editing through a Chrome extension bridge. Navigate presentations, take screenshots, click/type/edit elements, change fonts/colors/backgrounds, apply transitions, and set speaker notes — everything you can do in the Slides UI.

**Vision Layer** (`vision_*`) — Design intelligence powered by sharp image analysis. Score slide design quality (0-100), detect alignment/spacing/color/typography issues, auto-generate fix plans, apply professional themes, extract color palettes, and compare slides for consistency.

---

## Full Installation Guide

### Prerequisites

- **Node.js 22+** (LTS recommended)
- **npm 10+**
- A **Google Cloud Platform** project with the Slides API and Drive API enabled
- **Google Chrome** (for the browser layer — optional)

### Step 1: Clone and Install

```bash
git clone <repository-url>
cd google-slides-hybrid-mcp
npm install
```

### Step 2: Build

```bash
npm run build
```

This compiles TypeScript from `src/` into `build/`. The entry point is `build/index.js`.

### Step 3: Configure Environment

```bash
cp .env.example .env
```

Fill in your Google OAuth credentials (see the next section).

### Step 4: Verify

```bash
npm run dev
```

The server will start and print layer status to stderr. You should see:

```
Layer status: API [OK] | Browser [--] | Vision [OK]
```

---

## OAuth Setup Walkthrough

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Note your project ID

### 2. Enable APIs

1. Go to **APIs & Services > Library**
2. Search for and enable:
   - **Google Slides API**
   - **Google Drive API**

### 3. Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Select **Desktop app** as the application type
4. Name it (e.g., "MCP Server")
5. Click **Create**
6. Copy the **Client ID** and **Client Secret**

### 4. Configure the OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**
2. Choose **External** (or Internal if using Google Workspace)
3. Fill in the required fields (app name, support email)
4. Add scopes:
   - `https://www.googleapis.com/auth/presentations`
   - `https://www.googleapis.com/auth/drive`
5. Add your Google account as a test user

### 5. Get a Refresh Token

```bash
# Set your credentials first
export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="your-client-secret"

# Run the token helper
npm run get-token
```

This opens a browser window for the OAuth consent flow. After granting access, the refresh token is printed to the console. Copy it to your `.env` file.

### 6. Update .env

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=1//your-refresh-token
```

---

## Configuration Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | — | OAuth 2.0 Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Yes | — | OAuth 2.0 Client Secret |
| `GOOGLE_REFRESH_TOKEN` | Yes | — | Long-lived refresh token from OAuth flow |
| `BROWSER_WS_PORT` | No | `9222` | WebSocket port for Chrome extension bridge |
| `BROWSER_SCREENSHOT_FORMAT` | No | `png` | Screenshot format: `png`, `jpeg`, or `webp` |
| `BROWSER_TIMEOUT` | No | `30000` | Browser operation timeout in milliseconds |
| `VISION_ENABLED` | No | `true` | Enable the vision analysis layer |
| `VISION_AUTO_FIX` | No | `false` | Auto-apply design fixes (vs. returning fix plans) |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | No | `production` | Runtime environment |

---

## MCP Client Setup

### Claude Desktop

**Config file location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add to your config (or copy from `configs/claude-desktop.json`):

```json
{
  "mcpServers": {
    "google-slides-hybrid": {
      "command": "node",
      "args": ["/absolute/path/to/google-slides-hybrid-mcp/build/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "GOOGLE_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

### Cursor

**Config file location:** `.cursor/mcp.json` in your project root, or global settings.

Copy from `configs/cursor.json`:

```json
{
  "mcpServers": {
    "google-slides-hybrid": {
      "command": "node",
      "args": ["/absolute/path/to/google-slides-hybrid-mcp/build/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "GOOGLE_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

### Windsurf

**Config file location:** Windsurf MCP settings (Settings > MCP Servers).

Copy from `configs/windsurf.json`:

```json
{
  "mcpServers": {
    "google-slides-hybrid": {
      "command": "node",
      "args": ["/absolute/path/to/google-slides-hybrid-mcp/build/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "GOOGLE_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

### OpenCode

**Config file location:** `~/.config/opencode/config.json` or project `.opencode/config.json`.

Copy from `configs/opencode.json`:

```json
{
  "mcpServers": {
    "google-slides-hybrid": {
      "command": "node",
      "args": ["/absolute/path/to/google-slides-hybrid-mcp/build/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
        "GOOGLE_REFRESH_TOKEN": "YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

> **Note:** Replace `/absolute/path/to/` with the actual path on your system. Use forward slashes on all platforms. All `env` values must be real credentials, not placeholders.

---

## Chrome Extension Installation

The browser layer requires the bundled Chrome extension to relay commands to Google Slides.

### Manual Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `src/chrome-extension/` directory from this project
5. The extension icon should appear in your toolbar
6. Open a Google Slides presentation in Chrome
7. Click the extension icon and verify it shows "Connected"

### How It Works

```
MCP Server  <──WebSocket──>  Chrome Extension  <──Content Script──>  Google Slides
(Node.js)     (port 9222)    (background.js)      (DOM access)       (browser tab)
```

The Chrome extension:
- Runs a WebSocket client that connects to the MCP server
- Injects a content script into Google Slides tabs
- Relays click, type, screenshot, and DOM query commands
- Returns results (screenshots, accessibility trees, text content) to the server

---

## Tool Reference

### API Layer (19 tools) — `slides_*`

| Tool | Description |
|---|---|
| `slides_create_presentation` | Create a new empty presentation |
| `slides_get_presentation` | Get full metadata and slide list |
| `slides_get_page` | Get detailed content of a specific slide |
| `slides_get_page_thumbnail` | Get a thumbnail image URL for a slide |
| `slides_batch_update` | Apply raw batch mutation requests |
| `slides_create_slide` | Add a new slide with optional layout |
| `slides_delete_slide` | Delete a slide by page object ID |
| `slides_duplicate_slide` | Duplicate an existing slide |
| `slides_add_text` | Add a text box with position and font |
| `slides_add_image` | Insert an image from a public URL |
| `slides_add_table` | Add a table with given rows and columns |
| `slides_add_shape` | Add a shape with fill and border colors |
| `slides_set_layout` | Change a slide's layout |
| `slides_markdown_create` | Create a presentation from Markdown |
| `slides_markdown_update` | Replace all slides with Markdown content |
| `slides_markdown_append` | Append slides from Markdown |
| `slides_export_pdf` | Get a PDF export URL |
| `slides_share` | Create a shareable link |
| `slides_summarize` | Extract all text content for summarization |

### Browser Layer (23 tools) — `live_*`

| Tool | Description |
|---|---|
| `live_navigate_to_presentation` | Open a presentation in the browser |
| `live_go_to_slide` | Navigate to a slide by 1-based index |
| `live_screenshot` | Take a screenshot of the current view |
| `live_get_accessibility_snapshot` | Get the accessibility tree |
| `live_get_page_text` | Extract all visible text from the page |
| `live_click_element` | Click an element by CSS selector |
| `live_type_text` | Type text into the focused element |
| `live_press_key` | Press a key or key combination |
| `live_edit_text` | Edit text of an element by label |
| `live_change_font` | Change font of selected text |
| `live_change_font_size` | Change font size of selected text |
| `live_change_text_color` | Change text color (hex) |
| `live_change_background` | Change slide background color (hex) |
| `live_toggle_bold` | Toggle bold formatting (Ctrl+B) |
| `live_toggle_italic` | Toggle italic formatting (Ctrl+I) |
| `live_toggle_underline` | Toggle underline formatting (Ctrl+U) |
| `live_align_elements` | Align selected elements |
| `live_insert_image` | Insert an image from URL |
| `live_duplicate_slide` | Duplicate the current slide |
| `live_delete_slide` | Delete the current slide |
| `live_move_element` | Move an element by pixel offset |
| `live_apply_transition` | Apply a slide transition |
| `live_set_speaker_notes` | Set speaker notes for the current slide |

### Vision Layer (11 tools) — `vision_*`

| Tool | Description |
|---|---|
| `vision_analyze_slide` | Analyze design quality of a specific slide |
| `vision_analyze_presentation` | Analyze design across all slides |
| `vision_get_design_score` | Quick design score (0-100) and letter grade |
| `vision_get_fix_suggestions` | Get detailed fix suggestions for issues |
| `vision_auto_fix_slide` | Auto-generate design fixes for a slide |
| `vision_auto_fix_presentation` | Auto-fix design across all slides |
| `vision_apply_theme` | Apply a professional preset or custom theme |
| `vision_apply_color_scheme` | Apply a custom color scheme |
| `vision_apply_font_scheme` | Apply a custom font pairing |
| `vision_compare_slides` | Compare two slides for consistency |
| `vision_extract_colors` | Extract dominant colors from a screenshot |

---

## Usage Examples

### Markdown to Slides

```
User: Create a presentation about our Q4 results from this markdown:

# Q4 2024 Results
## Revenue Growth
- Total revenue: $2.4M (+18% YoY)
- New customers: 342
- Churn rate: 2.1%

## Key Wins
- Launched v2.0 platform
- Expanded to 3 new markets
- NPS score: 72

## 2025 Roadmap
- AI-powered analytics
- Enterprise tier launch
- Mobile app release
```

The AI assistant calls `slides_markdown_create` with the title and markdown content. The server:
1. Creates a new Google Slides presentation
2. Parses the Markdown into individual slides
3. Detects appropriate layouts (title slide, bullet lists)
4. Formats headings, bullets, and text hierarchy
5. Returns the presentation URL

### Live Editing Session

```
User: Open my presentation and change the title slide background to dark blue,
      then make the title text white and increase the font size to 44pt.

AI calls:
  1. live_navigate_to_presentation({ presentationId: "abc123" })
  2. live_go_to_slide({ slideIndex: 1 })
  3. live_change_background({ hexColor: "#1A237E" })
  4. live_edit_text({ elementLabel: "Title", newText: "" })  // click into title
  5. live_press_key({ key: "a", modifiers: ["Control"] })    // select all
  6. live_change_text_color({ hexColor: "#FFFFFF" })
  7. live_change_font_size({ size: 44 })
  8. live_screenshot()  // verify the result
```

### Vision Analysis and Auto-Fix

```
User: Analyze slide 3 of my presentation and fix any design issues.

AI calls:
  1. live_go_to_slide({ slideIndex: 3 })
  2. live_screenshot()  // capture current state
  3. vision_analyze_slide({
       presentationId: "abc123",
       slideIndex: 2,
       screenshotBase64: "<base64 data>"
     })
  // Result: Score 62/100 (D), 4 issues found:
  //   - alignment: Title not centered
  //   - spacing: Uneven margins between elements
  //   - contrast: Light gray text on white background
  //   - hierarchy: Body text same size as subtitle

  4. vision_auto_fix_slide({
       presentationId: "abc123",
       slideId: "slide_003"
     })
  // Returns fix plan with batch update requests

  5. slides_batch_update({
       presentationId: "abc123",
       requests: [/* fix plan requests */]
     })
  // Applies all fixes

  6. live_screenshot()  // verify improvements
  7. vision_analyze_slide(...)  // re-score: 89/100 (B)
```

---

## Professional Workflow Walkthrough

This example demonstrates a complete end-to-end workflow: creating a branded presentation from scratch.

### 1. Create the Presentation Structure

```
"Create a 10-slide investor pitch deck for TechCo with markdown"
```

The assistant uses `slides_markdown_create` with a structured markdown document covering: title, problem, solution, market size, traction, business model, team, financials, ask, and closing.

### 2. Apply Brand Theme

```
"Apply our brand colors: primary #2563EB, secondary #1E40AF,
 accent #F59E0B, with Montserrat for titles and Inter for body"
```

The assistant calls `vision_apply_theme` with a custom theme definition, then applies it via `slides_batch_update`.

### 3. Add Visual Assets

```
"Add our logo to the title slide and product screenshots to the solution slide"
```

The assistant uses `slides_add_image` for precise API placement, or `live_insert_image` for visual positioning in the browser.

### 4. Design Quality Check

```
"Score every slide and fix anything below a B grade"
```

The assistant iterates: `live_go_to_slide` + `live_screenshot` + `vision_analyze_slide` for each slide, then runs `vision_auto_fix_slide` on any slide scoring below 80, applying fixes via `slides_batch_update`.

### 5. Final Polish

```
"Add fade transitions between slides and speaker notes for each slide"
```

The assistant uses `live_apply_transition` and `live_set_speaker_notes` for each slide via the browser layer.

### 6. Share

```
"Share the presentation with my team as editors and give me the link"
```

The assistant calls `slides_share({ presentationId: "...", role: "writer" })`.

---

## Development Guide

### Setup

```bash
git clone <repository-url>
cd google-slides-hybrid-mcp
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Scripts

| Script | Description |
|---|---|
| `npm run setup` | Interactive setup wizard (credentials, config, build) |
| `npm run doctor` | Run diagnostics and health checks |
| `npm run cli` | CLI entry point with subcommands |
| `npm run dev` | Run with tsx (live TypeScript execution) |
| `npm run build` | Compile TypeScript to `build/` |
| `npm start` | Run the compiled server |
| `npm test` | Run all tests |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests |
| `npm run test:e2e` | Run end-to-end tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run lint` | Lint source files |
| `npm run typecheck` | Type-check without emitting |
| `npm run get-token` | OAuth token helper |

### Project Structure

```
src/
  index.ts                 # Entry point, MCP server setup
  cli/                     # CLI tools
    index.ts               # CLI entry point (subcommand router)
    setup.ts               # Interactive setup wizard
    doctor.ts              # Diagnostics and health checks
  api/                     # Google Slides REST API layer
    auth.ts                # OAuth2 authentication
    client.ts              # API client wrapper
    tools.ts               # 19 API tool definitions
    markdown.ts            # Markdown-to-slides converter
    getRefreshToken.ts     # Token helper utility
    index.ts               # Layer barrel export
  browser/                 # Live browser automation layer
    connection.ts          # WebSocket connection manager
    slides-controller.ts   # High-level Slides operations
    actions.ts             # Low-level browser actions
    tools.ts               # 23 browser tool definitions
    index.ts               # Layer barrel export
  vision/                  # Design analysis layer
    analyzer.ts            # Image analysis with sharp
    design-rules.ts        # Rule-based design evaluation
    auto-fixer.ts          # Fix plan generator
    theme-engine.ts        # Theme definitions and applicator
    tools.ts               # 11 vision tool definitions
    index.ts               # Layer barrel export
  orchestrator/            # Cross-layer coordination
    orchestrator.ts        # Tool routing and layer management
    workflow.ts            # Multi-step workflow definitions
    index.ts               # Layer barrel export
  shared/                  # Shared utilities
    types.ts               # Core type definitions
    constants.ts           # All constants
    errors.ts              # Error classes
    logger.ts              # Winston logger factory
    validators.ts          # Zod schemas and validators
    retry.ts               # Retry with exponential backoff
  chrome-extension/        # Browser extension source
    manifest.json          # Extension manifest v3
    background/            # Service worker
    content/               # Content script (injected into Slides)
    popup/                 # Extension popup UI
    icons/                 # Extension icons
  tests/
    setup.ts               # Test setup and global mocks
    unit/                  # Unit tests per module
    integration/           # Cross-layer integration tests
    e2e/                   # End-to-end server tests
```

### Testing

The project uses [Vitest](https://vitest.dev/) for testing.

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode for development
npm run test:watch

# Run specific test files
npx vitest run src/tests/unit/api.test.ts
```

Coverage thresholds are configured in `vitest.config.ts`:
- Lines: 50%
- Functions: 50%
- Branches: 40%
- Statements: 50%

---

## Docker Deployment

### Build the Image

```bash
docker build -t google-slides-hybrid-mcp .
```

### Run with Docker

```bash
docker run --rm -i \
  -e GOOGLE_CLIENT_ID="your-client-id" \
  -e GOOGLE_CLIENT_SECRET="your-client-secret" \
  -e GOOGLE_REFRESH_TOKEN="your-refresh-token" \
  google-slides-hybrid-mcp
```

### Docker Compose

```bash
# Copy and fill in environment variables
cp .env.example .env

# Build and run (production)
docker compose build
docker compose run --rm google-slides-hybrid-mcp

# Development mode (mounts source for live changes)
docker compose --profile dev up google-slides-hybrid-mcp-dev
```

### Image Details

- **Base:** Node.js 22 Alpine
- **Multi-stage:** Builder (compiles TS + installs deps) and Runner (minimal production image)
- **Security:** Runs as non-root user `mcpuser` (UID 1001)
- **Health check:** Verifies the entry point is loadable
- **Size:** ~180MB (Alpine + Node.js + sharp native deps)

---

## Troubleshooting

### "API: Not available" on startup

**Cause:** Missing or invalid Google OAuth credentials.

**Fix:**
1. Verify `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` are set
2. Run `npm run get-token` to obtain a fresh refresh token
3. Ensure the Google Slides API and Drive API are enabled in your GCP project
4. Check that your OAuth consent screen includes your account as a test user

### "Browser: Not available" on startup

**Cause:** The Chrome extension is not installed or not connected.

**Fix:**
1. Install the Chrome extension from `src/chrome-extension/` (see Chrome Extension Installation above)
2. Open a Google Slides presentation in Chrome
3. Click the extension icon to verify connection status
4. Check that `BROWSER_WS_PORT` matches the extension's configured port (default: 9222)

### "Vision: Not available" on startup

**Cause:** The `sharp` library failed to load.

**Fix:**
1. Reinstall dependencies: `npm rebuild sharp`
2. On Alpine Linux or Docker: ensure `vips` is installed (`apk add vips-dev`)
3. Set `VISION_ENABLED=false` if you don't need the vision layer

### Token expired errors

Google refresh tokens can expire if:
- The token hasn't been used for 6 months
- The user revoked access
- The GCP project's OAuth consent screen is in "Testing" mode (tokens expire after 7 days)

**Fix:** Run `npm run get-token` to get a new refresh token. For long-lived tokens, publish your OAuth consent screen (or use a Google Workspace internal app).

### "Unknown tool" errors

**Cause:** The MCP client is calling a tool from a layer that isn't active.

**Fix:**
1. Check the startup logs for layer status
2. `live_*` tools require the browser layer (Chrome extension connected)
3. `vision_*` tools require `VISION_ENABLED=true` and sharp to be loadable
4. `slides_*` tools require valid Google OAuth credentials

### High memory usage

**Cause:** Large screenshots or many concurrent vision analyses.

**Fix:**
1. Use `BROWSER_SCREENSHOT_FORMAT=jpeg` for smaller screenshots
2. Reduce concurrent operations
3. Increase Node.js memory limit: `node --max-old-space-size=4096 build/index.js`

---

## License

MIT
