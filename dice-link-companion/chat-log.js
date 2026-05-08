/**
 * Chat Log Module - dice-link-companion
 * Forwards Foundry chat messages to DLA via QWebChannel.
 */

import { sendMessage, getConnectionStatus } from "./qwebchannel-client.js";
import { debug, debugChatLog } from "./debug.js";

// Tracks message IDs already sent this session to prevent duplicates.
// renderChatMessageHTML can fire twice for the same message when modules
// like chatlog-prune extend ChatLog and trigger a re-render on creation.
const _sentMessageIds = new Set();

/**
 * Rewrite relative src/href attributes to absolute URLs using the Foundry origin.
 * Prevents broken avatar images and asset links when HTML is rendered in DLA.
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
 * Register the renderChatMessageHTML hook to forward new messages to DLA.
 * Called once during module initialisation.
 */
export function setupChatLog() {
  Hooks.on("renderChatMessageHTML", (message, element) => {
    if (!getConnectionStatus()) return;

    if (_sentMessageIds.has(message.id)) {
      debugChatLog("renderChatMessageHTML: duplicate, skipping", message.id);
      return;
    }

    const li = element?.closest?.("li.chat-message") || element;
    if (!li) {
      debugChatLog("renderChatMessageHTML: no li.chat-message found, skipping");
      return;
    }

    _sentMessageIds.add(message.id);
    debugChatLog("renderChatMessageHTML: sending", message.id);
    sendMessage({
      type: "chatMessage",
      messageId: message.id,
      html: makeAbsolute(li.outerHTML)
    });
  });
  debug("Chat log: renderChatMessageHTML hook registered");
}

/**
 * Signal DLA to initialise its chat panel.
 * Called when the DLA connection is confirmed (and on reconnect).
 * No CSS or history is sent — DLA uses its own stylesheet.
 */
export function sendInitialChatHistory() {
  debugChatLog("sendInitialChatHistory: sending chatInit");
  _sentMessageIds.clear();
  sendMessage({ type: "chatInit" });
}
