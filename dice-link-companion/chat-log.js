/**
 * Chat Log Module - dice-link-companion
 * Forwards Foundry chat messages to DLA via QWebChannel.
 */

import { sendMessage, getConnectionStatus } from "./qwebchannel-client.js";
import { debug } from "./debug.js";

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
 * Set up the renderChatMessageHTML hook to forward new messages to DLA.
 * Called once during module initialisation.
 */
export function setupChatLog() {
  Hooks.on("renderChatMessageHTML", (message, element) => {
    if (!getConnectionStatus()) return;
    // element is the li.chat-message HTMLElement in v14
    const li = element?.closest?.("li.chat-message") || element;
    if (!li) return;
    sendMessage({
      type: "chatMessage",
      messageId: message.id,
      html: makeAbsolute(li.outerHTML)
    });
  });
  debug("Chat log: renderChatMessageHTML hook registered");
}

/**
 * Send stylesheet content and all existing messages to DLA in a single payload.
 * Called when the DLA connection is confirmed (and on reconnect).
 */
export function sendInitialChatHistory() {
  // External stylesheet URLs
  const styleUrls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .map(link => link.href)
    .filter(href => href && href.startsWith("http"));

  // Inline stylesheet text content
  const styleTexts = Array.from(document.querySelectorAll("style"))
    .map(s => s.textContent)
    .filter(t => t.trim());

  // Existing messages — batch into the init payload to avoid rapid-fire bridge calls
  const chatLog = document.querySelector("ol.chat-log");
  const messages = chatLog
    ? Array.from(chatLog.querySelectorAll("li.chat-message")).map(msg => makeAbsolute(msg.outerHTML))
    : [];

  debug(`Chat log: sending ${messages.length} existing messages to DLA`);

  sendMessage({
    type: "chatInit",
    foundryUrl: window.location.origin,
    styleUrls,
    styleTexts,
    messages
  });
}
