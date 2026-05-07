/**
 * Chat Log Module - dice-link-companion
 * Forwards Foundry chat messages to DLA via QWebChannel.
 */

import { sendMessage, getConnectionStatus } from "./qwebchannel-client.js";
import { debug } from "./debug.js";

/**
 * Set up the renderChatMessage hook to forward new messages to DLA.
 * Called once during module initialisation.
 */
export function setupChatLog() {
  Hooks.on("renderChatMessage", (message, html) => {
    if (!getConnectionStatus()) return;
    const element = html instanceof jQuery ? html[0] : (html?.element || html);
    if (!element) return;
    sendMessage({
      type: "chatMessage",
      messageId: message.id,
      html: element.outerHTML
    });
  });
  debug("Chat log: renderChatMessage hook registered");
}

/**
 * Send all current stylesheet URLs and existing chat messages to DLA.
 * Called once the DLA connection is confirmed (and on reconnect).
 */
export function sendInitialChatHistory() {
  // Collect every stylesheet loaded in this Foundry page so DLA can replicate the styling
  const styleUrls = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .map(link => link.href)
    .filter(href => href && href.startsWith("http"));

  sendMessage({
    type: "chatInit",
    foundryUrl: window.location.origin,
    styleUrls
  });

  // Send all messages currently visible in the chat log
  const chatLog = document.getElementById("chat-log");
  if (!chatLog) return;

  const messages = chatLog.querySelectorAll("li.chat-message");
  debug(`Chat log: sending ${messages.length} existing messages to DLA`);
  messages.forEach(msg => {
    sendMessage({
      type: "chatMessage",
      messageId: msg.dataset?.messageId || "",
      html: msg.outerHTML
    });
  });
}
