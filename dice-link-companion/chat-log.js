/**
 * Chat Log Module - dice-link-companion
 * Forwards Foundry chat messages to DLA via QWebChannel.
 */

import { sendMessage, getConnectionStatus } from "./qwebchannel-client.js";
import { debug, debugChatLog } from "./debug.js";

// Tracks how many times sendInitialChatHistory has been called this session.
// Expected: exactly 1. If > 1, the double-call bug is still present.
let _sendInitialChatHistoryCallCount = 0;

// Buffer populated by the renderChatLog hook when the chat log first renders.
// null = hook has not fired yet. [] = fired but no messages. [...] = captured messages.
// Used as fallback for history when the DOM is empty at connection time.
let _chatLogHistoryBuffer = null;

/**
 * Rewrite relative src/href attributes to absolute URLs using the Foundry origin.
 * Prevents broken image and link URLs when HTML is rendered in the DLA panel.
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
 * Rewrite relative url() references and bare @import paths inside a CSS string
 * to absolute URLs. Uses the stylesheet's own href as the base so relative paths
 * resolve correctly against Foundry's origin rather than DLA's.
 *
 * Handles two syntaxes:
 *   url("path") / url('path') / url(path)
 *   @import "path" / @import 'path'
 */
function makeStyleUrlsAbsolute(cssText, cssHref) {
  try {
    const base = new URL(cssHref);

    // Rewrite url() references
    let result = cssText.replace(
      /url\(\s*(['"]?)(?!https?:\/\/|data:|#)([^'")\s]+)\1\s*\)/g,
      (match, quote, path) => {
        try {
          const absolute = new URL(path, base).href;
          return `url(${quote}${absolute}${quote})`;
        } catch {
          return match;
        }
      }
    );

    // Rewrite bare @import "path" / @import 'path' (without url() wrapper)
    result = result.replace(
      /@import\s+(['"])(?!https?:\/\/|data:)([^'"]+)\1/g,
      (match, quote, path) => {
        try {
          const absolute = new URL(path, base).href;
          return `@import ${quote}${absolute}${quote}`;
        } catch {
          return match;
        }
      }
    );

    return result;
  } catch {
    return cssText;
  }
}

/**
 * Set up the renderChatMessageHTML hook to forward new messages to DLA.
 * Called once during module initialisation.
 */
export function setupChatLog() {
  // Capture the full rendered chat log the first time it appears in the DOM.
  // renderChatLog fires during game setup, after messages have been rendered into the
  // ol.chat-log element. This is earlier and more reliable than querying the DOM from
  // the ready hook (where the chat log hasn't rendered yet).
  Hooks.once("renderChatLog", (app, html) => {
    const root = html instanceof HTMLElement ? html : (html && html[0]);
    if (!root) {
      debugChatLog("renderChatLog: html argument was not an HTMLElement, buffer not populated");
      return;
    }
    const messages = Array.from(root.querySelectorAll("li.chat-message"))
      .map(li => makeAbsolute(li.outerHTML));
    debugChatLog("renderChatLog: captured chat history", messages.length);
    _chatLogHistoryBuffer = messages;
  });

  Hooks.on("renderChatMessageHTML", (message, element) => {
    const connected = getConnectionStatus();
    debugChatLog("renderChatMessageHTML hook fired", {
      messageId: message?.id,
      connected: connected,
      elementTag: element?.tagName,
      elementClass: element?.className,
      htmlLength: element?.outerHTML?.length
    });
    if (!connected) return;
    const li = element?.closest?.("li.chat-message") || element;
    if (!li) {
      debugChatLog("renderChatMessageHTML: no li.chat-message found, skipping");
      return;
    }
    debugChatLog("renderChatMessageHTML: sending chatMessage to DLA", {
      messageId: message?.id,
      htmlLength: li.outerHTML.length
    });
    sendMessage({
      type: "chatMessage",
      messageId: message.id,
      html: makeAbsolute(li.outerHTML)
    });
  });
  debug("Chat log: renderChatMessageHTML hook registered");
}

/**
 * Fetch all Foundry stylesheets as text and send them with existing messages
 * to DLA in a single payload. Called when the DLA connection is confirmed
 * (and on reconnect).
 *
 * Same-origin stylesheets are fetched and their relative url() references
 * rewritten to absolute so DLA can render them without cross-origin issues.
 * External/CDN stylesheets are sent as URLs (they are already cross-origin
 * accessible everywhere).
 */
export async function sendInitialChatHistory() {
  _sendInitialChatHistoryCallCount++;
  const callNum = _sendInitialChatHistoryCallCount;
  debugChatLog(`sendInitialChatHistory called (call #${callNum})`);
  if (callNum > 1) {
    debugChatLog(`WARNING: sendInitialChatHistory has been called ${callNum} times — double-call bug still present`);
  }

  const origin = window.location.origin;
  debugChatLog("origin", origin);

  const allLinkElements = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const linkElements = allLinkElements.filter(link => link.href && link.href.startsWith("http"));
  debugChatLog("link[rel=stylesheet] total in DOM", allLinkElements.length);
  debugChatLog("link[rel=stylesheet] with absolute http href", linkElements.length);

  // Separate same-origin sheets (need fetching) from external CDN sheets (send as URL)
  const sameOriginLinks = linkElements.filter(link => link.href.startsWith(origin));
  const externalUrls = linkElements
    .filter(link => !link.href.startsWith(origin))
    .map(link => link.href);

  debugChatLog("same-origin stylesheets to fetch", sameOriginLinks.length);
  debugChatLog("external stylesheet URLs", externalUrls.length);
  sameOriginLinks.forEach((link, i) => {
    debugChatLog(`same-origin link[${i}]`, link.href);
  });

  // Fetch same-origin stylesheet text and rewrite relative url() and @import paths
  const fetchResults = await Promise.allSettled(
    sameOriginLinks.map(link =>
      fetch(link.href)
        .then(r => {
          debugChatLog("fetch response", { url: link.href, status: r.status, ok: r.ok });
          return r.text();
        })
        .then(text => {
          const totalImports = (text.match(/@import/g) || []).length;
          const rewritten = makeStyleUrlsAbsolute(text, link.href);
          const relativeImportsRemaining = (rewritten.match(/@import\s+['"](?!https?:\/\/)/g) || []).length;
          debugChatLog("stylesheet processed", {
            url: link.href,
            bytes: text.length,
            atImportsTotal: totalImports,
            atImportsStillRelativeAfterRewrite: relativeImportsRemaining,
            note: relativeImportsRemaining > 0 ? "WARNING: some @imports were NOT rewritten to absolute" : "ok"
          });
          return rewritten;
        })
    )
  );

  fetchResults.forEach((r, i) => {
    if (r.status === "rejected") {
      debugChatLog("fetch FAILED", { url: sameOriginLinks[i]?.href, reason: String(r.reason) });
    }
  });

  const fetchedStyleTexts = fetchResults
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);
  debugChatLog("fetch summary", {
    attempted: sameOriginLinks.length,
    succeeded: fetchedStyleTexts.length,
    failed: fetchResults.filter(r => r.status !== "fulfilled" || !r.value).length
  });

  // Inline <style> block content — processed through makeStyleUrlsAbsolute.
  // Inline styles have no file location so paths are resolved from the document root
  // (origin + "/"). Without this, @import paths remain relative to DLA's origin → 404s.
  const inlineStyleElements = Array.from(document.querySelectorAll("style"));
  debugChatLog("inline <style> elements found", inlineStyleElements.length);
  const inlineStyleTexts = inlineStyleElements
    .map((s, i) => {
      const rawText = s.textContent || "";
      const text = makeStyleUrlsAbsolute(rawText, origin + "/");
      const importsBefore = (rawText.match(/@import/g) || []).length;
      const importsAfter = (text.match(/@import\s+['"](?!https?:\/\/)/g) || []).length;
      debugChatLog(`inline style[${i}]`, {
        bytes: rawText.length,
        atImportsBefore: importsBefore,
        atImportsStillRelativeAfter: importsAfter,
        note: importsAfter > 0 ? "WARNING: some @imports still relative after rewrite" : "ok"
      });
      return text;
    })
    .filter(t => t.trim());

  const styleTexts = [...fetchedStyleTexts, ...inlineStyleTexts];
  debugChatLog("total styleTexts to send", {
    fromFetched: fetchedStyleTexts.length,
    fromInline: inlineStyleTexts.length,
    total: styleTexts.length
  });

  // Collect existing messages and send the full init payload.
  // Primary: DOM query (works on reconnect, when chat log has already rendered).
  // Fallback: buffer captured by renderChatLog hook (handles initial connection, where
  // the chat log renders after the ready hook fires and the DOM query returns empty).
  function collectAndSend(styleTexts, externalUrls, origin) {
    const chatLog = document.querySelector("ol.chat-log");
    debugChatLog("ol.chat-log element", chatLog ? "found" : "NOT FOUND (null)");

    try {
      if (typeof game !== "undefined" && game.messages) {
        debugChatLog("game.messages.size", game.messages.size);
      }
    } catch (e) {
      debugChatLog("game.messages access error", String(e));
    }

    const domMessages = chatLog
      ? Array.from(chatLog.querySelectorAll("li.chat-message")).map(msg => makeAbsolute(msg.outerHTML))
      : [];
    debugChatLog("li.chat-message from DOM", domMessages.length);
    debugChatLog("_chatLogHistoryBuffer", _chatLogHistoryBuffer !== null ? _chatLogHistoryBuffer.length : "null (renderChatLog not yet fired)");

    const messages = domMessages.length > 0
      ? domMessages
      : (_chatLogHistoryBuffer !== null ? _chatLogHistoryBuffer : []);

    const source = domMessages.length > 0 ? "DOM" : (_chatLogHistoryBuffer !== null ? "renderChatLog buffer" : "empty");
    debugChatLog("sending chatInit", { source, messages: messages.length, styleTexts: styleTexts.length, styleUrls: externalUrls.length });
    sendMessage({ type: "chatInit", foundryUrl: origin, styleUrls: externalUrls, styleTexts, messages });
  }

  collectAndSend(styleTexts, externalUrls, origin);
}
