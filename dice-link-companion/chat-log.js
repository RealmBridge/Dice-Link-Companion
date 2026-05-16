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
 * Serialize and send the current state of a card to DLA.
 */
function sendCard(messageId, li) {
  const html = numberAndSerialize(messageId, li);
  sendMessage({ type: "chatMessage", messageId, html });

  // Sample ref styles after a delay so the li is in the DOM and all system
  // hooks have run — getComputedStyle returns empty strings on disconnected elements.
  setTimeout(() => {
    const refStyles = sampleRefStyles(li);
    if (refStyles) sendMessage({ type: "chatRefStyles", messageId, refStyles });
  }, 300);
}

// ============================================================================
// STYLE REFERENCE SAMPLING — DLC-side ground truth for DLA style comparison
// ============================================================================

const _DIAG_SELECTORS = [
  '.card-buttons header',
  '.card-buttons header span',
  '.pill',
  '.pill.transparent',
  '[class*="pip"]',
  'label[class*="pip"]',
  '[class*="damage"]',
  '[class*="targeted"]',
  '[class*="selected"]',
  'button',
  '[data-action]',
  'i[class]',
];
const _DIAG_MAX_PER_SEL = 5;

/**
 * For rich cards (those with card-buttons, pill, or pip elements), read the
 * computed styles of key elements directly from the live Foundry DOM.
 * These values are sent to DLA so it can diff what it renders against the
 * correct Foundry values and log only the mismatches.
 * Returns null for simple cards that lack those elements.
 */
function sampleRefStyles(li) {
  if (!li.querySelector('.card-buttons, .pill, [class*="pip"]')) return null;
  const result = {};
  for (const sel of _DIAG_SELECTORS) {
    const els = li.querySelectorAll(sel);
    if (!els.length) continue;
    const entries = [];
    els.forEach((el, i) => {
      if (i >= _DIAG_MAX_PER_SEL) return;
      const cs = getComputedStyle(el);
      const entry = {
        color:       cs.color,
        bg:          cs.backgroundColor,
        borderStyle: cs.borderStyle,
        borderColor: cs.borderColor,
        position:    cs.position,
      };
      const bp = getComputedStyle(el, '::before');
      if (bp.content && !['none', '""', 'normal'].includes(bp.content))
        entry.before = { content: bp.content, fontFamily: bp.fontFamily };
      const ap = getComputedStyle(el, '::after');
      if (ap.content && !['none', '""', 'normal'].includes(ap.content))
        entry.after = { content: ap.content, fontFamily: ap.fontFamily };
      entries.push(entry);
    });
    if (entries.length) result[sel] = entries;
  }
  return Object.keys(result).length ? result : null;
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
function attachObserver(messageId, li) {
  let state = _observerMap.get(messageId);

  const resetTimers = () => {
    clearTimeout(state.debounceTimer);
    clearTimeout(state.timeoutTimer);
    state.debounceTimer = setTimeout(() => sendCard(messageId, li), DEBOUNCE_MS);
    state.timeoutTimer = setTimeout(() => disconnectObserver(messageId), OBSERVER_TIMEOUT_MS);
  };

  if (state) {
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

  state = { observer, debounceTimer: null, timeoutTimer: null };
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

  // Diagnostic: collect computed vars from dnd5e-specific elements so DLA can
  // compare what it received vs what Foundry actually renders.
  const dnd5eDiagVars = {};
  for (const sel of ['.dnd5e2', '.application', '.dnd5e2.themed', '.themed']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const elComputed = getComputedStyle(el);
    const found = {};
    for (const name of varNamesInCss) {
      const val = elComputed.getPropertyValue(name).trim();
      if (val) found[name] = val;
    }
    if (Object.keys(found).length > 0) dnd5eDiagVars[sel] = found;
  }

  const bodyClasses = Array.from(document.body.classList);
  const rootFontSize = getComputedStyle(document.documentElement).fontSize;

  // Read Foundry's sidebar width from its CSS variable — available regardless of collapse state
  // because Foundry collapses via margin change, not width change.
  const sidebarWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 300;

  debugChatLog(`sendChatSetup: ${styleTexts.length} style blocks, ${Object.keys(cssVars).length} vars, ${bodyClasses.length} body classes, rootFontSize=${rootFontSize}, sidebarWidth=${sidebarWidth}`);

  // Diagnostic: inspect rules in programmatically-built <style> sheets (0b textContent, cssRules > 0)
  const programmaticDiagnostic = [];
  for (let si = 0; si < document.styleSheets.length; si++) {
    const sheet = document.styleSheets[si];
    if (sheet.href) continue;
    const textLen = sheet.ownerNode?.textContent?.length ?? 0;
    if (textLen > 0) continue;
    let rules = [];
    try { rules = Array.from(sheet.cssRules || []); } catch (e) { continue; }
    if (rules.length === 0) continue;
    for (let ri = 0; ri < rules.length; ri++) {
      programmaticDiagnostic.push({ si, ri, text: (rules[ri].cssText || '').substring(0, 200) });
    }
  }

  let interfaceTheme = '';
  try {
    const uiConfig = game.settings.get('core', 'uiConfig');
    interfaceTheme = uiConfig?.colorScheme?.interface || '';
  } catch (e) {}
  if (!interfaceTheme) {
    interfaceTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  sendMessage({ type: "chatSetup", styleTexts, cssVars, bodyClasses, rootFontSize, sidebarWidth, programmaticDiagnostic, dnd5eDiagVars, interfaceTheme });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Register the renderChatMessageHTML hook to forward new messages to DLA.
 * Called once during module initialisation.
 */
let _stylesheetSnapshotSent = false;

export function setupChatLog() {
  Hooks.on("renderChatMessageHTML", (message, element) => {
    if (!getConnectionStatus()) return;

    // One-shot: snapshot all stylesheets at first message render to detect late-loading CSS
    if (!_stylesheetSnapshotSent) {
      _stylesheetSnapshotSent = true;
      const sheets = [];
      for (let i = 0; i < document.styleSheets.length; i++) {
        const s = document.styleSheets[i];
        const href = s.href ? s.href.substring(0, 120) : null;
        const tag = s.ownerNode?.tagName ?? 'null';
        const textLen = s.ownerNode?.textContent?.length ?? -1;
        let rulesCount = -1;
        try { rulesCount = s.cssRules?.length ?? -1; } catch (e) { rulesCount = -2; }
        sheets.push({ i, tag, href, textLen, rulesCount });
      }
      sendMessage({ type: 'chatDiagnostic', event: 'firstMessageSheets', sheets });
    }

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

    sendCard(message.id, li);
    attachObserver(message.id, li);
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
  // Finds Foundry's matching chat type button by its FontAwesome icon class and clicks it
  setChatVisibilityCallback(({ mode }) => {
    if (!ui.chat?.element) return;
    const iconMap = {
      public:  'fa-comments',
      whisper: 'fa-user-secret',
      self:    'fa-user',
      gm:      'fa-eye-slash',
    };
    const iconClass = iconMap[mode];
    if (!iconClass) return;
    const icon = ui.chat.element[0].querySelector(`i.${iconClass}`);
    const btn = icon?.closest('button, a, [role="button"]');
    if (btn) btn.click();
  });

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
