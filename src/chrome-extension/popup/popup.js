/**
 * Google Slides MCP - Popup Logic
 *
 * Controls the extension popup UI, communicates with the background service
 * worker for status updates, and handles user interactions.
 */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $serverDot = document.getElementById('server-dot');
const $serverStatusText = document.getElementById('server-status-text');
const $tabDot = document.getElementById('tab-dot');
const $tabStatusText = document.getElementById('tab-status-text');
const $serverUrl = document.getElementById('server-url');
const $tabInfoSection = document.getElementById('tab-info-section');
const $tabTitle = document.getElementById('tab-title');
const $tabUrl = document.getElementById('tab-url');
const $btnConnect = document.getElementById('btn-connect');
const $btnBindTab = document.getElementById('btn-bind-tab');
const $btnDisconnect = document.getElementById('btn-disconnect');
const $btnUnbind = document.getElementById('btn-unbind');
const $csSection = document.getElementById('cs-section');
const $csList = document.getElementById('cs-list');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentStatus = {
  connected: false,
  serverUrl: 'ws://localhost:9222',
  boundTabId: null,
  contentTabs: [],
};

// ---------------------------------------------------------------------------
// UI update
// ---------------------------------------------------------------------------

function updateUI(status) {
  currentStatus = status;

  // Server connection
  if (status.connected) {
    $serverDot.className = 'status-dot connected';
    $serverStatusText.textContent = 'Connected';
    $btnConnect.style.display = 'none';
    $btnDisconnect.style.display = 'flex';
  } else {
    $serverDot.className = 'status-dot disconnected';
    $serverStatusText.textContent = 'Disconnected';
    $btnConnect.style.display = 'flex';
    $btnDisconnect.style.display = 'none';
  }

  // Bound tab
  if (status.boundTabId != null) {
    $tabDot.className = 'status-dot connected';
    $tabStatusText.textContent = `Tab #${status.boundTabId}`;
    $btnBindTab.style.display = 'none';
    $btnUnbind.style.display = 'flex';
    showTabInfo(status.boundTabId);
  } else {
    $tabDot.className = 'status-dot idle';
    $tabStatusText.textContent = 'No tab bound';
    $btnBindTab.style.display = 'flex';
    $btnUnbind.style.display = 'none';
    $tabInfoSection.style.display = 'none';
  }

  // Server URL
  if (status.serverUrl) {
    $serverUrl.value = status.serverUrl;
  }

  // Content scripts
  if (status.contentTabs && status.contentTabs.length > 0) {
    $csSection.style.display = 'block';
    $csList.innerHTML = '';
    for (const tabId of status.contentTabs) {
      const item = document.createElement('div');
      item.className = 'cs-item';
      item.innerHTML = `<span class="cs-tab-id">${tabId}</span> <span>content script active</span>`;
      $csList.appendChild(item);
    }
  } else {
    $csSection.style.display = 'none';
  }

  // Disable bind tab if not connected
  $btnBindTab.disabled = false; // Can bind even when not connected to server
}

async function showTabInfo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    $tabTitle.textContent = tab.title || 'Untitled';
    $tabTitle.title = tab.title || '';
    $tabUrl.textContent = tab.url || '';
    $tabInfoSection.style.display = 'block';
  } catch {
    $tabInfoSection.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Fetch status from background
// ---------------------------------------------------------------------------

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Failed to get status:', chrome.runtime.lastError.message);
      updateUI({
        connected: false,
        serverUrl: $serverUrl.value,
        boundTabId: null,
        contentTabs: [],
      });
      return;
    }
    if (response) {
      updateUI(response);
    }
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

$btnConnect.addEventListener('click', () => {
  const url = $serverUrl.value.trim();
  if (!url) {
    $serverUrl.focus();
    return;
  }

  // Validate URL format
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    $serverUrl.style.borderColor = '#ef4444';
    setTimeout(() => {
      $serverUrl.style.borderColor = '';
    }, 2000);
    return;
  }

  $btnConnect.disabled = true;
  $btnConnect.textContent = 'Connecting...';

  chrome.runtime.sendMessage({ type: 'connect', serverUrl: url }, (response) => {
    $btnConnect.disabled = false;
    $btnConnect.innerHTML = `
      <span class="btn-icon">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </span>
      Connect to Server
    `;

    if (chrome.runtime.lastError) {
      console.error('Connect error:', chrome.runtime.lastError.message);
      return;
    }

    // Save server URL
    chrome.storage.local.set({ serverUrl: url });

    // Refresh status after a short delay to allow connection
    setTimeout(refreshStatus, 500);
    setTimeout(refreshStatus, 1500);
  });
});

$btnDisconnect.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' }, () => {
    if (chrome.runtime.lastError) {
      console.error('Disconnect error:', chrome.runtime.lastError.message);
    }
    setTimeout(refreshStatus, 300);
  });
});

$btnBindTab.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      $tabStatusText.textContent = 'No active tab';
      return;
    }

    // Warn if not a Google Slides tab
    if (!tab.url?.includes('docs.google.com/presentation')) {
      const confirmed = confirm(
        'This tab does not appear to be a Google Slides presentation. Bind it anyway?',
      );
      if (!confirmed) return;
    }

    chrome.runtime.sendMessage({ type: 'bind_tab', tabId: tab.id }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Bind error:', chrome.runtime.lastError.message);
        return;
      }
      if (response?.error) {
        $tabStatusText.textContent = response.error;
        return;
      }
      setTimeout(refreshStatus, 200);
    });
  } catch (err) {
    console.error('Error binding tab:', err);
  }
});

$btnUnbind.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'unbind_tab' }, () => {
    if (chrome.runtime.lastError) {
      console.error('Unbind error:', chrome.runtime.lastError.message);
    }
    setTimeout(refreshStatus, 200);
  });
});

// Save server URL on blur
$serverUrl.addEventListener('blur', () => {
  const url = $serverUrl.value.trim();
  if (url) {
    chrome.storage.local.set({ serverUrl: url });
  }
});

// Load saved settings
async function loadSettings() {
  const stored = await chrome.storage.local.get(['serverUrl']);
  if (stored.serverUrl) {
    $serverUrl.value = stored.serverUrl;
  }
}

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

loadSettings();
refreshStatus();

// Refresh every 3 seconds while popup is open
const statusInterval = setInterval(refreshStatus, 3000);

// Clean up on popup close (not strictly needed, but good practice)
window.addEventListener('unload', () => {
  clearInterval(statusInterval);
});
