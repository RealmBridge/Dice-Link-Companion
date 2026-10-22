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
import { emitToPlayers, onPlayerMessage } from "./socket.js";
import { createRequestChatMessage, createApprovalChatMessage } from "./chat.js";
import { applyMode, applyDigitalDice } from "./mode-application.js";
import { onDLAMessage } from "./qwebchannel-client.js";

// ---- The player: asking for manual dice, and switching back to digital ----

export function playerRequestManual() {
  const globalOverride = getGlobalOverride();

  if (!overrideAllowsManualRequest(globalOverride)) {
    ui.notifications.warn(globalOverride === GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL
      ? game.i18n.localize("DICE_LINK.Notify.AlreadyManual")
      : game.i18n.localize("DICE_LINK.Notify.CantRequest"));
    return;
  }

  emitToPlayers({
    action: "playerRequestManual",
    playerId: game.user.id,
    playerName: game.user.name
  });

  ui.notifications.info(game.i18n.localize("DICE_LINK.Notify.RequestSent"));
}

export function playerSwitchToDigital() {
  if (!overrideAllowsSwitchToDigital()) {
    ui.notifications.warn(game.i18n.localize("DICE_LINK.Notify.CantSwitch"));
    return;
  }

  emitToPlayers({
    action: "playerSwitchToDigital",
    playerId: game.user.id
  });

  applyDigitalDice();
  ui.notifications.info(game.i18n.localize("DICE_LINK.Notify.SwitchedDigital"));
}

// ---- The GM: Approve, Deny and Revoke ----

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
    ui.notifications.error(game.i18n.localize(approved ? "DICE_LINK.Notify.OnlyGMApprove" : "DICE_LINK.Notify.OnlyGMDeny"));
    return;
  }

  const player = game.users.get(playerId);
  if (!player) {
    ui.notifications.error(game.i18n.localize("DICE_LINK.Notify.PlayerNotFound"));
    return;
  }

  // Remove the buttons from every chat card for this player's request
  $(`.dlc-chat-approve[data-player-id="${playerId}"], .dlc-chat-deny[data-player-id="${playerId}"]`).each(function() {
    $(this).closest(".dlc-chat-buttons").html(`<em>${game.i18n.localize(approved ? "DICE_LINK.Chat.AnsweredApproved" : "DICE_LINK.Chat.AnsweredDenied")}</em>`);
  });

  if (approved) await setPlayerMode(playerId, PLAYER_MODES.MANUAL);

  const pending = getPendingRequests().filter(req => req.playerId !== playerId);
  await setPendingRequests(pending);

  // Switch the approved player's dice over on their own screen
  if (approved) emitToPlayers({ action: "applyMode", playerId, mode: PLAYER_MODES.MANUAL });

  await createApprovalChatMessage(playerId, player.name, approved);
  ui.notifications.info(game.i18n.format(approved ? "DICE_LINK.Notify.Approved" : "DICE_LINK.Notify.Denied", { name: player.name }));
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

  ui.notifications.info(game.i18n.format("DICE_LINK.Notify.Revoked", { name: player.name }));
}

// ---- The other screens: what arrives from the player or the GM ----

/** A player asked for manual dice: the GM's screen notes the request and posts the chat cards. */
async function receiveManualRequest({ playerId, playerName }) {
  if (!game.user.isGM) return;

  const pending = getPendingRequests();
  if (!pending.some(req => req.playerId === playerId)) {
    pending.push({ playerId, playerName });
    await setPendingRequests(pending);
  }

  await createRequestChatMessage(playerId, playerName);
  ui.notifications.warn(game.i18n.format("DICE_LINK.Notify.PlayerRequested", { name: playerName }));
}

/** A player switched back to digital: the GM's screen saves it (players can't save it). */
async function receiveSwitchToDigital({ playerId }) {
  if (game.user.isGM) await setPlayerMode(playerId, PLAYER_MODES.DIGITAL);
}

/** The GM approved this player's request: switch their dice over to manual. */
function receiveApproval({ playerId, mode }) {
  if (playerId !== game.user.id) return;
  applyMode(mode);
  ui.notifications.info(game.i18n.localize("DICE_LINK.Notify.ManualOn"));
}

/** The GM revoked this player's manual dice: back to digital. */
function receiveRevoke({ playerId }) {
  if (playerId !== game.user.id) return;
  applyDigitalDice();
  ui.notifications.warn(game.i18n.localize("DICE_LINK.Notify.BackToDigital"));
}

// ---- Setup ----

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
