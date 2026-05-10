/**
 * Chat Log Module - dice-link-companion
 * Forwards Foundry chat messages to DLA via QWebChannel.
 * Uses Foundry's own CSS — system-agnostic.
 */

import { sendMessage, getConnectionStatus, setChatInteractionCallback } from "./qwebchannel-client.js";
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
    /\b(src|href)="(?!https?:\/\/|\/\/|data:|#|javascript:)([^"]*)"/g,
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

  li.querySelectorAll('button, select, input, details > summary, [data-action], .collapsible > label')
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
 */
function makeAbsoluteCss(css, origin) {
  css = css.replace(
    /url\((['"]?)(?!https?:\/\/|\/\/|data:|#)([^'")\s]+)\1\)/g,
    (match, quote, path) => {
      const absolute = path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`;
      return `url(${quote}${absolute}${quote})`;
    }
  );
  css = css.replace(
    /@import\s+(['"])(?!https?:\/\/|\/\/)([^'"]+)\1/g,
    (match, quote, path) => {
      const absolute = path.startsWith('/') ? `${origin}${path}` : `${origin}/${path}`;
      return `@import ${quote}${absolute}${quote}`;
    }
  );
  return css;
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
        styleTexts.push(makeAbsoluteCss(text.trim(), origin));
      }
    } catch (e) {
      // Skip inaccessible sheets
    }
  }

  // Fetch same-origin <link> stylesheets (foundry2.css and any others)
  for (const sheet of document.styleSheets) {
    if (!sheet.href) continue;
    try {
      if (new URL(sheet.href).origin !== origin) continue;
      const response = await fetch(sheet.href);
      if (!response.ok) continue;
      const text = await response.text();
      if (text && text.trim()) {
        styleTexts.push(makeAbsoluteCss(text.trim(), origin));
      }
    } catch (e) {
      debugChatLog('sendChatSetup: error fetching linked sheet:', sheet.href, String(e));
    }
  }

  const cssVars = {};
  try {
    const rootStyle = getComputedStyle(document.documentElement);
    for (const prop of rootStyle) {
      if (prop.startsWith('--')) {
        cssVars[prop] = rootStyle.getPropertyValue(prop).trim();
      }
    }
  } catch (e) {
    debugChatLog('sendChatSetup: error collecting CSS vars:', e);
  }

  const bodyClasses = Array.from(document.body.classList);
  const rootFontSize = getComputedStyle(document.documentElement).fontSize;

  debugChatLog(`sendChatSetup: ${styleTexts.length} style blocks, ${Object.keys(cssVars).length} vars, ${bodyClasses.length} body classes, rootFontSize=${rootFontSize}`);

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

  sendMessage({ type: "chatSetup", styleTexts, cssVars, bodyClasses, rootFontSize, programmaticDiagnostic });
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
