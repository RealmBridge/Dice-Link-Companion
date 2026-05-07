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
  const origin = window.location.origin;
  const linkElements = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
    .filter(link => link.href && link.href.startsWith("http"));

  // Separate same-origin sheets (need fetching) from external CDN sheets (send as URL)
  const sameOriginLinks = linkElements.filter(link => link.href.startsWith(origin));
  const externalUrls = linkElements
    .filter(link => !link.href.startsWith(origin))
    .map(link => link.href);

  // Fetch same-origin stylesheet text and rewrite relative url() paths
  const fetchResults = await Promise.allSettled(
    sameOriginLinks.map(link =>
      fetch(link.href)
        .then(r => r.text())
        .then(text => makeStyleUrlsAbsolute(text, link.href))
    )
  );
  const fetchedStyleTexts = fetchResults
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value);

  // Inline <style> block content
  const inlineStyleTexts = Array.from(document.querySelectorAll("style"))
    .map(s => s.textContent)
    .filter(t => t.trim());

  const styleTexts = [...fetchedStyleTexts, ...inlineStyleTexts];

  // Existing messages — batched into one payload.
  // Foundry may not have rendered messages to the DOM yet when this function is
  // called during the ready hook, so retry once after 2 seconds if the list is empty.
  async function collectAndSend(styleTexts, externalUrls, origin) {
    const chatLog = document.querySelector("ol.chat-log");
    const messages = chatLog
      ? Array.from(chatLog.querySelectorAll("li.chat-message")).map(msg => makeAbsolute(msg.outerHTML))
      : [];

    if (messages.length === 0 && chatLog) {
      debug("Chat log: 0 messages found, retrying in 2s...");
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retryMessages = Array.from(chatLog.querySelectorAll("li.chat-message")).map(msg => makeAbsolute(msg.outerHTML));
      debug(`Chat log: sending ${retryMessages.length} messages after retry, ${styleTexts.length} inline styles, ${externalUrls.length} external style URLs`);
      sendMessage({ type: "chatInit", foundryUrl: origin, styleUrls: externalUrls, styleTexts, messages: retryMessages });
      return;
    }

    debug(`Chat log: sending ${messages.length} messages, ${styleTexts.length} inline styles, ${externalUrls.length} external style URLs`);
    sendMessage({ type: "chatInit", foundryUrl: origin, styleUrls: externalUrls, styleTexts, messages });
  }

  await collectAndSend(styleTexts, externalUrls, origin);
}
