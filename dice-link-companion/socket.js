/**
 * Socket.js - Socket communication and player functions
 * Handles cross-client communication for dice mode changes
 */

import { MODULE_ID } from "./constants.js";

import {
  getPlayerMode,
  setPlayerMode,
  getGlobalOverride,
  setGlobalOverride,
  getPendingRequests,
  setPendingRequests
} from "./settings.js";

import { createRequestChatMessage } from "./chat.js";
import { refreshPanel } from "./dice-panel.js";
import { applyManualDice, applyDigitalDice } from "./mode-application.js";
import { setHasRequestedThisSession } from "./state-management.js";
import { showDiceStreamFrame, endDiceStream } from "./video-feed.js";

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
      Hooks.call("diceLink.playerModeChanged");
      refreshPanel();
    }

    if (game.user.isGM && data.action === "playerSwitchToDigital") {
      await setPlayerMode(data.playerId, "digital");
      Hooks.call("diceLink.playerModeChanged");
      refreshPanel();
    } else if (data.action === "playerSwitchToDigital") {
      // Another player switched to digital, refresh our panel to see the update
      refreshPanel();
    }

    if (data.action === "applyMode" && data.playerId === game.user.id) {
      if (data.mode === "manual") {
        applyManualDice();
        setHasRequestedThisSession(false);
        ui.notifications.info("Manual dice mode activated!");
      } else {
        applyDigitalDice();
        ui.notifications.info("Digital dice mode activated!");
      }
      refreshPanel();
    } else if (data.action === "applyMode") {
      // Another player's mode changed, refresh our panel to see the update
      refreshPanel();
    }

    if (data.action === "globalOverride") {
      if (data.mode === "forceAllManual") {
        applyManualDice();
        ui.notifications.info("GM has forced manual dice for everyone.");
      } else if (data.mode === "forceAllDigital") {
        applyDigitalDice();
        ui.notifications.info("GM has forced digital dice for everyone.");
      } else if (data.mode === "individual") {
        // Revert to player's own stored mode
        const myMode = getPlayerMode();
        if (myMode === "manual") {
          applyManualDice();
        } else {
          applyDigitalDice();
        }
        ui.notifications.info("GM has returned to individual control.");
      }
      refreshPanel();
    }

    if (data.action === "revokeMode" && data.playerId === game.user.id) {
      applyDigitalDice();
      setHasRequestedThisSession(false);
      ui.notifications.warn("GM has revoked your manual dice mode.");
      refreshPanel();
    } else if (data.action === "revokeMode") {
      // Another player's mode was revoked, refresh our panel to see the update
      refreshPanel();
    }

    if (data.action === "requestDenied" && data.playerId === game.user.id) {
      setHasRequestedThisSession(false);
    }

    if (data.action === "cameraFrame") {
      showDiceStreamFrame(data.frameB64);
    }

    if (data.action === "cameraStreamEnd") {
      endDiceStream();
    }
  });
}

// ============================================================================
// PLAYER FUNCTIONS
// ============================================================================

export function playerRequestManual() {
  const globalOverride = getGlobalOverride();
  
  if (globalOverride === "forceAllManual") {
    ui.notifications.warn("Manual dice is already globally forced by the GM.");
    return;
  }
  if (globalOverride === "forceAllDigital") {
    ui.notifications.warn("Digital dice is globally forced by the GM. Cannot request manual.");
    return;
  }

  game.socket.emit(`module.${MODULE_ID}`, {
    action: "playerRequestManual",
    playerId: game.user.id,
    playerName: game.user.name
  });

  ui.notifications.info("Manual dice request sent to GM.");
}

export function playerSwitchToDigital() {
  const globalOverride = getGlobalOverride();
  
  if (globalOverride === "forceAllManual") {
    ui.notifications.warn("Manual dice is globally forced by the GM. Cannot switch to digital.");
    return;
  }

  game.socket.emit(`module.${MODULE_ID}`, {
    action: "playerSwitchToDigital",
    playerId: game.user.id
  });

  applyDigitalDice();
  setHasRequestedThisSession(false);
  ui.notifications.info("Switched to digital dice.");
}
