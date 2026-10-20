/**
 * approval.js - the GM's answer to a player's request for manual dice.
 * Approve and Deny are written here once; the chat card buttons, the DLC panel buttons
 * and the Approve / Deny buttons in the Dice Link App all call them.
 */

import { PLAYER_MODES } from "./constants.js";
import { setPlayerMode, getPendingRequests, setPendingRequests } from "./settings.js";
import { modesChanged } from "./dice-panel.js";
import { emitToPlayers } from "./socket.js";
import { createApprovalChatMessage } from "./chat.js";

/**
 * Approve a player's request: they switch to manual dice.
 * @param {string} playerId
 */
export function approveManualRequest(playerId) {
  return answerManualRequest(playerId, true);
}

/**
 * Deny a player's request: they stay on digital dice.
 * @param {string} playerId
 */
export function denyManualRequest(playerId) {
  return answerManualRequest(playerId, false);
}

async function answerManualRequest(playerId, approved) {
  if (!game.user.isGM) {
    ui.notifications.error(`Only GMs can ${approved ? "approve" : "deny"} requests.`);
    return;
  }

  const player = game.users.get(playerId);
  if (!player) {
    ui.notifications.error("Player not found.");
    return;
  }

  // Remove the buttons from ALL chat messages for this player
  $(`.dlc-chat-approve[data-player-id="${playerId}"], .dlc-chat-deny[data-player-id="${playerId}"]`).each(function() {
    $(this).closest(".dlc-chat-buttons").html(`<em>Request ${approved ? "approved" : "denied"}</em>`);
  });

  if (approved) await setPlayerMode(playerId, PLAYER_MODES.MANUAL);

  const pending = getPendingRequests().filter(req => req.playerId !== playerId);
  await setPendingRequests(pending);

  // Switch the approved player's dice over on their own screen
  if (approved) emitToPlayers({ action: "applyMode", playerId, mode: PLAYER_MODES.MANUAL });

  await createApprovalChatMessage(playerId, player.name, approved);
  ui.notifications.info(`${approved ? "Approved" : "Denied"} manual dice for ${player.name}.`);
  modesChanged();
}

/**
 * Setup chat button handlers for approval/denial
 * Called from main.mjs setup
 */
export function setupChatButtonHandlers() {
  $(document).on("click", ".dlc-chat-approve", function(e) {
    e.preventDefault();
    e.stopPropagation();
    approveManualRequest($(this).data("player-id"));
  });

  $(document).on("click", ".dlc-chat-deny", function(e) {
    e.preventDefault();
    e.stopPropagation();
    denyManualRequest($(this).data("player-id"));
  });
}
