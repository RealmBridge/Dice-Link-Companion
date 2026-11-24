/**
 * chat-log.js - the copy of Foundry's chat shown in DLA. Sends each new chat message to
 * DLA (and again whenever it changes), plus the page's styles so it looks the same there;
 * carries out clicks made on a chat card in DLA; posts chat typed in DLA; and keeps
 * Foundry's and DLA's chat visibility (public / whisper / self / GM) in step.
 */

import { sendMessage, getConnectionStatus, onDLAMessage } from "./qwebchannel-client.js";
import { debug, debugChatLog } from "./debug.js";
import { normaliseVisibility } from "./clip-visibility.js";

// ---- The cards DLA has, and their clickable parts ----

// messageId -> what the card held when DLA last got it (null: DLA needs it again)
const _sent = new Map();

// messageId -> the timer of a card that is still changing (sent once it settles)
const _settling = new Map();

// messageId -> Map<dlaId (number), real DOM element>
const _interactionMap = new Map();

const CARD = ".chat-message[data-message-id]";
const TIME_LABEL = ".message-timestamp";
const DEBOUNCE_MS = 500;
const NEW_MESSAGE_MS = 120000;   // an older card DLA doesn't have is history being drawn, not a new message

// ---- Helpers ----

/** A path on the Foundry server ("/x" or "x") as a full address on the given origin. */
function toAbsolute(path, origin) {
  return path.startsWith("/") ? `${origin}${path}` : `${origin}/${path}`;
}

/**
 * Rewrite relative src/href attributes to absolute URLs using the Foundry origin.
 */
function makeAbsolute(html) {
  const origin = window.location.origin;
  return html.replace(
    /\b(src|href|data-src)="(?!https?:\/\/|\/\/|data:|#|javascript:)([^"]*)"/g,
    (match, attr, path) => `${attr}="${toAbsolute(path, origin)}"`
  );
}

/**
 * Number every interactive element inside a card's li DOM element and store
 * a map of dlaId -> real element for later interaction forwarding.
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
 * Send a card to DLA as Foundry's chat log shows it now, but only if it has changed since
 * DLA last got it. The time label doesn't count as a change: Foundry rewrites it on every
 * card every 15 seconds.
 */
function sendCard(messageId) {
  if (!getConnectionStatus()) return;
  const li = ui.chat.element.querySelector(`.chat-message[data-message-id="${messageId}"]`);
  if (!li) return;

  const html = numberAndSerialize(messageId, li);
  const rollData = extractRollData(game.messages.get(messageId));
  const label = li.querySelector(TIME_LABEL);
  const content = (label ? html.replace(label.outerHTML, "") : html) + JSON.stringify(rollData);
  if (content === _sent.get(messageId)) return;

  _sent.set(messageId, content);
  sendMessage({ type: "chatMessage", messageId, html, rollData });
}

// ---- Watching Foundry's chat log ----

function isNewMessage(messageId) {
  const message = game.messages.get(messageId);
  return !!message && (Date.now() - message.timestamp) <= NEW_MESSAGE_MS;
}

/** Send a card once it has stopped changing. */
function sendWhenSettled(messageId) {
  clearTimeout(_settling.get(messageId));
  _settling.set(messageId, setTimeout(() => {
    _settling.delete(messageId);
    sendCard(messageId);
  }, DEBOUNCE_MS));
}

/**
 * Something changed in the chat log: a card Foundry drew (a new message, or an update to
 * one) is sent straight away, a card that changed in place once it settles.
 */
function onChatLogChange(mutations) {
  const drawn = new Set();
  const changed = new Set();

  for (const mutation of mutations) {
    const { target } = mutation;
    const el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    // Our own numbering, and Foundry's clock
    if (mutation.attributeName === "data-dla-id" || el?.closest(TIME_LABEL)) continue;

    const card = el?.closest(CARD);
    if (card) {
      changed.add(card.dataset.messageId);
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      for (const li of node.matches(CARD) ? [node] : node.querySelectorAll(CARD)) {
        drawn.add(li.dataset.messageId);
      }
    }
  }

  for (const messageId of drawn) {
    if (_sent.has(messageId) || isNewMessage(messageId)) sendCard(messageId);
  }
  for (const messageId of changed) {
    if (_sent.has(messageId)) sendWhenSettled(messageId);
  }
}

/** Watch Foundry's chat log for the rest of the game, from the moment it is on screen. */
function watchChatLog() {
  if (!ui.chat.element) {
    Hooks.once("renderChatLog", watchChatLog);
    return;
  }
  new MutationObserver(onChatLogChange)
    .observe(ui.chat.element, { childList: true, subtree: true, attributes: true, characterData: true });
}

// ---- Clicks on a chat card in DLA ----

/**
 * Handle a chatInteraction signal from DLA: finds the real Foundry DOM element and fires
 * the event on it. Whatever that changes on the card reaches DLA through the watch above.
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

// ---- The page's styles, for DLA ----

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
    return toAbsolute(path, origin);
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
 * Fetch one same-origin stylesheet and add it, made self-contained, to styleTexts.
 * Used for the page's <link> stylesheets and the files its <style> blocks @import.
 * @param {string} url - the stylesheet's address
 * @param {string} kind - "sheet" or "@import", for the log
 */
async function addSameOriginCss(url, kind, origin, styleTexts) {
  const urlPath = (() => { try { return new URL(url).pathname; } catch(e) { return url; } })();
  try {
    if (new URL(url).origin !== origin) {
      debugChatLog(`sendChatSetup: skipping cross-origin ${kind}: ${urlPath}`);
      return;
    }
    const response = await fetch(url);
    if (!response.ok) {
      debugChatLog(`sendChatSetup: fetch failed (${response.status}) for ${kind}: ${urlPath}`);
      return;
    }
    const text = await response.text();
    if (text && text.trim()) {
      styleTexts.push(await embedFontDataUris(makeAbsoluteCss(text.trim(), origin, url)));
      debugChatLog(`sendChatSetup: fetched ${kind} ${urlPath} (${text.length} bytes)`);
    } else {
      debugChatLog(`sendChatSetup: empty response for ${kind}: ${urlPath}`);
    }
  } catch (e) {
    debugChatLog(`sendChatSetup: error fetching ${kind} ${urlPath}: ${String(e)}`);
  }
}

/**
 * Collect embedded CSS blocks, custom property values, and body classes
 * from the Foundry page, then send them to DLA so it can replicate Foundry's styling.
 * Sources: the page's <style> elements, its same-origin <link> stylesheets, the files
 * those <style> elements pull in with @import, and @font-face rules built by scripts.
 */
async function sendChatSetup() {
  const origin = window.location.origin;

  const styleTexts = [];

  // Files the <style> blocks pull in with @import. Foundry v14 loads system and module CSS
  // this way rather than as <link> elements; fetching them from DLC (same-origin) avoids
  // the CORS block DLA's browser would hit loading the same URLs cross-origin.
  const alreadyFetched = new Set(
    Array.from(document.styleSheets)
      .filter(s => s.href)
      .map(s => s.href.split('?')[0])
  );
  const importRegex = /(?:^|\n)\s*@import\s+(['"])(?!https?:\/\/|\/\/|data:)([^'"]+)\1/g;
  const importUrlsToFetch = [];

  // Collect inline <style> element text, noting the files each one @imports
  for (const sheet of document.styleSheets) {
    if (sheet.href) continue;
    const text = sheet.ownerNode?.textContent;
    if (!text) continue;
    importRegex.lastIndex = 0;
    let match;
    while ((match = importRegex.exec(text)) !== null) {
      const absolute = toAbsolute(match[2].split('?')[0], origin);
      if (!alreadyFetched.has(absolute)) {
        importUrlsToFetch.push(absolute);
        alreadyFetched.add(absolute);
      }
    }
    try {
      if (text.trim()) {
        styleTexts.push(await embedFontDataUris(makeAbsoluteCss(text.trim(), origin)));
      }
    } catch (e) {
      // Skip inaccessible sheets
    }
  }

  // Fetch same-origin <link> stylesheets (foundry2.css and any others)
  for (const sheet of document.styleSheets) {
    if (!sheet.href) continue;
    await addSameOriginCss(sheet.href, "sheet", origin, styleTexts);
  }

  // Then the @import files
  for (const url of importUrlsToFetch) {
    await addSameOriginCss(url, "@import", origin, styleTexts);
  }

  // Collect @font-face rules from constructable stylesheets.
  // Foundry systems (e.g. dnd5e) register custom icon fonts via JavaScript-built
  // stylesheets that have no ownerNode textContent and no href - the blocks above skip them.
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

  // Read Foundry's sidebar width from its CSS variable - available regardless of collapse state
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

// ---- Chat visibility, kept the same in Foundry and DLA ----

// DLA mode key -> the visibility's name, as Foundry 14 names it (the other way round is the
// same table read backwards). "gm" means GM+sender both see (old "whisper"), "blind" means
// GM-only/sender cannot see (old "GM only").
const _DLA_TO_FOUNDRY = {
  public:  'public',
  whisper: 'gm',
  self:    'self',
  gm:      'blind',
};
const _FOUNDRY_TO_DLA = Object.fromEntries(Object.entries(_DLA_TO_FOUNDRY).map(([dla, foundry]) => [foundry, dla]));

// Foundry 13 keeps the same four in its "rollMode" setting, under these names; Foundry 14
// replaced it with "messageMode", which uses the names above
const _ROLL_MODE_NAMES = { public: 'publicroll', gm: 'gmroll', blind: 'blindroll', self: 'selfroll' };

let _lastReportedChatMode = null;

/** The core setting that holds the chat visibility: "messageMode" from Foundry 14, "rollMode" in 13. */
function _visibilitySettingKey() {
  return game.settings.settings.has("core.messageMode") ? "messageMode" : "rollMode";
}

/**
 * Foundry's current chat visibility as public / gm / blind / self, or null if unknown.
 * Also used for who may see a dice clip (video-feed.js).
 */
export function currentChatVisibility() {
  try {
    return normaliseVisibility(game.settings.get("core", _visibilitySettingKey()));
  } catch (e) {
    return null;
  }
}

/** Foundry's current chat visibility as DLA names it. */
function _readFoundryChatMode() {
  return _FOUNDRY_TO_DLA[currentChatVisibility()] || null;
}

/** Send the active mode to DLA, suppressing duplicate reports. */
function _reportChatModeToUI(mode) {
  if (!mode || mode === _lastReportedChatMode) return;
  _lastReportedChatMode = mode;
  sendMessage({ type: 'chatVisibilityState', mode });
}

/**
 * Watch for the chat visibility being changed in Foundry, not through DLA. Foundry's own
 * buttons only change the setting, and Foundry 13 and 14 both announce every change to a
 * client setting, so this one signal covers both (their buttons on screen differ).
 */
function _watchFoundryChatMode() {
  Hooks.on("clientSettingChanged", (key) => {
    if (key !== `core.${_visibilitySettingKey()}`) return;
    const mode = _readFoundryChatMode();
    if (mode) _reportChatModeToUI(mode);
  });
}

// ---- Setup ----

/**
 * Start sending Foundry's chat to DLA, and take DLA's clicks, chat and visibility buttons.
 * Called once during module initialisation.
 */
export function setupChatLog() {
  watchChatLog();

  // Register handler so qwebchannel-client can route chatInteraction signals here
  onDLAMessage("chatInteraction", handleChatInteraction);

  // Register handler for chat commands typed in DLA's tray
  onDLAMessage("chatCommand", async (message) => {
    if (message.content && ui.chat) {
      await ui.chat.processMessage(message.content);
    }
  });

  // Register handler for visibility mode changes from DLA's tray: set Foundry's chat
  // visibility, then immediately report back so DLA knows the confirmed mode.
  onDLAMessage("chatVisibility", ({ mode }) => {
    const visibility = _DLA_TO_FOUNDRY[mode] || mode;
    const key = _visibilitySettingKey();
    const value = key === "rollMode" ? (_ROLL_MODE_NAMES[visibility] || visibility) : visibility;
    try { game.settings.set("core", key, value); } catch(e) {}
    _reportChatModeToUI(mode);
  });

  // Read Foundry's current active chat type and start watching for changes.
  // Delay slightly so Foundry's sidebar has fully rendered.
  setTimeout(() => {
    _reportChatModeToUI(_readFoundryChatMode() || 'public');
    _watchFoundryChatMode();
  }, 1000);

  debug("Chat log: watching Foundry's chat");
}

/**
 * Send CSS setup data then signal DLA to initialise its chat panel.
 * Called when the DLA connection is confirmed (and on reconnect).
 */
export async function sendInitialChatHistory() {
  debugChatLog("sendInitialChatHistory: sending chatSetup then chatInit");
  await sendChatSetup();
  sendMessage({ type: "chatInit" });

  // DLA's chat starts empty again, so every card it had goes back
  for (const messageId of _sent.keys()) {
    _sent.set(messageId, null);
    sendCard(messageId);
  }
}
