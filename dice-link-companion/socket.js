/**
 * socket.js - messages between the players' Foundry screens (Foundry's module socket).
 * Receives: manual dice requests and switches (for the GM), mode changes, the GM's group
 * override, other players' dice clips, and session breaks. Every DLC script sends its
 * messages through emitToPlayers here. Also holds the two player actions that send a
 * message: request manual dice, and switch back to digital.
 */

import { MODULE_ID, GLOBAL_OVERRIDE_MODES, PLAYER_MODES } from "./constants.js";

import {
  setPlayerMode,
  getGlobalOverride,
  getPendingRequests,
  setPendingRequests,
  overrideAllowsManualRequest,
  overrideAllowsSwitchToDigital
} from "./settings.js";

import { createRequestChatMessage } from "./chat.js";
import { refreshPanel, modesChanged } from "./dice-panel.js";
import { applyDigitalDice, applyMode, applyModeForOverride } from "./mode-application.js";
import { showDiceStreamFrame, endDiceStream } from "./video-feed.js";
import { clipShownToMe } from "./clip-visibility.js";
import { showBreakOverlay, markPlayerStatus, endBreak } from "./break-manager.js";

/**
 * Send a message to the other players' Foundry screens over Foundry's module socket (it
 * never comes back to this screen). Every DLC script sends its messages through here.
 */
export function emitToPlayers(data) {
  game.socket.emit(`module.${MODULE_ID}`, data);
}

// What each player sees when the GM changes the group override
const OVERRIDE_NOTICES = {
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL]: "GM has forced manual dice for everyone.",
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL]: "GM has forced digital dice for everyone.",
  [GLOBAL_OVERRIDE_MODES.INDIVIDUAL]: "GM has returned to individual control."
};

// ============================================================================
// SOCKET LISTENERS
// ============================================================================

export function setupSocketListeners() {
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (game.user.isGM && data.action === "playerRequestManual") {
      let pending = getPendingRequests();
      
      if (!pending.some(req => req.playerId === data.playerId)) {
        pending.push({ playerId: data.playerId, playerName: data.playerName });
        await setPendingRequests(pending);
      }

      await createRequestChatMessage(data.playerId, data.playerName);
      ui.notifications.warn(`${data.playerName} requested manual dice mode.`);
      modesChanged();
    }

    if (game.user.isGM && data.action === "playerSwitchToDigital") {
      await setPlayerMode(data.playerId, PLAYER_MODES.DIGITAL);
      modesChanged();
    } else if (data.action === "playerSwitchToDigital") {
      // Another player switched to digital, refresh our panel to see the update
      refreshPanel();
    }

    if (data.action === "applyMode" && data.playerId === game.user.id) {
      applyMode(data.mode);
      ui.notifications.info(data.mode === PLAYER_MODES.MANUAL ? "Manual dice mode activated!" : "Digital dice mode activated!");
      refreshPanel();
    } else if (data.action === "applyMode") {
      // Another player's mode changed, refresh our panel to see the update
      refreshPanel();
    }

    if (data.action === "globalOverride" && OVERRIDE_NOTICES[data.mode]) {
      applyModeForOverride(data.mode);
      ui.notifications.info(OVERRIDE_NOTICES[data.mode]);
      refreshPanel();
    }

    if (data.action === "revokeMode" && data.playerId === game.user.id) {
      applyDigitalDice();
      ui.notifications.warn("GM has revoked your manual dice mode.");
      refreshPanel();
    } else if (data.action === "revokeMode") {
      // Another player's mode was revoked, refresh our panel to see the update
      refreshPanel();
    }

    if (data.action === "cameraFrame") {
      // Private rolls: only the people allowed to see this clip draw it (clip-visibility.js).
      if (clipShownToMe(data.visibility, data.rollerIsGM, game.user.isGM)) {
        showDiceStreamFrame(data.frameB64, data.userId);
      }
    }

    if (data.action === "cameraStreamEnd") {
      endDiceStream(data.userId);
    }

    if (data.action === "breakStart") {
      showBreakOverlay(data.durationMinutes, data.players);
    }

    if (data.action === "breakPlayerBack" || data.action === "breakPlayerAway") {
      markPlayerStatus(data.userId, data.action === "breakPlayerBack");
    }

    if (data.action === "breakEnd") {
      endBreak(false);
    }
  });
}

// ============================================================================
// PLAYER FUNCTIONS
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
