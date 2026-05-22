/**
 * Chat Log Module - dice-link-companion
 * Forwards Foundry chat messages to DLA via QWebChannel.
 * Uses Foundry's own CSS — system-agnostic.
 */

import { sendMessage, getConnectionStatus, setChatInteractionCallback, setChatCommandCallback, setChatVisibilityCallback } from "./qwebchannel-client.js";
import { debug, debugChatLog } from "./debug.js";

// ============================================================================
// OBSERVER + INTERACTION MAPS
// ============================================================================

// messageId → { observer, debounceTimer, timeoutTimer }
const _observerMap = new Map();

// messageId → Map<dlaId (number), real DOM element>
const _interactionMap = new Map();

const DEBOUNCE_MS = 500;
const OBSERVER_TIMEOUT_MS = 15000;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Rewrite relative src/href attributes to absolute URLs using the Foundry origin.
 */
function makeAbsolute(html) {
  const origin = window.location.origin;
  return html.replace(
    /\b(src|href|data-src)="(?!https?:\/\/|\/\/|data:|#|javascript:)([^"]*)"/g,
    (match, attr, path) => {
      const absolute = path.startsWith("/") ? `${origin}${path}` : `${origin}/${path}`;
      return `${attr}="${absolute}"`;
    }
  );
}

/**
 * Number every interactive element inside a card's li DOM element and store
 * a map of dlaId → real element for later interaction forwarding.
 * Returns the complete outerHTML of the numbered li with absolute URLs applied.
 */
function numberAndSerialize(messageId, li) {
  li.querySelectorAll('[data-dla-id]').forEach(el => el.removeAttribute('data-dla-id'));

  const elementMap = new Map();
  let counter = 1;

  li.querySelectorAll('button, select, input, details > summary, [data-action], .collapsible > label, .dice-result')
    .forEach(el => {
      const id = counter++;
      el.setAttribute('data-dla-id', String(id));
      elementMap.set(id, el);
    });

  _interactionMap.set(messageId, elementMap);
  return makeAbsolute(li.outerHTML);
}

/**
 * Extract structured roll data from a Foundry ChatMessage for stats recording.
 * Returns null if the message contains no dice rolls.
 */
function extractRollData(message) {
  if (!message?.rolls?.length) return null;
  try {
    return {
      speaker: message.speaker?.alias || null,
      flavor: message.flavor || null,
      rolls: message.rolls.map(roll => ({
        formula: roll.formula,
        total: roll.total,
        dice: (roll.dice || []).map(die => ({
          faces: die.faces,
          results: (die.results || []).map(r => ({
            result: r.result,
            active: r.active === true,
            discarded: r.discarded === true
          }))
        }))
      }))
    };
  } catch (e) {
    return null;
  }
}

/**
 * Serialize and send the current state of a card to DLA.
 */
function sendCard(messageId, li, rollData) {
  const html = numberAndSerialize(messageId, li);
  sendMessage({ type: "chatMessage", messageId, html, rollData: rollData ?? null });
}

// ============================================================================
// MUTATION OBSERVER MANAGEMENT
// ============================================================================

function disconnectObserver(messageId) {
  const state = _observerMap.get(messageId);
  if (!state) return;
  clearTimeout(state.debounceTimer);
  clearTimeout(state.timeoutTimer);
  state.observer.disconnect();
  _observerMap.delete(messageId);
}

/**
 * Attach (or reactivate) a MutationObserver for a card's li element.
 * Safe to call multiple times — resets timers if the observer is still running.
 * Disconnects automatically after OBSERVER_TIMEOUT_MS of no mutations.
 */
function attachObserver(messageId, li, rollData) {
  let state = _observerMap.get(messageId);

  const resetTimers = () => {
    clearTimeout(state.debounceTimer);
    clearTimeout(state.timeoutTimer);
    state.debounceTimer = setTimeout(() => sendCard(messageId, li, state.rollData), DEBOUNCE_MS);
    state.timeoutTimer = setTimeout(() => disconnectObserver(messageId), OBSERVER_TIMEOUT_MS);
  };

  if (state) {
    if (rollData != null) state.rollData = rollData;
    resetTimers();
    return;
  }

  const observer = new MutationObserver((mutations) => {
    const realMutations = mutations.filter(m =>
      !(m.type === 'attributes' && m.attributeName === 'data-dla-id')
    );
    if (realMutations.length === 0) return;
    resetTimers();
  });
  observer.observe(li, { childList: true, subtree: true, attributes: true, characterData: true });

  state = { observer, debounceTimer: null, timeoutTimer: null, rollData: rollData ?? null };
  _observerMap.set(messageId, state);

  // Start the idle timeout immediately
  state.timeoutTimer = setTimeout(() => disconnectObserver(messageId), OBSERVER_TIMEOUT_MS);
}

// ============================================================================
// CHAT INTERACTION (DLA → DLC)
// ============================================================================

/**
 * Handle a chatInteraction signal from DLA.
 * Finds the real Foundry DOM element, reactivates the observer so DLA
 * receives the mutation response, then fires the event.
 */
function handleChatInteraction({ messageId, dlaId, event, value }) {
  const elementMap = _interactionMap.get(messageId);
  if (!elementMap) {
    debugChatLog(`chatInteraction: no element map for message ${messageId}`);
    return;
  }

  const el = elementMap.get(dlaId);
  if (!el) {
    debugChatLog(`chatInteraction: no element dlaId=${dlaId} in message ${messageId}`);
    return;
  }

  // Reactivate observer before firing so the mutation response is captured
  const li = el.closest('li.chat-message');
  if (li) attachObserver(messageId, li);

  if (el.classList.contains('dice-result')) {
    const diceRoll = el.closest('.dice-roll');
    if (diceRoll) {
      if (diceRoll.dataset.action === 'expandRoll') {
        diceRoll.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        diceRoll.classList.toggle('expanded');
      }
    }
    debugChatLog(`chatInteraction: fired dice expand on dlaId=${dlaId} in message ${messageId}`);
    return;
  }

  if (event === 'change') {
    if (el.tagName === 'SELECT') {
      el.value = value;
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = value;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  debugChatLog(`chatInteraction: fired ${event} on dlaId=${dlaId} in message ${messageId}`);
}

// ============================================================================
// CSS SETUP
// ============================================================================

/**
 * Rewrite relative url() and bare @import path references in CSS text to absolute URLs.
 * baseUrl should be the URL of the CSS file being processed so that relative paths
 * (e.g. "fonts/foo.woff2" inside "/systems/dnd5e/dnd5e.css") resolve correctly.
 * Falls back to origin-root resolution when baseUrl is not provided (inline <style> blocks).
 */
function makeAbsoluteCss(css, origin, baseUrl) {
  const resolveRelative = (path) => {
    if (baseUrl) {
      try { return new URL(path, baseUrl).href; } catch(e) {}
    }
    return path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`;
  };
  css = css.replace(
    /url\((['"]?)(?!https?:\/\/|\/\/|data:|#)([^'")\s]+)\1\)/g,
    (match, quote, path) => `url(${quote}${resolveRelative(path)}${quote})`
  );
  css = css.replace(
    /@import\s+(['"])(?!https?:\/\/|\/\/)([^'"]+)\1/g,
    (match, quote, path) => `@import ${quote}${resolveRelative(path)}${quote}`
  );
  return css;
}

/**
 * Scan CSS text for woff2 font URLs, fetch them same-origin (DLC runs on Foundry's
 * origin so CORS never blocks this), and replace each URL with a base64 data URI.
 * This makes @font-face rules self-contained so DLA doesn't need to download
 * fonts cross-origin (where CORS blocks it even with --disable-web-security).
 */
async function embedFontDataUris(css) {
  const fontFaceRegex = /@font-face\s*\{[^}]+\}/gi;
  const woff2UrlRegex = /url\((['"]?)(https?:\/\/[^'")\s]+\.woff2)\1\)/i;
  const uniqueUrls = new Set();
  let m;
  while ((m = fontFaceRegex.exec(css)) !== null) {
    const urlMatch = woff2UrlRegex.exec(m[0]);
    if (urlMatch) uniqueUrls.add(urlMatch[2]);
  }
  if (uniqueUrls.size === 0) return css;

  const urlToDataUri = new Map();
  for (const url of uniqueUrls) {
    const shortName = url.split('/').pop();
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        debugChatLog(`embedFontDataUris: fetch failed ${resp.status} for ${shortName}`);
        continue;
      }
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
      }
      urlToDataUri.set(url, `data:font/woff2;base64,${btoa(binary)}`);
      debugChatLog(`embedFontDataUris: embedded ${shortName} (${bytes.length} bytes)`);
    } catch (e) {
      debugChatLog(`embedFontDataUris: error for ${shortName}: ${String(e)}`);
    }
  }
  if (urlToDataUri.size === 0) return css;

  return css.replace(
    /url\((['"]?)(https?:\/\/[^'")\s]+\.woff2)\1\)/g,
    (match, quote, url) => {
      const dataUri = urlToDataUri.get(url);
      return dataUri ? `url(${dataUri})` : match;
    }
  );
}

/**
 * Collect embedded CSS blocks, custom property values, and body classes
 * from the Foundry page, then send them to DLA so it can replicate Foundry's styling.
 *
 * Foundry's CSS lives in <style> elements (no href). The only <link> stylesheet
 * is DLC's own module CSS, which is irrelevant for chat card rendering.
 */
async function sendChatSetup() {
  const origin = window.location.origin;

  const styleTexts = [];

  // Collect inline <style> element text
  for (const sheet of document.styleSheets) {
    if (sheet.href) continue;
    try {
      const text = sheet.ownerNode?.textContent;
      if (text && text.trim()) {
        styleTexts.push(await embedFontDataUris(makeAbsoluteCss(text.trim(), origin)));
      }
    } catch (e) {
      // Skip inaccessible sheets
    }
  }

  // Fetch same-origin <link> stylesheets (foundry2.css and any others)
  for (const sheet of document.styleSheets) {
    if (!sheet.href) continue;
    const sheetPath = (() => { try { return new URL(sheet.href).pathname; } catch(e) { return sheet.href; } })();
    try {
      if (new URL(sheet.href).origin !== origin) {
        debugChatLog(`sendChatSetup: skipping cross-origin sheet: ${sheetPath}`);
        continue;
      }
      const response = await fetch(sheet.href);
      if (!response.ok) {
        debugChatLog(`sendChatSetup: fetch failed (${response.status}) for: ${sheetPath}`);
        continue;
      }
      const text = await response.text();
      if (text && text.trim()) {
        styleTexts.push(await embedFontDataUris(makeAbsoluteCss(text.trim(), origin, sheet.href)));
        debugChatLog(`sendChatSetup: fetched ${sheetPath} (${text.length} bytes)`);
      } else {
        debugChatLog(`sendChatSetup: empty response for: ${sheetPath}`);
      }
    } catch (e) {
      debugChatLog(`sendChatSetup: error fetching ${sheetPath}: ${String(e)}`);
    }
  }

  // Fetch CSS files referenced by @import inside inline <style> blocks.
  // Foundry v14 loads system and module CSS this way rather than as <link>
  // elements. Fetching from DLC (same-origin) avoids the CORS block that
  // DLA's browser would hit when trying to load the same URLs cross-origin.
  {
    const alreadyFetched = new Set(
      Array.from(document.styleSheets)
        .filter(s => s.href)
        .map(s => s.href.split('?')[0])
    );

    const importRegex = /(?:^|\n)\s*@import\s+(['"])(?!https?:\/\/|\/\/|data:)([^'"]+)\1/g;
    const importUrlsToFetch = [];

    for (const sheet of document.styleSheets) {
      if (sheet.href) continue;
      const text = sheet.ownerNode?.textContent;
      if (!text) continue;
      importRegex.lastIndex = 0;
      let match;
      while ((match = importRegex.exec(text)) !== null) {
        const path = match[2].split('?')[0];
        const absolute = path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`;
        if (!alreadyFetched.has(absolute)) {
          importUrlsToFetch.push(absolute);
          alreadyFetched.add(absolute);
        }
      }
    }

    for (const url of importUrlsToFetch) {
      const urlPath = (() => { try { return new URL(url).pathname; } catch(e) { return url; } })();
      try {
        if (new URL(url).origin !== origin) {
          debugChatLog(`sendChatSetup: skipping cross-origin @import: ${urlPath}`);
          continue;
        }
        const response = await fetch(url);
        if (!response.ok) {
          debugChatLog(`sendChatSetup: fetch failed (${response.status}) for @import: ${urlPath}`);
          continue;
        }
        const text = await response.text();
        if (text && text.trim()) {
          styleTexts.push(await embedFontDataUris(makeAbsoluteCss(text.trim(), origin, url)));
          debugChatLog(`sendChatSetup: fetched @import ${urlPath} (${text.length} bytes)`);
        }
      } catch (e) {
        debugChatLog(`sendChatSetup: error fetching @import ${urlPath}: ${String(e)}`);
      }
    }
  }

  // Collect @font-face rules from constructable stylesheets.
  // Foundry systems (e.g. dnd5e) register custom icon fonts via JavaScript-built
  // stylesheets that have no ownerNode textContent and no href — the blocks above skip them.
  // The browser resolves @font-face src URLs to absolute form, so rule.cssText is safe to use directly.
  {
    const fontFaceBlocks = [];
    for (const sheet of document.styleSheets) {
      if (sheet.href) continue;
      const textLen = sheet.ownerNode?.textContent?.length ?? 0;
      if (textLen > 0) continue;
      let rules;
      try { rules = Array.from(sheet.cssRules || []); } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.type === CSSRule.FONT_FACE_RULE) {
          fontFaceBlocks.push(rule.cssText);
        }
      }
    }
    if (fontFaceBlocks.length > 0) {
      styleTexts.push(await embedFontDataUris(fontFaceBlocks.join('\n')));
      debugChatLog(`sendChatSetup: collected ${fontFaceBlocks.length} @font-face rules from constructable stylesheets`);
    }
  }

  // Read all CSS variable values from the active theme element.
  // A .themed element inherits root defaults AND has any theme overrides applied,
  // so one read gives us the complete correct set. Fall back to body if not found.
  const cssVars = {};
  const varNamesInCss = new Set();
  const varNameRegex = /\B(--[\w-]+)\s*:/g;
  for (const text of styleTexts) {
    varNameRegex.lastIndex = 0;
    let m;
    while ((m = varNameRegex.exec(text)) !== null) varNamesInCss.add(m[1]);
  }
  const themeEl = document.querySelector('.themed') || document.body;
  const computed = getComputedStyle(themeEl);
  for (const name of varNamesInCss) {
    const val = computed.getPropertyValue(name).trim();
    if (val) cssVars[name] = val;
  }

  const bodyClasses = Array.from(document.body.classList);
  const rootFontSize = getComputedStyle(document.documentElement).fontSize;

  // Read Foundry's sidebar width from its CSS variable — available regardless of collapse state
  // because Foundry collapses via margin change, not width change.
  const sidebarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 300;

  debugChatLog(`sendChatSetup: ${styleTexts.length} style blocks, ${Object.keys(cssVars).length} vars, ${bodyClasses.length} body classes, rootFontSize=${rootFontSize}, sidebarWidth=${sidebarWidth}`);

  let interfaceTheme = '';
  try {
    const uiConfig = game.settings.get('core', 'uiConfig');
    interfaceTheme = uiConfig?.colorScheme?.interface || '';
  } catch (e) {}
  if (!interfaceTheme) {
    interfaceTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  sendMessage({ type: "chatSetup", styleTexts, cssVars, bodyClasses, rootFontSize, sidebarWidth, interfaceTheme });
}

// ============================================================================
// CHAT VISIBILITY STATE — read Foundry's active chat type and report to DLA
// ============================================================================

// DLA mode key → Foundry v14 messageMode key.
// In v14 the icon/key assignments shifted: "gm" means GM+sender both see (old "whisper"),
// "blind" means GM-only/sender cannot see (old "GM only").
const _DLA_TO_FOUNDRY = {
  public:  'public',
  whisper: 'gm',
  self:    'self',
  gm:      'blind',
};

const _FOUNDRY_TO_DLA = {
  public: 'public',
  gm:     'whisper',
  blind:  'gm',
  self:   'self',
  ic:     'public',
};

let _lastReportedChatMode = null;

/** Read the current Foundry messageMode and return the DLA equivalent. */
function _readFoundryChatMode() {
  try {
    const foundryMode = game.settings.get("core", "messageMode");
    return _FOUNDRY_TO_DLA[foundryMode] || null;
  } catch(e) { return null; }
}

/** Send the active mode to DLA, suppressing duplicate reports. */
function _reportChatModeToUI(mode) {
  if (!mode || mode === _lastReportedChatMode) return;
  _lastReportedChatMode = mode;
  sendMessage({ type: 'chatVisibilityState', mode });
}

/** Watch for Foundry changing the message mode independently of DLA. */
function _watchFoundryChatMode() {
  const modesEl = document.getElementById("message-modes");
  if (!modesEl) return;
  const observer = new MutationObserver(() => {
    const mode = _readFoundryChatMode();
    if (mode) _reportChatModeToUI(mode);
  });
  observer.observe(modesEl, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Register the renderChatMessageHTML hook to forward new messages to DLA.
 * Called once during module initialisation.
 */
export function setupChatLog() {
  Hooks.on("renderChatMessageHTML", (message, element) => {
    if (!getConnectionStatus()) return;

    // Skip messages older than 2 minutes — treat as historical re-renders, not new
    if (message.timestamp && (Date.now() - message.timestamp) > 120000) {
      debugChatLog("renderChatMessageHTML: skipping old message", message.id);
      return;
    }

    const li = element?.closest?.("li.chat-message") || element;
    if (!li) {
      debugChatLog("renderChatMessageHTML: no li.chat-message found, skipping");
      return;
    }

    const rollData = extractRollData(message);
    sendCard(message.id, li, rollData);
    attachObserver(message.id, li, rollData);
  });

  // Register handler so qwebchannel-client can route chatInteraction signals here
  setChatInteractionCallback(handleChatInteraction);

  // Register handler for chat commands typed in DLA's tray
  setChatCommandCallback(async (message) => {
    if (message.content && ui.chat) {
      await ui.chat.processMessage(message.content);
    }
  });

  // Register handler for visibility mode changes from DLA's tray
  // Finds Foundry's matching chat type button by its FontAwesome icon class and clicks it,
  // then immediately reports back so DLA knows the confirmed mode.
  setChatVisibilityCallback(({ mode }) => {
    const foundryMode = _DLA_TO_FOUNDRY[mode] || mode;
    try { game.settings.set("core", "messageMode", foundryMode); } catch(e) {}
    _reportChatModeToUI(mode);
  });

  // Read Foundry's current active chat type and start watching for changes.
  // Delay slightly so Foundry's sidebar has fully rendered.
  setTimeout(() => {
    _reportChatModeToUI(_readFoundryChatMode() || 'public');
    _watchFoundryChatMode();
  }, 1000);

  debug("Chat log: renderChatMessageHTML hook registered");
}

/**
 * Send CSS setup data then signal DLA to initialise its chat panel.
 * Called when the DLA connection is confirmed (and on reconnect).
 */
export async function sendInitialChatHistory() {
  debugChatLog("sendInitialChatHistory: sending chatSetup then chatInit");
  await sendChatSetup();
  sendMessage({ type: "chatInit" });
}
