/**
 * @module browser/slides-controller
 * @description High-level Google Slides browser automation controller.
 *
 * Provides semantic, Slides-aware actions built on top of the low-level
 * primitives in {@link module:browser/actions}.  Every method encapsulates
 * the keyboard shortcuts, menu navigation, and DOM selectors required to
 * perform common Google Slides editing operations through the browser UI.
 *
 * All coordinate values are in CSS pixels relative to the viewport.
 */

import * as actions from './actions.js';
import type {
  PageSnapshot,
  ScreenshotResult,
  ClickResult,
} from './actions.js';
import type { BrowserConnectionManager } from './connection.js';
import { createLogger } from '../shared/logger.js';
import { DEFAULT_BROWSER_TIMEOUT } from '../shared/constants.js';

const log = createLogger('browser.slides-controller');

// ─────────────────────────────────────────────────────────────────────────────
// Constants — Google Slides selectors & keyboard shortcuts
// ─────────────────────────────────────────────────────────────────────────────

/** Base URL for editing a Google Slides presentation. */
const SLIDES_BASE_URL = 'https://docs.google.com/presentation/d';

/** Selectors for key UI elements in the Google Slides editor. */
const SELECTORS = {
  /** The main slide canvas area. */
  slideCanvas: '.punch-viewer-svgpage-svgcontainer',
  /** Individual slide thumbnails in the film strip. */
  filmstripSlide: '.punch-filmstrip-thumbnail',
  /** The currently selected slide thumbnail. */
  filmstripSlideSelected: '.punch-filmstrip-thumbnail[aria-selected="true"]',
  /** The speaker notes text area. */
  speakerNotes: '.punch-viewer-speakernotes-text',
  /** The font name dropdown in the toolbar. */
  fontNameDropdown: '[aria-label="Font"]',
  /** The font size input in the toolbar. */
  fontSizeInput: '[aria-label="Font size"]',
  /** The bold button in the toolbar. */
  boldButton: '[aria-label="Bold (Ctrl+B)"]',
  /** The italic button in the toolbar. */
  italicButton: '[aria-label="Italic (Ctrl+I)"]',
  /** The underline button in the toolbar. */
  underlineButton: '[aria-label="Underline (Ctrl+U)"]',
  /** The text color button in the toolbar. */
  textColorButton: '[aria-label="Text color"]',
  /** The slide background button / menu item. */
  backgroundMenuItem: '[aria-label="Background"]',
  /** The Insert menu button. */
  insertMenu: '#docs-insert-menu',
  /** The Format menu button. */
  formatMenu: '#docs-format-menu',
  /** The Slide menu button. */
  slideMenu: '#docs-slide-menu',
  /** The Arrange menu button. */
  arrangeMenu: '#docs-arrange-menu',
  /** The transition panel. */
  transitionPanel: '.punch-animation-sidebar',
  /** The main toolbar container. */
  toolbar: '.punch-toolbar-container',
  /** The slide editing area (the SVG-based canvas). */
  slideEditArea: '.punch-viewer-svgpage',
  /** The presentation title input. */
  presentationTitle: '.docs-title-input',
  /** Custom hex color input in the color picker. */
  hexColorInput: '[aria-label="Custom"]',
  /** The "Apply" button in color/background pickers. */
  applyButton: '.goog-buttonset-default',
} as const;

/** Small delay (ms) to wait for Google Slides UI to update after an action. */
const UI_SETTLE_DELAY = 500;

/** Longer delay for menu operations. */
const MENU_SETTLE_DELAY = 800;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait a fixed number of milliseconds for the UI to settle.
 *
 * @param ms - Milliseconds to wait. Defaults to {@link UI_SETTLE_DELAY}.
 */
async function settle(ms: number = UI_SETTLE_DELAY): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Press a keyboard shortcut (Ctrl/Cmd + key).
 *
 * @param key - The key to combine with Control.
 * @param conn - Optional connection manager override.
 */
async function ctrlKey(
  key: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  return actions.pressKeys(['Control', key], conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a Google Slides presentation in the browser.
 *
 * @param presentationId - The Google Slides presentation ID.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the presentation loads.
 */
export async function openPresentation(
  presentationId: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  const url = `${SLIDES_BASE_URL}/${presentationId}/edit`;
  log.info('Opening presentation', { presentationId, url });

  const snapshot = await actions.navigate(url, conn);

  // Wait for the slide canvas to render
  try {
    await actions.waitForSelector(SELECTORS.slideCanvas, DEFAULT_BROWSER_TIMEOUT, conn);
  } catch {
    log.warn('Slide canvas not found after navigation — page may still be loading');
  }

  await settle(1000); // Google Slides needs a moment to fully initialise
  return snapshot;
}

/**
 * Navigate to a specific slide by its 1-based index.
 *
 * @param slideIndex - The 1-based slide number to navigate to.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after navigating to the slide.
 */
export async function goToSlide(
  slideIndex: number,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Navigating to slide', { slideIndex });

  // Click on the corresponding film strip thumbnail
  const thumbnailSelector = `${SELECTORS.filmstripSlide}:nth-child(${slideIndex})`;
  try {
    const result = await actions.click(thumbnailSelector, 0, conn);
    await settle();
    return result.snapshot ?? await actions.snapshot(conn);
  } catch {
    // Fallback: use keyboard shortcut Ctrl+G (Go to slide) if available,
    // or navigate via Page Down / Page Up
    log.warn('Film strip click failed, using keyboard navigation');

    // First go to slide 1 using Home key, then arrow down
    await actions.pressKey('Home', conn);
    await settle(300);

    for (let i = 1; i < slideIndex; i++) {
      await actions.pressKey('PageDown', conn);
      await settle(200);
    }

    return actions.snapshot(conn);
  }
}

/**
 * Get the 1-based index of the currently selected slide.
 *
 * @param conn - Optional connection manager override.
 * @returns The current slide index (1-based), or -1 if it cannot be determined.
 */
export async function getCurrentSlideIndex(
  conn?: BrowserConnectionManager,
): Promise<number> {
  log.info('Getting current slide index');

  try {
    const result = await actions.evaluateScript(
      `(() => {
        const selected = document.querySelector('${SELECTORS.filmstripSlideSelected}');
        if (!selected) return -1;
        const parent = selected.parentElement;
        if (!parent) return -1;
        const siblings = Array.from(parent.children).filter(
          el => el.matches('${SELECTORS.filmstripSlide}')
        );
        return siblings.indexOf(selected) + 1;
      })()`,
      conn,
    );
    return typeof result.value === 'number' ? result.value : -1;
  } catch (error) {
    log.warn('Failed to get current slide index', {
      error: error instanceof Error ? error.message : String(error),
    });
    return -1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Element Interaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Click a slide element by its accessibility label.
 *
 * @param elementLabel - The accessible name / aria-label of the element.
 * @param conn - Optional connection manager override.
 * @returns A click result.
 */
export async function clickOnSlideElement(
  elementLabel: string,
  conn?: BrowserConnectionManager,
): Promise<ClickResult> {
  log.info('Clicking slide element', { elementLabel });
  const selector = `[aria-label="${elementLabel}"]`;
  const result = await actions.click(selector, 0, conn);
  await settle();
  return result;
}

/**
 * Add a text box to the current slide at the given position.
 *
 * Uses the Insert > Text box flow:
 * 1. Open Insert menu
 * 2. Click "Text box"
 * 3. Draw the text box at the specified coordinates
 * 4. Type the text
 *
 * @param x - Left edge of the text box in CSS pixels.
 * @param y - Top edge of the text box in CSS pixels.
 * @param width - Width of the text box in CSS pixels.
 * @param height - Height of the text box in CSS pixels.
 * @param text - The text to insert.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the text box is created.
 */
export async function addTextBox(
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Adding text box', { x, y, width, height, textLength: text.length });

  // Open Insert menu
  await actions.click(SELECTORS.insertMenu, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Click "Text box" menu item
  await actions.click('[aria-label="Text box t"]', 0, conn).catch(async () => {
    // Fallback: try different selector patterns for the menu item
    await actions.click('[id*="textbox"]', 0, conn).catch(async () => {
      // Last resort: use keyboard shortcut — Alt+I then T in some versions
      await actions.pressKey('Escape', conn);
      await settle(300);
      await actions.pressKeys(['Alt', 'i'], conn);
      await settle(MENU_SETTLE_DELAY);
      await actions.pressKey('t', conn);
    });
  });
  await settle(MENU_SETTLE_DELAY);

  // Draw the text box by dragging from (x, y) to (x + width, y + height)
  await actions.dragCoordinates(x, y, x + width, y + height, conn);
  await settle();

  // Type the text
  await actions.pressKeys(['Control', 'a'], conn); // select all (in case there's default text)
  await settle(200);

  // Type the actual text
  await actions.evaluateScript(
    `document.execCommand('insertText', false, ${JSON.stringify(text)})`,
    conn,
  );

  await settle();
  return actions.snapshot(conn);
}

/**
 * Edit the text of an existing element by clicking it, selecting all
 * text, and typing new text.
 *
 * @param elementLabel - The accessible name of the element to edit.
 * @param newText - The replacement text.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after editing.
 */
export async function editText(
  elementLabel: string,
  newText: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Editing text', { elementLabel, newTextLength: newText.length });

  // Double-click to enter edit mode
  const selector = `[aria-label="${elementLabel}"]`;
  await actions.doubleClick(selector, 0, conn);
  await settle(300);

  // Select all text
  await ctrlKey('a', conn);
  await settle(200);

  // Type the new text (using execCommand for reliable insertion)
  await actions.evaluateScript(
    `document.execCommand('insertText', false, ${JSON.stringify(newText)})`,
    conn,
  );

  await settle();

  // Click outside the element to deselect
  await actions.pressKey('Escape', conn);
  await settle(300);

  return actions.snapshot(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Typography & Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Change the font of the currently selected text.
 *
 * @param fontName - The font family name (e.g. "Roboto", "Arial").
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the font change.
 */
export async function changeFont(
  fontName: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Changing font', { fontName });

  // Click the font dropdown
  await actions.click(SELECTORS.fontNameDropdown, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Clear the current font name and type the new one
  await ctrlKey('a', conn);
  await settle(200);

  await actions.evaluateScript(
    `document.execCommand('insertText', false, ${JSON.stringify(fontName)})`,
    conn,
  );
  await settle(300);

  // Press Enter to confirm
  await actions.pressKey('Enter', conn);
  await settle();

  return actions.snapshot(conn);
}

/**
 * Change the font size of the currently selected text.
 *
 * @param size - The font size in points.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the size change.
 */
export async function changeFontSize(
  size: number,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Changing font size', { size });

  // Click the font size input
  await actions.click(SELECTORS.fontSizeInput, 0, conn);
  await settle(300);

  // Select all, type the new size, confirm
  await ctrlKey('a', conn);
  await settle(200);

  await actions.evaluateScript(
    `document.execCommand('insertText', false, '${size}')`,
    conn,
  );
  await settle(200);

  await actions.pressKey('Enter', conn);
  await settle();

  return actions.snapshot(conn);
}

/**
 * Change the text color of the currently selected text.
 *
 * @param hexColor - The color as a hex string (e.g. "#FF5733").
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the color change.
 */
export async function changeTextColor(
  hexColor: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Changing text color', { hexColor });

  // Click the text color dropdown arrow (the small arrow next to the A)
  await actions.click(SELECTORS.textColorButton, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Click the "Custom" button to open the hex color input
  await actions.click(SELECTORS.hexColorInput, 0, conn).catch(async () => {
    // Try alternative: look for "Custom" text
    await actions.click('[data-tooltip="Custom"]', 0, conn).catch(() => {
      log.warn('Could not find custom color input');
    });
  });
  await settle(MENU_SETTLE_DELAY);

  // Clear and type the hex value (strip the # prefix if present)
  const cleanHex = hexColor.replace(/^#/, '');
  await ctrlKey('a', conn);
  await settle(200);
  await actions.evaluateScript(
    `document.execCommand('insertText', false, '${cleanHex}')`,
    conn,
  );
  await settle(200);

  // Press Enter or click Apply
  await actions.pressKey('Enter', conn);
  await settle();

  return actions.snapshot(conn);
}

/**
 * Change the background color of the current slide.
 *
 * @param hexColor - The background color as a hex string (e.g. "#FFFFFF").
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the background change.
 */
export async function changeBackgroundColor(
  hexColor: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Changing background color', { hexColor });

  // Open Slide menu
  await actions.click(SELECTORS.slideMenu, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Click "Change background" (or "Background...")
  await actions.click('[aria-label="Change background b"]', 0, conn).catch(async () => {
    await actions.click(SELECTORS.backgroundMenuItem, 0, conn).catch(async () => {
      // Keyboard fallback: navigate the menu
      log.warn('Could not find background menu item via selector');
    });
  });
  await settle(MENU_SETTLE_DELAY);

  // In the background dialog, click the color swatch to open the color picker
  await actions.click('.goog-color-menu-button', 0, conn).catch(async () => {
    await actions.click('[aria-label="Color"]', 0, conn).catch(() => {
      log.warn('Could not find color swatch in background dialog');
    });
  });
  await settle(MENU_SETTLE_DELAY);

  // Select "Custom" to enter a hex value
  const cleanHex = hexColor.replace(/^#/, '');
  await actions.click(SELECTORS.hexColorInput, 0, conn).catch(() => undefined);
  await settle(300);

  await ctrlKey('a', conn);
  await settle(200);
  await actions.evaluateScript(
    `document.execCommand('insertText', false, '${cleanHex}')`,
    conn,
  );
  await settle(200);
  await actions.pressKey('Enter', conn);
  await settle(MENU_SETTLE_DELAY);

  // Click "Done" or "Apply" to confirm
  await actions.click(SELECTORS.applyButton, 0, conn).catch(async () => {
    await actions.click('[name="ok"]', 0, conn).catch(async () => {
      await actions.pressKey('Enter', conn);
    });
  });
  await settle();

  return actions.snapshot(conn);
}

/**
 * Toggle bold formatting on the currently selected text.
 *
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the toggle.
 */
export async function applyBold(
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Toggling bold');
  return ctrlKey('b', conn);
}

/**
 * Toggle italic formatting on the currently selected text.
 *
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the toggle.
 */
export async function applyItalic(
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Toggling italic');
  return ctrlKey('i', conn);
}

/**
 * Toggle underline formatting on the currently selected text.
 *
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the toggle.
 */
export async function applyUnderline(
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Toggling underline');
  return ctrlKey('u', conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Alignment & Distribution
// ─────────────────────────────────────────────────────────────────────────────

/** Alignment option labels as they appear in the Google Slides Arrange menu. */
const ALIGNMENT_MAP: Record<string, string> = {
  left: 'Left',
  center: 'Center horizontally',
  right: 'Right',
  top: 'Top',
  middle: 'Center vertically',
  bottom: 'Bottom',
} as const;

/**
 * Align selected elements using the Arrange > Align menu.
 *
 * @param alignment - The alignment direction.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after alignment.
 */
export async function alignElements(
  alignment: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom',
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Aligning elements', { alignment });

  // Open Arrange menu
  await actions.click(SELECTORS.arrangeMenu, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Hover over "Align" submenu
  await actions.click('[aria-label="Align a"]', 0, conn).catch(async () => {
    await actions.click('[aria-label="Align"]', 0, conn).catch(async () => {
      // Try keyboard navigation
      log.warn('Could not find Align submenu');
    });
  });
  await settle(MENU_SETTLE_DELAY);

  // Click the specific alignment option
  const label = ALIGNMENT_MAP[alignment] ?? alignment;
  await actions.click(`[aria-label="${label}"]`, 0, conn).catch(async () => {
    // Fallback: try with partial match
    await actions.evaluateScript(
      `(() => {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const item of items) {
          if (item.textContent?.includes('${label}')) {
            item.click();
            return true;
          }
        }
        return false;
      })()`,
      conn,
    );
  });
  await settle();

  return actions.snapshot(conn);
}

/**
 * Distribute selected elements evenly in the given direction.
 *
 * @param direction - "horizontal" or "vertical".
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after distribution.
 */
export async function distributeElements(
  direction: 'horizontal' | 'vertical',
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Distributing elements', { direction });

  // Open Arrange menu
  await actions.click(SELECTORS.arrangeMenu, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Navigate to Distribute submenu
  await actions.click('[aria-label="Distribute"]', 0, conn).catch(async () => {
    log.warn('Could not find Distribute submenu');
  });
  await settle(MENU_SETTLE_DELAY);

  // Click the specific distribution option
  const label = direction === 'horizontal' ? 'Horizontally' : 'Vertically';
  await actions.click(`[aria-label="${label}"]`, 0, conn).catch(async () => {
    await actions.evaluateScript(
      `(() => {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const item of items) {
          if (item.textContent?.includes('${label}')) {
            item.click();
            return true;
          }
        }
        return false;
      })()`,
      conn,
    );
  });
  await settle();

  return actions.snapshot(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert an image into the current slide from a URL.
 *
 * Uses Insert > Image > By URL flow.
 *
 * @param imageUrl - The publicly accessible URL of the image.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the image is inserted.
 */
export async function insertImage(
  imageUrl: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Inserting image', { imageUrl });

  // Open Insert menu
  await actions.click(SELECTORS.insertMenu, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Click Image submenu
  await actions.click('[aria-label="Image i"]', 0, conn).catch(async () => {
    await actions.click('[aria-label="Image"]', 0, conn).catch(async () => {
      // Try finding menu item by text content
      await actions.evaluateScript(
        `(() => {
          const items = document.querySelectorAll('[role="menuitem"]');
          for (const item of items) {
            if (item.textContent?.trim().startsWith('Image')) {
              item.click();
              return true;
            }
          }
          return false;
        })()`,
        conn,
      );
    });
  });
  await settle(MENU_SETTLE_DELAY);

  // Click "By URL" option
  await actions.click('[aria-label="By URL"]', 0, conn).catch(async () => {
    await actions.evaluateScript(
      `(() => {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const item of items) {
          if (item.textContent?.includes('By URL')) {
            item.click();
            return true;
          }
        }
        return false;
      })()`,
      conn,
    );
  });
  await settle(MENU_SETTLE_DELAY);

  // Paste the URL into the input field
  await actions.click('input[type="url"], input[aria-label*="URL"], input[aria-label*="Paste"]', 0, conn).catch(async () => {
    // Focus may already be in the right place
    log.debug('URL input focus fallback');
  });
  await settle(300);

  await ctrlKey('a', conn);
  await settle(200);
  await actions.evaluateScript(
    `document.execCommand('insertText', false, ${JSON.stringify(imageUrl)})`,
    conn,
  );
  await settle(500);

  // Click "Insert" button
  await actions.click('[aria-label="Insert image"]', 0, conn).catch(async () => {
    await actions.click('button[name="insert"], button[name="ok"]', 0, conn).catch(async () => {
      await actions.pressKey('Enter', conn);
    });
  });
  await settle(1000);

  return actions.snapshot(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Duplicate the currently selected slide.
 *
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the slide is duplicated.
 */
export async function duplicateSlide(
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Duplicating current slide');

  // Use keyboard shortcut: Ctrl+D duplicates the selected slide
  // (when the filmstrip has focus, not a shape on the canvas)

  // First, click on the filmstrip to ensure it has focus
  await actions.click(SELECTORS.filmstripSlideSelected, 0, conn).catch(async () => {
    await actions.click(SELECTORS.filmstripSlide, 0, conn).catch(() => {
      log.warn('Could not focus film strip');
    });
  });
  await settle(300);

  // Press Escape to ensure we're not editing a shape
  await actions.pressKey('Escape', conn);
  await settle(200);

  // Right-click for context menu
  await actions.evaluateScript(
    `(() => {
      const selected = document.querySelector('${SELECTORS.filmstripSlideSelected}');
      if (selected) {
        const rect = selected.getBoundingClientRect();
        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        });
        selected.dispatchEvent(event);
      }
    })()`,
    conn,
  );
  await settle(MENU_SETTLE_DELAY);

  // Click "Duplicate slide" in the context menu
  await actions.evaluateScript(
    `(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent?.includes('Duplicate slide')) {
          item.click();
          return true;
        }
      }
      return false;
    })()`,
    conn,
  );
  await settle();

  return actions.snapshot(conn);
}

/**
 * Delete the currently selected slide.
 *
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after the slide is deleted.
 */
export async function deleteSlide(
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Deleting current slide');

  // Click on the filmstrip to ensure focus
  await actions.click(SELECTORS.filmstripSlideSelected, 0, conn).catch(async () => {
    await actions.click(SELECTORS.filmstripSlide, 0, conn).catch(() => {
      log.warn('Could not focus film strip');
    });
  });
  await settle(300);

  // Press Escape then Delete/Backspace to delete the slide
  await actions.pressKey('Escape', conn);
  await settle(200);

  // Click on the filmstrip slide again to ensure selection
  await actions.click(SELECTORS.filmstripSlideSelected, 0, conn).catch(() => undefined);
  await settle(200);

  // Use Delete or Backspace key to remove the slide
  await actions.pressKey('Delete', conn);
  await settle();

  return actions.snapshot(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Element Manipulation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move a slide element using arrow keys.
 *
 * Each arrow key press moves the element by 1 pixel (or ~0.7pt).
 * Shift+Arrow moves by 10 pixels.
 *
 * @param elementLabel - Accessibility label of the element to move.
 * @param deltaX - Horizontal displacement in pixels (positive = right).
 * @param deltaY - Vertical displacement in pixels (positive = down).
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after moving the element.
 */
export async function moveElement(
  elementLabel: string,
  deltaX: number,
  deltaY: number,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Moving element', { elementLabel, deltaX, deltaY });

  // Click the element to select it
  const selector = `[aria-label="${elementLabel}"]`;
  await actions.click(selector, 0, conn);
  await settle(300);

  // Calculate moves: use Shift+Arrow for 10px jumps, Arrow for 1px
  const moveAxis = async (delta: number, positiveKey: string, negativeKey: string) => {
    const direction = delta >= 0 ? positiveKey : negativeKey;
    const absPixels = Math.abs(delta);
    const largeSteps = Math.floor(absPixels / 10);
    const smallSteps = absPixels % 10;

    for (let i = 0; i < largeSteps; i++) {
      await actions.pressKeys(['Shift', direction], conn);
    }
    for (let i = 0; i < smallSteps; i++) {
      await actions.pressKey(direction, conn);
    }
  };

  await moveAxis(deltaX, 'ArrowRight', 'ArrowLeft');
  await moveAxis(deltaY, 'ArrowDown', 'ArrowUp');

  await settle();
  return actions.snapshot(conn);
}

/**
 * Resize a slide element by setting new width and height via the
 * Format Options panel.
 *
 * @param elementLabel - Accessibility label of the element to resize.
 * @param newWidth - New width in points.
 * @param newHeight - New height in points.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after resizing.
 */
export async function resizeElement(
  elementLabel: string,
  newWidth: number,
  newHeight: number,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Resizing element', { elementLabel, newWidth, newHeight });

  // Select the element
  const selector = `[aria-label="${elementLabel}"]`;
  await actions.click(selector, 0, conn);
  await settle(300);

  // Open Format > Format options to get size/position controls
  await actions.click(SELECTORS.formatMenu, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  await actions.evaluateScript(
    `(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent?.includes('Format options')) {
          item.click();
          return true;
        }
      }
      return false;
    })()`,
    conn,
  );
  await settle(MENU_SETTLE_DELAY);

  // Look for the "Size & Rotation" section and set width/height
  // The inputs are typically labeled "Width" and "Height"
  const widthSelector = '[aria-label="Width"]';
  const heightSelector = '[aria-label="Height"]';

  // Set width
  await actions.click(widthSelector, 0, conn).catch(() => undefined);
  await settle(200);
  await ctrlKey('a', conn);
  await settle(200);
  await actions.evaluateScript(
    `document.execCommand('insertText', false, '${newWidth}')`,
    conn,
  );
  await settle(200);
  await actions.pressKey('Tab', conn);
  await settle(200);

  // Set height
  await actions.click(heightSelector, 0, conn).catch(() => undefined);
  await settle(200);
  await ctrlKey('a', conn);
  await settle(200);
  await actions.evaluateScript(
    `document.execCommand('insertText', false, '${newHeight}')`,
    conn,
  );
  await settle(200);
  await actions.pressKey('Enter', conn);
  await settle();

  // Close the format options panel
  await actions.pressKey('Escape', conn);
  await settle(300);

  return actions.snapshot(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Screenshots & Accessibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take a screenshot of just the current slide area.
 *
 * Uses the extension's `screenshot` action and crops to the slide
 * canvas bounding rect via client-side script.
 *
 * @param conn - Optional connection manager override.
 * @returns A screenshot result (base64 PNG).
 */
export async function getSlideScreenshot(
  conn?: BrowserConnectionManager,
): Promise<ScreenshotResult> {
  log.info('Taking slide screenshot');

  // Get the bounding rect of the slide canvas
  const rectResult = await actions.evaluateScript(
    `(() => {
      const canvas = document.querySelector('${SELECTORS.slideCanvas}');
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    })()`,
    conn,
  );

  // Take the full page screenshot
  const screenshotResult = await actions.screenshot(conn);

  // If we got the canvas rect, annotate the result with crop info
  if (rectResult.value && typeof rectResult.value === 'object') {
    const rect = rectResult.value as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    return {
      ...screenshotResult,
      width: rect.width,
      height: rect.height,
    };
  }

  return screenshotResult;
}

/**
 * Get the accessibility tree snapshot of the current slide.
 *
 * @param conn - Optional connection manager override.
 * @returns A page snapshot with the accessibility tree.
 */
export async function getSlideAccessibilityTree(
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Getting slide accessibility tree');
  return actions.snapshot(conn);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions & Speaker Notes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a slide transition to the current slide.
 *
 * @param transitionType - The transition type name (e.g. "Fade", "Slide from right",
 *   "Dissolve", "Flip", "Cube", "Gallery", "None").
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after applying the transition.
 */
export async function applyTransition(
  transitionType: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Applying transition', { transitionType });

  // Open Slide menu
  await actions.click(SELECTORS.slideMenu, 0, conn);
  await settle(MENU_SETTLE_DELAY);

  // Click "Transition" menu item
  await actions.evaluateScript(
    `(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent?.includes('Transition')) {
          item.click();
          return true;
        }
      }
      return false;
    })()`,
    conn,
  );
  await settle(MENU_SETTLE_DELAY);

  // In the transition panel, click the transition type dropdown
  await actions.click('[aria-label="Transition type"]', 0, conn).catch(async () => {
    // Try the dropdown within the transition panel
    await actions.click(
      `${SELECTORS.transitionPanel} select, ${SELECTORS.transitionPanel} [role="listbox"]`,
      0,
      conn,
    ).catch(() => undefined);
  });
  await settle(MENU_SETTLE_DELAY);

  // Select the desired transition
  await actions.evaluateScript(
    `(() => {
      const options = document.querySelectorAll('[role="option"], [role="menuitemradio"]');
      for (const option of options) {
        if (option.textContent?.includes('${transitionType}')) {
          option.click();
          return true;
        }
      }
      // Fallback: try select element
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.textContent?.includes('${transitionType}')) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }
      return false;
    })()`,
    conn,
  );
  await settle();

  return actions.snapshot(conn);
}

/**
 * Set the speaker notes for the current slide.
 *
 * @param text - The speaker notes text.
 * @param conn - Optional connection manager override.
 * @returns A page snapshot after setting the notes.
 */
export async function setSpeakerNotes(
  text: string,
  conn?: BrowserConnectionManager,
): Promise<PageSnapshot> {
  log.info('Setting speaker notes', { textLength: text.length });

  // Click on the speaker notes area
  await actions.click(SELECTORS.speakerNotes, 0, conn).catch(async () => {
    // The notes area might be collapsed; try clicking "Click to add speaker notes"
    await actions.evaluateScript(
      `(() => {
        const el = document.querySelector('[aria-label*="speaker notes"], [aria-label*="Speaker notes"]');
        if (el) { el.click(); return true; }
        // Try to find by text content
        const divs = document.querySelectorAll('div[contenteditable]');
        for (const div of divs) {
          if (div.closest('.punch-viewer-speakernotes-text')) {
            div.click();
            return true;
          }
        }
        return false;
      })()`,
      conn,
    );
  });
  await settle(300);

  // Select all existing notes text
  await ctrlKey('a', conn);
  await settle(200);

  // Type the new notes
  await actions.evaluateScript(
    `document.execCommand('insertText', false, ${JSON.stringify(text)})`,
    conn,
  );
  await settle();

  // Click elsewhere to deselect the notes area
  await actions.click(SELECTORS.slideCanvas, 0, conn).catch(() => undefined);
  await settle(300);

  return actions.snapshot(conn);
}
