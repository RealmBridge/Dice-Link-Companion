/**
 * approval.js - the GM's answer to a player's request for manual dice.
 * Approve and Deny are written here once; the chat card buttons, the DLC panel buttons
 * and the Approve / Deny buttons in the Dice Link App all call them.
 */

import { MODULE_ID } from "./constants.js";
import { setPlayerMode, getPendingRequests, setPendingRequests } from "./settings.js";
import { refreshPanel } from "./dice-panel.js";

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

  if (approved) await setPlayerMode(playerId, "manual");

  const pending = getPendingRequests().filter(req => req.playerId !== playerId);
  await setPendingRequests(pending);

  game.socket.emit(`module.${MODULE_ID}`, approved
    ? { action: "applyMode", playerId, mode: "manual" }
    : { action: "requestDenied", playerId });

  await createApprovalChatMessage(playerId, player.name, approved);
  ui.notifications.info(`${approved ? "Approved" : "Denied"} manual dice for ${player.name}.`);
  Hooks.call("diceLink.playerModeChanged");

  // Refresh the panel to show updated state
  refreshPanel();
}

/**
 * Create a chat message showing approval/denial decision
 */
async function createApprovalChatMessage(playerId, playerName, approved) {
  const status = approved ? "APPROVED" : "DENIED";
  const color = approved ? "#10b981" : "#ef4444";

  const content = `
    <div class="dice-link-result" style="border-left: 4px solid ${color}; padding: 10px;">
      <p><strong>${playerName}</strong>'s request for manual dice has been <strong style="color: ${color};">${status}</strong>.</p>
    </div>
  `;

  await ChatMessage.create({
    content,
    whisper: [playerId, ...game.users.filter(u => u.isGM).map(u => u.id)]
  });
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
