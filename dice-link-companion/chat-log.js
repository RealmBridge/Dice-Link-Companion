/**
 * Chat Log Module - dice-link-companion
 * Forwards Foundry chat messages to DLA via QWebChannel.
 */

import { sendMessage, getConnectionStatus } from "./qwebchannel-client.js";
import { debug, debugChatLog } from "./debug.js";

/**
 * Return the tag+class skeleton of an element tree as a plain string.
 * Used for CSS diagnostics — logs structure without any text content so the
 * full nesting and class names are readable in the CMD prompt.
 * TEMPORARY — remove once chat card CSS is correct.
 */
function getStructure(el, depth) {
  depth = depth || 0;
  if (!el || !el.tagName) return "";
  const indent = "  ".repeat(depth);
  const classes = el.className ? "." + String(el.className).trim().replace(/\s+/g, ".") : "";
  const tag = el.tagName.toLowerCase();
  let extra = "";
  if (tag === "img") {
    const src = el.getAttribute("src") || "";
    extra = " src=\"" + (src.length > 60 ? src.slice(0, 60) + "..." : src) + "\"";
  }
  let result = indent + "<" + tag + classes + extra + ">";
  for (let i = 0; i < el.children.length; i++) {
    const child = getStructure(el.children[i], depth + 1);
    if (child) result += "\n" + child;
  }
  return result;
}

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

    // Skip messages created before this connection was established.
    // Some modules re-render old messages at load time, which would cause
    // them to appear as new messages in DLA. Any message older than 2 minutes
    // when the hook fires is treated as a historical re-render, not a new message.
    if (message.timestamp && (Date.now() - message.timestamp) > 120000) {
      debugChatLog("renderChatMessageHTML: skipping old message", message.id);
      return;
    }

    const li = element?.closest?.("li.chat-message") || element;
    if (!li) {
      debugChatLog("renderChatMessageHTML: no li.chat-message found, skipping");
      return;
    }

    debugChatLog("MSG STRUCTURE [" + message.id + "]\n" + getStructure(li));
    sendMessage({
      type: "chatMessage",
      messageId: message.id,
      html: makeAbsolute(li.outerHTML)
    });

    // DIAGNOSTIC: watch for MIDI post-render DOM mutations on player damage cards
    if (li.querySelector('.midi-qol-player-damage-card')) {
      const dmgSpan = li.querySelector('.midi-qol-dmg-text');
      debugChatLog("PLAYER-DMG INITIAL [" + message.id + "] dmg-text innerHTML: " + (dmgSpan ? dmgSpan.innerHTML : "NOT FOUND"));

      let mutationCount = 0;
      const observer = new MutationObserver(() => {
        mutationCount++;
        const span = li.querySelector('.midi-qol-dmg-text');
        debugChatLog("MUTATION #" + mutationCount + " [" + message.id + "] li.classes=" + li.className + " | dmg-text innerHTML: " + (span ? span.innerHTML : "NOT FOUND"));
        debugChatLog("MUTATION #" + mutationCount + " STRUCTURE [" + message.id + "]\n" + getStructure(li));
        if (mutationCount >= 5) {
          observer.disconnect();
          debugChatLog("MUTATION OBSERVER DISCONNECTED [" + message.id + "] after " + mutationCount + " batches");
        }
      });
      observer.observe(li, { childList: true, subtree: true, characterData: true, attributes: true });
    }
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
  sendMessage({ type: "chatInit" });
}
