/**
 * approval.js - manual dice by permission, on every screen involved: a player asking for
 * manual dice, the GM's Approve / Deny, the GM taking it away again (Revoke), and a player
 * switching back to digital. Each of these is written here once; the chat card buttons,
 * the DLC panel buttons and the Approve / Deny buttons in the Dice Link App all call them.
 */

import { PLAYER_MODES, GLOBAL_OVERRIDE_MODES } from "./constants.js";
import { debug } from "./debug.js";
import {
  setPlayerMode,
  getGlobalOverride,
  getPendingRequests,
  setPendingRequests,
  overrideAllowsManualRequest,
  overrideAllowsSwitchToDigital
} from "./settings.js";
import { modesChanged, refreshPanel } from "./dice-panel.js";
import { emitToPlayers, onPlayerMessage } from "./socket.js";
import { createRequestChatMessage, createApprovalChatMessage } from "./chat.js";
import { applyMode, applyDigitalDice } from "./mode-application.js";
import { onDLAMessage } from "./qwebchannel-client.js";

// ============================================================================
// THE PLAYER: asking for manual dice, and switching back to digital
// ============================================================================

export function playerRequestManual() {
  const globalOverride = getGlobalOverride();

  if (!overrideAllowsManualRequest(globalOverride)) {
    ui.notifications.warn(globalOverride === GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL
      ? "Manual dice is already globally forced by the GM."
      : "Digital dice is globally forced by the GM. Cannot request manual.");
    return;
  }

  emitToPlayers({
    action: "playerRequestManual",
    playerId: game.user.id,
    playerName: game.user.name
  });

  ui.notifications.info("Manual dice request sent to GM.");
}

export function playerSwitchToDigital() {
  if (!overrideAllowsSwitchToDigital()) {
    ui.notifications.warn("Manual dice is globally forced by the GM. Cannot switch to digital.");
    return;
  }

  emitToPlayers({
    action: "playerSwitchToDigital",
    playerId: game.user.id
  });

  applyDigitalDice();
  ui.notifications.info("Switched to digital dice.");
}

// ============================================================================
// THE GM: Approve, Deny and Revoke
// ============================================================================

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
 * Take manual dice away from a player (the GM panel's revoke corner): they go back to
 * digital dice.
 * @param {string} playerId
 */
export async function revokeManualDice(playerId) {
  const player = game.users.get(playerId);
  if (!player) return;

  await setPlayerMode(playerId, PLAYER_MODES.DIGITAL);

  // Switch the player's dice back to digital on their own screen
  emitToPlayers({ action: "revokeMode", playerId });

  ui.notifications.info(`Revoked manual dice for ${player.name}.`);
  modesChanged();
}

// ============================================================================
// THE OTHER SCREENS: what arrives from the player or the GM
// ============================================================================

/** A player asked for manual dice: the GM's screen notes the request and posts the chat cards. */
async function receiveManualRequest({ playerId, playerName }) {
  if (!game.user.isGM) return;

  const pending = getPendingRequests();
  if (!pending.some(req => req.playerId === playerId)) {
    pending.push({ playerId, playerName });
    await setPendingRequests(pending);
  }

  await createRequestChatMessage(playerId, playerName);
  ui.notifications.warn(`${playerName} requested manual dice mode.`);
  modesChanged();
}

/** A player switched back to digital: the GM's screen saves it; the others show it. */
async function receiveSwitchToDigital({ playerId }) {
  if (game.user.isGM) {
    await setPlayerMode(playerId, PLAYER_MODES.DIGITAL);
    modesChanged();
  } else {
    // Another player switched to digital, refresh our panel to see the update
    refreshPanel();
  }
}

/** The GM approved this player's request: switch their dice over. The others show it. */
function receiveApproval({ playerId, mode }) {
  if (playerId === game.user.id) {
    applyMode(mode);
    ui.notifications.info(mode === PLAYER_MODES.MANUAL ? "Manual dice mode activated!" : "Digital dice mode activated!");
  }
  // (another player's mode changed: our panel shows the update too)
  refreshPanel();
}

/** The GM revoked this player's manual dice: back to digital. The others show it. */
function receiveRevoke({ playerId }) {
  if (playerId === game.user.id) {
    applyDigitalDice();
    ui.notifications.warn("GM has revoked your manual dice mode.");
  }
  // (another player's mode was revoked: our panel shows the update too)
  refreshPanel();
}

// ============================================================================
// SETUP
// ============================================================================

/**
 * Hook up the Approve / Deny buttons on the chat cards and, for the GM, in DLA's player
 * list, and the messages each screen receives about manual dice. Called from main.mjs setup.
 */
export function setupApprovalButtons() {
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

  // The GM pressed Approve / Deny in DLA's player list: same as the chat card buttons
  if (game.user?.isGM) {
    onDLAMessage("playerModeAction", ({ action, playerId }) => {
      debug("Player mode action from DLA", { action, playerId });
      if (!playerId) return;
      if (action === "approve") approveManualRequest(playerId);
      else if (action === "deny") denyManualRequest(playerId);
    });
  }

  onPlayerMessage("playerRequestManual", receiveManualRequest);
  onPlayerMessage("playerSwitchToDigital", receiveSwitchToDigital);
  onPlayerMessage("applyMode", receiveApproval);
  onPlayerMessage("revokeMode", receiveRevoke);
}
