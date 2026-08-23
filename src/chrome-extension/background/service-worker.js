/**
 * Google Slides MCP - Background Service Worker
 *
 * Maintains a WebSocket connection to the local MCP relay server and routes
 * commands between the MCP server and content scripts running in Google Slides
 * tabs. This is the central message hub for the entire extension.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {WebSocket | null} */
let ws = null;

/** Current server URL */
let serverUrl = 'ws://localhost:9222';

/** Reconnection state */
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Connection status */
let connected = false;

/**
 * Map of tabId -> chrome.runtime.Port for active content-script connections.
 * @type {Map<number, chrome.runtime.Port>}
 */
const contentPorts = new Map();

/**
 * The tab currently bound for MCP control. null = none.
 * @type {number | null}
 */
let boundTabId = null;

/**
 * Pending request callbacks keyed by requestId.
 * @type {Map<string, { resolve: Function, timer: ReturnType<typeof setTimeout> }>}
 */
const pendingRequests = new Map();

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function showConnected() {
  connected = true;
  setBadge('ON', '#22c55e');
}

function showDisconnected() {
  connected = false;
  setBadge('OFF', '#ef4444');
}

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(serverUrl);
  } catch (err) {
    console.error('[MCP-BG] WebSocket construction error:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[MCP-BG] WebSocket connected to', serverUrl);
    reconnectAttempts = 0;
    showConnected();

    // Announce ourselves
    wsSend({
      type: 'extension_hello',
      boundTabId,
      timestamp: Date.now(),
    });
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn('[MCP-BG] Non-JSON message from server:', event.data);
      return;
    }
    handleServerMessage(msg);
  };

  ws.onerror = (err) => {
    console.error('[MCP-BG] WebSocket error:', err);
  };

  ws.onclose = (event) => {
    console.log('[MCP-BG] WebSocket closed:', event.code, event.reason);
    ws = null;
    showDisconnected();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('[MCP-BG] Max reconnect attempts reached. Giving up.');
    return;
  }

  const delay = Math.min(
    BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectAttempts++;
  console.log(`[MCP-BG] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(connectWebSocket, delay);
}

function disconnectWebSocket() {
  if (ws) {
    ws.onclose = null; // prevent auto-reconnect
    ws.close();
    ws = null;
  }
  showDisconnected();
}

/** Send a JSON message over the WebSocket. */
function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.warn('[MCP-BG] Cannot send – WebSocket not open');
  }
}

// ---------------------------------------------------------------------------
// Content-script port management
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'mcp-content') return;

  const tabId = port.sender?.tab?.id;
  if (tabId == null) {
    port.disconnect();
    return;
  }

  console.log('[MCP-BG] Content script connected from tab', tabId);
  contentPorts.set(tabId, port);

  port.onMessage.addListener((msg) => {
    handleContentMessage(tabId, msg);
  });

  port.onDisconnect.addListener(() => {
    console.log('[MCP-BG] Content script disconnected from tab', tabId);
    contentPorts.delete(tabId);
    if (boundTabId === tabId) {
      boundTabId = null;
    }
  });
});

/**
 * Forward a command to the content script in the bound tab and return a
 * promise that resolves with the response.
 */
function forwardToContentScript(requestId, command, params) {
  return new Promise((resolve, reject) => {
    if (boundTabId == null) {
      return reject(new Error('No tab is bound for MCP control'));
    }

    const port = contentPorts.get(boundTabId);
    if (!port) {
      return reject(new Error(`No content-script connection for tab ${boundTabId}`));
    }

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Content script request timed out'));
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, timer });

    port.postMessage({ requestId, command, params });
  });
}

/** Handle a response coming back from a content script. */
function handleContentMessage(tabId, msg) {
  // Heartbeat
  if (msg.type === 'heartbeat') return;

  // Response to a forwarded request
  if (msg.requestId && pendingRequests.has(msg.requestId)) {
    const { resolve, timer } = pendingRequests.get(msg.requestId);
    clearTimeout(timer);
    pendingRequests.delete(msg.requestId);
    resolve(msg);
    return;
  }

  // Unsolicited events from content script (future use)
  console.log('[MCP-BG] Unhandled content message from tab', tabId, msg);
}

// ---------------------------------------------------------------------------
// Handle commands from the MCP server
// ---------------------------------------------------------------------------

async function handleServerMessage(msg) {
  const { requestId, command, params } = msg;

  if (!requestId || !command) {
    console.warn('[MCP-BG] Malformed server message:', msg);
    return;
  }

  try {
    let result;

    switch (command) {
      case 'browser_navigate':
        result = await handleNavigate(params);
        break;

      case 'browser_screenshot':
        result = await handleScreenshot(params);
        break;

      case 'browser_evaluate':
        result = await handleEvaluate(params);
        break;

      // Commands forwarded to content script
      case 'browser_click':
      case 'browser_click_coordinates':
      case 'browser_type':
      case 'browser_press_key':
      case 'browser_hover':
      case 'browser_drag':
      case 'browser_scroll':
      case 'browser_snapshot':
      case 'browser_get_console_logs':
      case 'browser_get_page_text':
      case 'browser_select_option':
      case 'browser_wait_selector':
        result = await handleContentCommand(requestId, command, params);
        break;

      case 'ping':
        result = { pong: true, timestamp: Date.now() };
        break;

      case 'get_status':
        result = {
          connected,
          boundTabId,
          contentScripts: Array.from(contentPorts.keys()),
        };
        break;

      default:
        result = { error: `Unknown command: ${command}` };
    }

    wsSend({ requestId, result });
  } catch (err) {
    console.error('[MCP-BG] Command error:', command, err);
    wsSend({ requestId, error: err.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// Command handlers – executed in the service worker
// ---------------------------------------------------------------------------

async function handleNavigate(params) {
  const { url } = params || {};
  if (!url) throw new Error('Missing url parameter');

  let tabId = boundTabId;

  if (tabId != null) {
    await chrome.tabs.update(tabId, { url, active: true });
  } else {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;
    boundTabId = tabId;
  }

  // Wait for the tab to finish loading
  await waitForTabLoad(tabId);

  return { success: true, tabId, url };
}

function waitForTabLoad(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already complete
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function handleScreenshot(_params) {
  if (boundTabId == null) throw new Error('No tab bound');

  // Ensure the tab is active
  const tab = await chrome.tabs.get(boundTabId);
  await chrome.tabs.update(boundTabId, { active: true });

  // Brief delay to let the tab paint
  await sleep(150);

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png',
  });

  return { screenshot: dataUrl };
}

async function handleEvaluate(params) {
  const { expression } = params || {};
  if (!expression) throw new Error('Missing expression parameter');

  if (boundTabId == null) throw new Error('No tab bound');

  const results = await chrome.scripting.executeScript({
    target: { tabId: boundTabId },
    func: (expr) => {
      try {
        // eslint-disable-next-line no-eval
        return { value: String(eval(expr)) };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [expression],
    world: 'MAIN',
  });

  if (results && results[0]) {
    return results[0].result;
  }
  return { error: 'No result from executeScript' };
}

async function handleContentCommand(requestId, command, params) {
  const response = await forwardToContentScript(requestId, command, params);
  return response.result || { error: response.error || 'No result' };
}

// ---------------------------------------------------------------------------
// Message API for popup / other extension pages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'get_status':
      sendResponse({
        connected,
        serverUrl,
        boundTabId,
        contentTabs: Array.from(contentPorts.keys()),
      });
      return false;

    case 'connect': {
      const url = msg.serverUrl || serverUrl;
      serverUrl = url;
      chrome.storage.local.set({ serverUrl: url });
      reconnectAttempts = 0;
      disconnectWebSocket();
      connectWebSocket();
      sendResponse({ ok: true });
      return false;
    }

    case 'disconnect':
      disconnectWebSocket();
      reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // prevent auto-reconnect
      sendResponse({ ok: true });
      return false;

    case 'bind_tab': {
      const tabId = msg.tabId;
      if (tabId == null) {
        sendResponse({ error: 'No tabId provided' });
        return false;
      }
      boundTabId = tabId;
      chrome.storage.local.set({ boundTabId: tabId });
      sendResponse({ ok: true, boundTabId: tabId });

      // Notify MCP server
      wsSend({ type: 'tab_bound', tabId });
      return false;
    }

    case 'unbind_tab':
      boundTabId = null;
      chrome.storage.local.remove('boundTabId');
      sendResponse({ ok: true });
      wsSend({ type: 'tab_unbound' });
      return false;

    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init() {
  // Restore saved settings
  const stored = await chrome.storage.local.get(['serverUrl', 'boundTabId']);
  if (stored.serverUrl) serverUrl = stored.serverUrl;
  if (stored.boundTabId != null) boundTabId = stored.boundTabId;

  showDisconnected();
  connectWebSocket();
  console.log('[MCP-BG] Service worker initialised');
}

init();

// Keep service worker alive with periodic alarm
chrome.alarms?.create('mcp-keepalive', { periodInMinutes: 0.4 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mcp-keepalive') {
    // Touch the WebSocket to keep the service worker alive
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSend({ type: 'keepalive', timestamp: Date.now() });
    } else if (!ws || ws.readyState === WebSocket.CLOSED) {
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        connectWebSocket();
      }
    }
  }
});
