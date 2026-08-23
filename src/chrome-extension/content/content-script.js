/**
 * Google Slides MCP - Content Script
 *
 * Injected into docs.google.com/presentation/* pages. Handles browser
 * automation commands forwarded from the background service worker and
 * provides Google-Slides-specific helpers for navigating the Slides DOM.
 */

// ---------------------------------------------------------------------------
// Console log capture
// ---------------------------------------------------------------------------

const MAX_CONSOLE_ENTRIES = 100;
/** @type {Array<{level: string, message: string, timestamp: number}>} */
const consoleLogs = [];

function captureConsole() {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };

  function intercept(level, originalFn) {
    return function (...args) {
      const message = args
        .map((a) => {
          try {
            return typeof a === 'object' ? JSON.stringify(a) : String(a);
          } catch {
            return String(a);
          }
        })
        .join(' ');

      consoleLogs.push({ level, message, timestamp: Date.now() });
      if (consoleLogs.length > MAX_CONSOLE_ENTRIES) {
        consoleLogs.shift();
      }

      originalFn(...args);
    };
  }

  console.log = intercept('log', original.log);
  console.warn = intercept('warn', original.warn);
  console.error = intercept('error', original.error);
  console.info = intercept('info', original.info);

  // Capture uncaught errors
  window.addEventListener('error', (event) => {
    consoleLogs.push({
      level: 'error',
      message: `Uncaught: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`,
      timestamp: Date.now(),
    });
    if (consoleLogs.length > MAX_CONSOLE_ENTRIES) consoleLogs.shift();
  });

  window.addEventListener('unhandledrejection', (event) => {
    consoleLogs.push({
      level: 'error',
      message: `Unhandled rejection: ${event.reason}`,
      timestamp: Date.now(),
    });
    if (consoleLogs.length > MAX_CONSOLE_ENTRIES) consoleLogs.shift();
  });
}

captureConsole();

// ---------------------------------------------------------------------------
// Connection to background service worker
// ---------------------------------------------------------------------------

/** @type {chrome.runtime.Port | null} */
let port = null;
let heartbeatInterval = null;

function connectToBackground() {
  port = chrome.runtime.connect({ name: 'mcp-content' });

  port.onMessage.addListener((msg) => {
    handleCommand(msg);
  });

  port.onDisconnect.addListener(() => {
    console.warn('[MCP-CS] Disconnected from background');
    port = null;
    clearInterval(heartbeatInterval);
    // Attempt reconnect after a short delay
    setTimeout(connectToBackground, 2000);
  });

  // Heartbeat every 20 seconds
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (port) {
      port.postMessage({ type: 'heartbeat', timestamp: Date.now() });
    }
  }, 20_000);

  console.log('[MCP-CS] Connected to background service worker');
}

connectToBackground();

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

async function handleCommand(msg) {
  const { requestId, command, params } = msg;
  if (!requestId || !command) return;

  try {
    let result;

    switch (command) {
      case 'browser_click':
        result = await cmdClick(params);
        break;
      case 'browser_click_coordinates':
        result = await cmdClickCoordinates(params);
        break;
      case 'browser_type':
        result = await cmdType(params);
        break;
      case 'browser_press_key':
        result = await cmdPressKey(params);
        break;
      case 'browser_hover':
        result = await cmdHover(params);
        break;
      case 'browser_drag':
        result = await cmdDrag(params);
        break;
      case 'browser_scroll':
        result = await cmdScroll(params);
        break;
      case 'browser_snapshot':
        result = await cmdSnapshot(params);
        break;
      case 'browser_get_page_text':
        result = await cmdGetPageText(params);
        break;
      case 'browser_get_console_logs':
        result = await cmdGetConsoleLogs(params);
        break;
      case 'browser_select_option':
        result = await cmdSelectOption(params);
        break;
      case 'browser_wait_selector':
        result = await cmdWaitSelector(params);
        break;
      default:
        result = { error: `Unknown command: ${command}` };
    }

    port?.postMessage({ requestId, result });
  } catch (err) {
    console.error('[MCP-CS] Command error:', command, err);
    port?.postMessage({ requestId, error: err.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve an element from a selector string. Supports:
 *  - CSS selectors
 *  - XPath (prefix with "xpath:")
 *  - aria-label lookup (prefix with "aria:")
 *  - text content lookup (prefix with "text:")
 */
function resolveElement(selector) {
  if (!selector) return null;

  if (selector.startsWith('xpath:')) {
    const xpath = selector.slice(6);
    const xResult = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    return xResult.singleNodeValue;
  }

  if (selector.startsWith('aria:')) {
    const label = selector.slice(5);
    return (
      document.querySelector(`[aria-label="${CSS.escape(label)}"]`) ||
      document.querySelector(`[aria-label*="${CSS.escape(label)}"]`)
    );
  }

  if (selector.startsWith('text:')) {
    const text = selector.slice(5).toLowerCase();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          const content = node.textContent?.trim().toLowerCase() || '';
          if (content === text || content.includes(text)) {
            // Prefer leaf-ish nodes
            if (node.children.length === 0 || node.innerText?.trim().toLowerCase() === text) {
              return NodeFilter.FILTER_ACCEPT;
            }
          }
          return NodeFilter.FILTER_SKIP;
        },
      },
    );
    return walker.nextNode();
  }

  return document.querySelector(selector);
}

function getElementCenter(el) {
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function dispatchMouseEvent(target, type, x, y, extra = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: extra.button ?? 0,
    buttons: extra.buttons ?? (type === 'mouseup' ? 0 : 1),
    ...extra,
  });
  target.dispatchEvent(event);
}

function dispatchPointerEvent(target, type, x, y, extra = {}) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: extra.button ?? 0,
    buttons: extra.buttons ?? (type === 'pointerup' ? 0 : 1),
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    ...extra,
  });
  target.dispatchEvent(event);
}

function elementDescription(el) {
  const tag = el.tagName?.toLowerCase() || '';
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).join('.')
    : '';
  const ariaLabel = el.getAttribute('aria-label');
  const text = el.textContent?.trim().slice(0, 60) || '';
  return `<${tag}${id}${cls}${ariaLabel ? ` aria-label="${ariaLabel}"` : ''}> "${text}"`;
}

// ---------------------------------------------------------------------------
// Google Slides-specific helpers
// ---------------------------------------------------------------------------

const SlidesHelpers = {
  /** Get the main slide canvas area */
  getCanvas() {
    return (
      document.querySelector('.punch-viewer-svgpage-svgcontainer') ||
      document.querySelector('.punch-viewer-content') ||
      document.querySelector('[id^="punch-viewer"]') ||
      document.querySelector('.punch-viewer-container')
    );
  },

  /** Get the filmstrip (slide panel on the left) */
  getFilmstrip() {
    return (
      document.querySelector('.punch-filmstrip-scroll') ||
      document.querySelector('[role="tablist"][aria-label]') ||
      document.querySelector('.punch-filmstrip')
    );
  },

  /** Get the currently selected slide number (1-indexed) */
  getCurrentSlideNumber() {
    // Method 1: Check the filmstrip for the selected item
    const selected = document.querySelector(
      '.punch-filmstrip-thumbnail[aria-selected="true"]',
    );
    if (selected) {
      const label = selected.getAttribute('aria-label') || '';
      const match = label.match(/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }

    // Method 2: Check the slide number input
    const slideInput = document.querySelector(
      'input[aria-label*="slide number" i], input[aria-label*="Slide number" i]',
    );
    if (slideInput) {
      const val = parseInt(slideInput.value, 10);
      if (!isNaN(val)) return val;
    }

    // Method 3: Parse the URL hash
    const hash = window.location.hash;
    const hashMatch = hash.match(/slide=id\.p(\d+)/);
    if (hashMatch) return parseInt(hashMatch[1], 10) + 1;

    return null;
  },

  /** Get total slide count */
  getTotalSlides() {
    const thumbnails = document.querySelectorAll('.punch-filmstrip-thumbnail');
    return thumbnails.length || null;
  },

  /** Find a toolbar button by its aria-label */
  findToolbarButton(label) {
    return (
      document.querySelector(
        `.punch-viewer-toolbar [aria-label="${label}"], ` +
        `[role="toolbar"] [aria-label="${label}"], ` +
        `[aria-label="${label}"][role="button"]`,
      )
    );
  },

  /** Get all toolbar button labels */
  getToolbarLabels() {
    const buttons = document.querySelectorAll(
      '[role="toolbar"] [aria-label], .punch-viewer-toolbar [aria-label]',
    );
    return Array.from(buttons).map((el) => ({
      label: el.getAttribute('aria-label'),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
    }));
  },

  /** Get the speaker notes area */
  getSpeakerNotes() {
    return document.querySelector(
      '[aria-label*="speaker notes" i], .punch-viewer-speakernotes-text',
    );
  },
};

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdClick(params) {
  const { selector } = params || {};
  if (!selector) throw new Error('Missing selector parameter');

  const el = resolveElement(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  // Scroll element into view
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  await sleep(50);

  const { x, y } = getElementCenter(el);

  // Full mouse event sequence for maximum compatibility
  dispatchPointerEvent(el, 'pointerover', x, y);
  dispatchPointerEvent(el, 'pointerenter', x, y);
  dispatchMouseEvent(el, 'mouseover', x, y);
  dispatchMouseEvent(el, 'mouseenter', x, y);
  dispatchPointerEvent(el, 'pointerdown', x, y);
  dispatchMouseEvent(el, 'mousedown', x, y);
  el.focus?.();
  await sleep(10);
  dispatchPointerEvent(el, 'pointerup', x, y);
  dispatchMouseEvent(el, 'mouseup', x, y);
  dispatchMouseEvent(el, 'click', x, y);

  return { success: true, element: elementDescription(el), x, y };
}

async function cmdClickCoordinates(params) {
  const { x, y, button } = params || {};
  if (x == null || y == null) throw new Error('Missing x or y coordinate');

  const target = document.elementFromPoint(x, y) || document.documentElement;

  dispatchPointerEvent(target, 'pointerover', x, y);
  dispatchPointerEvent(target, 'pointerenter', x, y);
  dispatchMouseEvent(target, 'mouseover', x, y);
  dispatchMouseEvent(target, 'mouseenter', x, y);
  dispatchPointerEvent(target, 'pointerdown', x, y, { button: button ?? 0 });
  dispatchMouseEvent(target, 'mousedown', x, y, { button: button ?? 0 });
  target.focus?.();
  await sleep(10);
  dispatchPointerEvent(target, 'pointerup', x, y, { button: button ?? 0 });
  dispatchMouseEvent(target, 'mouseup', x, y, { button: button ?? 0 });
  dispatchMouseEvent(target, 'click', x, y, { button: button ?? 0 });

  return { success: true, element: elementDescription(target), x, y };
}

async function cmdType(params) {
  const { selector, text, clearFirst } = params || {};
  if (text == null) throw new Error('Missing text parameter');

  let target;
  if (selector) {
    target = resolveElement(selector);
    if (!target) throw new Error(`Element not found: ${selector}`);
    target.focus?.();
    await sleep(50);
  } else {
    target = document.activeElement || document.body;
  }

  // Clear existing content if requested
  if (clearFirst) {
    // Select all then delete
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }),
    );
    target.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }),
    );
    await sleep(20);
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }),
    );
    target.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', bubbles: true }),
    );
    await sleep(20);
  }

  // Type each character
  for (const char of text) {
    // keydown
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
      }),
    );

    // For input/textarea elements, also set value and fire input event
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      target.value = target.value.slice(0, start) + char + target.value.slice(end);
      target.selectionStart = target.selectionEnd = start + 1;
    }

    target.dispatchEvent(
      new InputEvent('input', {
        data: char,
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      }),
    );

    // beforeinput
    target.dispatchEvent(
      new InputEvent('beforeinput', {
        data: char,
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      }),
    );

    // keyup
    target.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
      }),
    );

    await sleep(5); // Small delay between keystrokes
  }

  return { success: true, typed: text.length, target: elementDescription(target) };
}

async function cmdPressKey(params) {
  const { key, modifiers } = params || {};
  if (!key) throw new Error('Missing key parameter');

  const target = document.activeElement || document.body;

  // Parse modifiers
  const mods = modifiers || {};
  const eventInit = {
    key,
    code: keyToCode(key),
    bubbles: true,
    cancelable: true,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  };

  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  await sleep(10);
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

  return { success: true, key, target: elementDescription(target) };
}

function keyToCode(key) {
  const codeMap = {
    Enter: 'Enter',
    Tab: 'Tab',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Space: 'Space',
    ' ': 'Space',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  };
  if (codeMap[key]) return codeMap[key];
  if (key.length === 1) return `Key${key.toUpperCase()}`;
  return key;
}

async function cmdHover(params) {
  const { selector, x, y } = params || {};

  let target, hx, hy;

  if (selector) {
    target = resolveElement(selector);
    if (!target) throw new Error(`Element not found: ${selector}`);
    const center = getElementCenter(target);
    hx = center.x;
    hy = center.y;
  } else if (x != null && y != null) {
    target = document.elementFromPoint(x, y) || document.documentElement;
    hx = x;
    hy = y;
  } else {
    throw new Error('Must provide selector or x,y coordinates');
  }

  dispatchPointerEvent(target, 'pointerover', hx, hy);
  dispatchPointerEvent(target, 'pointerenter', hx, hy);
  dispatchMouseEvent(target, 'mouseover', hx, hy);
  dispatchMouseEvent(target, 'mouseenter', hx, hy);
  dispatchPointerEvent(target, 'pointermove', hx, hy);
  dispatchMouseEvent(target, 'mousemove', hx, hy);

  return { success: true, element: elementDescription(target), x: hx, y: hy };
}

async function cmdDrag(params) {
  const { selector, startX, startY, endX, endY, steps } = params || {};

  let sx, sy;
  let target;

  if (selector) {
    target = resolveElement(selector);
    if (!target) throw new Error(`Element not found: ${selector}`);
    const center = getElementCenter(target);
    sx = center.x;
    sy = center.y;
  } else if (startX != null && startY != null) {
    sx = startX;
    sy = startY;
    target = document.elementFromPoint(sx, sy) || document.documentElement;
  } else {
    throw new Error('Must provide selector or startX,startY');
  }

  if (endX == null || endY == null) throw new Error('Missing endX or endY');

  const numSteps = steps || 10;

  // mousedown at start
  dispatchPointerEvent(target, 'pointerdown', sx, sy);
  dispatchMouseEvent(target, 'mousedown', sx, sy);
  await sleep(30);

  // mousemove in steps
  for (let i = 1; i <= numSteps; i++) {
    const progress = i / numSteps;
    const mx = sx + (endX - sx) * progress;
    const my = sy + (endY - sy) * progress;
    const moveTarget = document.elementFromPoint(mx, my) || document.documentElement;
    dispatchPointerEvent(moveTarget, 'pointermove', mx, my);
    dispatchMouseEvent(moveTarget, 'mousemove', mx, my);
    await sleep(16); // ~60fps
  }

  // mouseup at end
  const endTarget = document.elementFromPoint(endX, endY) || document.documentElement;
  dispatchPointerEvent(endTarget, 'pointerup', endX, endY);
  dispatchMouseEvent(endTarget, 'mouseup', endX, endY);

  return {
    success: true,
    from: { x: sx, y: sy },
    to: { x: endX, y: endY },
    steps: numSteps,
  };
}

async function cmdScroll(params) {
  const { selector, x, y, deltaX, deltaY } = params || {};

  let target;
  if (selector) {
    target = resolveElement(selector);
    if (!target) throw new Error(`Element not found: ${selector}`);
  } else {
    target = null; // use window
  }

  const dx = deltaX || 0;
  const dy = deltaY || 0;

  if (target) {
    target.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
  } else if (x != null && y != null) {
    window.scrollTo({ left: x, top: y, behavior: 'smooth' });
  } else {
    window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
  }

  await sleep(300); // Let scroll settle

  return {
    success: true,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

async function cmdSnapshot(_params) {
  const tree = buildAccessibilityTree(document.body, 0, 5);

  // Add Slides-specific info
  const slidesInfo = {
    currentSlide: SlidesHelpers.getCurrentSlideNumber(),
    totalSlides: SlidesHelpers.getTotalSlides(),
    toolbarButtons: SlidesHelpers.getToolbarLabels(),
    hasCanvas: !!SlidesHelpers.getCanvas(),
    hasSpeakerNotes: !!SlidesHelpers.getSpeakerNotes(),
  };

  return {
    tree,
    slidesInfo,
    url: window.location.href,
    title: document.title,
  };
}

function buildAccessibilityTree(root, depth, maxDepth) {
  if (depth >= maxDepth || !root) return null;

  const nodes = [];
  const children = root.children || [];

  for (const child of children) {
    if (!isVisible(child)) continue;

    const tag = child.tagName?.toLowerCase();
    if (['script', 'style', 'noscript', 'link', 'meta'].includes(tag)) continue;

    const role = child.getAttribute('role');
    const ariaLabel = child.getAttribute('aria-label');
    const ariaExpanded = child.getAttribute('aria-expanded');
    const ariaSelected = child.getAttribute('aria-selected');
    const ariaDisabled = child.getAttribute('aria-disabled');
    const text = getDirectTextContent(child).trim().slice(0, 100);
    const id = child.id || undefined;
    const className =
      typeof child.className === 'string' && child.className.trim()
        ? child.className.trim().split(/\s+/).slice(0, 3).join(' ')
        : undefined;

    const node = {
      tag,
      ...(role && { role }),
      ...(ariaLabel && { ariaLabel }),
      ...(ariaExpanded != null && { ariaExpanded }),
      ...(ariaSelected != null && { ariaSelected }),
      ...(ariaDisabled != null && { ariaDisabled }),
      ...(text && { text }),
      ...(id && { id }),
      ...(className && { className }),
    };

    const subtree = buildAccessibilityTree(child, depth + 1, maxDepth);
    if (subtree && subtree.length > 0) {
      node.children = subtree;
    }

    // Only include nodes that carry information
    if (role || ariaLabel || text || (subtree && subtree.length > 0) || tag === 'input' || tag === 'button' || tag === 'select' || tag === 'a') {
      nodes.push(node);
    }
  }

  return nodes.length > 0 ? nodes : null;
}

function getDirectTextContent(el) {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    }
  }
  return text;
}

function isVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
    // Could be position:fixed – double check
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') return false;
  }
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

async function cmdGetPageText(_params) {
  // Collect text from all visible elements
  const textParts = [];

  // Title
  textParts.push(`Title: ${document.title}`);

  // Google Slides specific: get slide content
  const canvas = SlidesHelpers.getCanvas();
  if (canvas) {
    const svgTexts = canvas.querySelectorAll('text, tspan, [class*="text"]');
    const slideText = Array.from(svgTexts)
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    if (slideText.length > 0) {
      textParts.push('--- Slide Content ---');
      textParts.push(slideText.join('\n'));
    }
  }

  // Speaker notes
  const notes = SlidesHelpers.getSpeakerNotes();
  if (notes) {
    const notesText = notes.textContent?.trim();
    if (notesText) {
      textParts.push('--- Speaker Notes ---');
      textParts.push(notesText);
    }
  }

  // General visible text
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.parentElement) return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement.tagName;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(node.parentElement)) return NodeFilter.FILTER_REJECT;
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const generalTexts = new Set();
  let textNode;
  while ((textNode = walker.nextNode())) {
    const t = textNode.textContent.trim();
    if (t.length > 1) generalTexts.add(t);
  }

  if (generalTexts.size > 0) {
    textParts.push('--- Page Text ---');
    textParts.push(Array.from(generalTexts).join('\n'));
  }

  return {
    text: textParts.join('\n'),
    slideNumber: SlidesHelpers.getCurrentSlideNumber(),
    totalSlides: SlidesHelpers.getTotalSlides(),
  };
}

async function cmdGetConsoleLogs(params) {
  const { clear, level } = params || {};

  let entries = [...consoleLogs];

  if (level) {
    entries = entries.filter((e) => e.level === level);
  }

  if (clear) {
    consoleLogs.length = 0;
  }

  return { logs: entries, count: entries.length };
}

async function cmdSelectOption(params) {
  const { selector, value, label, index } = params || {};
  if (!selector) throw new Error('Missing selector parameter');

  const el = resolveElement(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);

  if (el.tagName !== 'SELECT') {
    throw new Error(`Element is not a <select>: ${el.tagName}`);
  }

  if (index != null) {
    el.selectedIndex = index;
  } else if (value != null) {
    el.value = value;
  } else if (label != null) {
    const option = Array.from(el.options).find(
      (opt) => opt.textContent?.trim() === label,
    );
    if (!option) throw new Error(`Option with label "${label}" not found`);
    el.value = option.value;
  } else {
    throw new Error('Must provide value, label, or index');
  }

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  return {
    success: true,
    selectedValue: el.value,
    selectedText: el.options[el.selectedIndex]?.textContent?.trim(),
  };
}

async function cmdWaitSelector(params) {
  const { selector, timeout, visible } = params || {};
  if (!selector) throw new Error('Missing selector parameter');

  const timeoutMs = timeout || 10_000;
  const startTime = Date.now();

  // Immediate check
  const immediate = checkSelector(selector, visible);
  if (immediate) {
    return { success: true, found: true, element: elementDescription(immediate), elapsed: 0 };
  }

  // Poll with MutationObserver
  return new Promise((resolve) => {
    const pollInterval = 200;
    let timer;
    let observer;

    function cleanup() {
      clearTimeout(timer);
      clearInterval(poller);
      observer?.disconnect();
    }

    function check() {
      const el = checkSelector(selector, visible);
      if (el) {
        cleanup();
        resolve({
          success: true,
          found: true,
          element: elementDescription(el),
          elapsed: Date.now() - startTime,
        });
        return true;
      }
      return false;
    }

    // Timeout
    timer = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        found: false,
        error: `Timeout waiting for selector: ${selector}`,
        elapsed: timeoutMs,
      });
    }, timeoutMs);

    // Polling fallback
    const poller = setInterval(check, pollInterval);

    // MutationObserver for faster detection
    observer = new MutationObserver(() => {
      check();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'],
    });
  });
}

function checkSelector(selector, requireVisible) {
  const el = resolveElement(selector);
  if (!el) return null;
  if (requireVisible && !isVisible(el)) return null;
  return el;
}

// ---------------------------------------------------------------------------
// Announce content script ready
// ---------------------------------------------------------------------------

console.log('[MCP-CS] Google Slides MCP content script loaded on', window.location.href);
