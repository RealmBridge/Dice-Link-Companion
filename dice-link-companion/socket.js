/**
 * socket.js - DLC's messages between the players' Foundry screens (Foundry's module socket).
 * Sends every DLC script's messages to the other screens (emitToPlayers), and passes each
 * message that arrives to the DLC script that registered for it (onPlayerMessage) - the
 * same way qwebchannel-client.js does for the messages from DLA.
 * Every message is checked here, in one place, against who really sent it: Foundry's server
 * adds the sender's user id from their own login, so a message can't claim to come from
 * someone else, and a GM's message is only taken from a GM.
 */

import { MODULE_ID } from "./constants.js";
import { debug } from "./debug.js";

// The DLC function handling each message from the other screens, and who may send it
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
 * action. It receives the whole message and the Foundry user who really sent it, e.g.
 * onPlayerMessage("breakEnd", (data, sender) => ..., { from: "gm" }). A handler that needs
 * the sender's id or name takes it from the sender, never from the message.
 * @param {"player"|"gm"} [from] - "gm": only a GM may send it; "player" (default): any user
 */
export function onPlayerMessage(action, handler, { from = "player" } = {}) {
  handlers[action] = { handler, from };
}

/**
 * Start listening for messages from the other screens. Called from main.mjs setup.
 */
export function setupSocketListeners() {
  game.socket.on(`module.${MODULE_ID}`, async (data, senderId) => {
    const entry = handlers[data?.action];
    const sender = game.users.get(senderId);
    if (!entry || !sender || (entry.from === "gm" && !sender.isGM)) {
      debug("Message refused", { action: data?.action, senderId });
      return;
    }
    await entry.handler(data, sender);
  });
}
