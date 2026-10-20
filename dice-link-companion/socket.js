/**
 * socket.js - DLC's messages between the players' Foundry screens (Foundry's module socket).
 * Sends every DLC script's messages to the other screens (emitToPlayers), and passes each
 * message that arrives to the DLC script that registered for it (onPlayerMessage) - the
 * same way qwebchannel-client.js does for the messages from DLA.
 */

import { MODULE_ID } from "./constants.js";

// The DLC function handling each message from the other screens, by its action
const handlers = {};

/**
 * Send a message to the other players' Foundry screens over Foundry's module socket (it
 * never comes back to this screen). Every DLC script sends its messages through here.
 */
export function emitToPlayers(data) {
  game.socket.emit(`module.${MODULE_ID}`, data);
}

/**
 * Register the DLC function that handles one message from the other screens, by its
 * action. It receives the whole message, e.g. onPlayerMessage("breakEnd", (data) => ...).
 */
export function onPlayerMessage(action, handler) {
  handlers[action] = handler;
}

/**
 * Start listening for messages from the other screens. Called from main.mjs setup.
 */
export function setupSocketListeners() {
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    const handler = handlers[data.action];
    if (handler) await handler(data);
  });
}
