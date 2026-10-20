/**
 * dice-panel.js - the DLC panel (opened from the D20 button in Foundry's scene controls):
 * opens it, refreshes it, and handles every button and switch on it, for the GM panel
 * and the player panel. The panel's HTML comes from ui-templates.js.
 */

import { MODULE_ID, ROLE_NAMES } from "./constants.js";
import { debug, debugState } from "./debug.js";
import {
  getCurrentPanelDialog,
  setCurrentPanelDialog
} from "./state-management.js";
import {
  setGlobalOverride,
  setPlayerMode,
  getCollapsedSections,
  setCollapsedSections
} from "./settings.js";
import { setManualRollsPermission } from "./settings-helpers.js";
import { applyManualDice, applyDigitalDice, applyModeForOverride } from "./mode-application.js";
import { approveManualRequest, denyManualRequest } from "./approval.js";
import { playerRequestManual, playerSwitchToDigital } from "./socket.js";
import { generateGMPanelContent, generatePlayerPanelContent } from "./ui-templates.js";

debug("dice-panel.js: All imports complete");

// What the GM sees when they change the group override
const OVERRIDE_NOTICES = {
  forceAllManual: "Forced all to manual dice.",
  forceAllDigital: "Forced all to digital dice.",
  individual: "Set to individual control."
};

// ============================================================================
// PANEL MANAGEMENT
// ============================================================================

/**
 * Refresh the panel content without recreating the dialog
 */
export function refreshPanel() {
  const panelDialog = getCurrentPanelDialog();
  if (panelDialog && panelDialog.rendered) {
    const isGM = panelDialog.isGM;
    const newContent = isGM ? generateGMPanelContent() : generatePlayerPanelContent();
    
    // ApplicationV2 returns HTMLElement, not jQuery - wrap in jQuery for compatibility
    const $element = $(panelDialog.element);
    const contentElement = $element.find(".window-content");
    
    contentElement.html(newContent);
    
    if (isGM) {
      attachGMPanelListeners($element);
    } else {
      attachPlayerPanelListeners($element);
    }

    // Recalculate height only, preserve width to prevent stretching
    const fixedWidth = panelDialog.position?.width || 480;
    panelDialog.setPosition({ height: "auto", width: fixedWidth });
  }
}

/**
 * Open the DLC panel (or bring to front if already open)
 * @param {Function} DiceLinkCompanionApp - The Application class to instantiate
 */
export function openPanel(DiceLinkCompanionApp) {
  debug("openPanel called");
  const panelDialog = getCurrentPanelDialog();
  debugState("getCurrentPanelDialog returned", panelDialog);
  // If panel already exists and is rendered, just bring it to front - don't recreate
  if (panelDialog && panelDialog.rendered) {
    debug("Panel exists and rendered, bringing to top");
    panelDialog.bringToFront();
    return;
  }
  
  // If panel exists but not rendered, close it first
  if (panelDialog) {
    debug("Panel exists but not rendered, closing first");
    try {
      panelDialog.close();
    } catch (e) {
      // Ignore errors from closing
    }
  }

  debug("Creating new panel dialog");
  const isGM = game.user.isGM;
  const newPanelDialog = new DiceLinkCompanionApp(isGM);
  debug("Setting currentPanelDialog");
  setCurrentPanelDialog(newPanelDialog);
  debug("Rendering panel");
  newPanelDialog.render(true);
}

// ============================================================================
// PANEL LISTENERS
// ============================================================================

/**
 * Attach all event listeners for the GM panel
 */
export function attachGMPanelListeners(html) {
  // Collapse/expand sections
  html.find(".dlc-section-header").click( function() {
    const section = $(this).data("section");
    const currentCollapsed = getCollapsedSections();
    if (section && currentCollapsed.hasOwnProperty(section)) {
      currentCollapsed[section] = !currentCollapsed[section];
      // Save collapsed state to settings
      setCollapsedSections(currentCollapsed);
      refreshPanel();
    }
  });

  // Role permission toggles
  html.find(".dlc-role-toggle").change(async function() {
    const role = parseInt($(this).data("role"));
    const enabled = $(this).is(":checked");
    const success = await setManualRollsPermission(role, enabled);
    if (success) {
      ui.notifications.info(`Manual rolls ${enabled ? 'enabled' : 'disabled'} for ${ROLE_NAMES[role]}.`);
    }
    refreshPanel();
  });

  // Refresh button
  html.find(".dlc-refresh-btn").click( function() {
    refreshPanel();
    ui.notifications.info("Panel refreshed.");
  });

  // Group override switches: ticking Manual or Digital forces everyone into it; unticking
  // returns everyone to their own setting. The GM's own screen is switched here, because
  // the socket message only reaches the other players.
  html.find(".dlc-override-manual, .dlc-override-digital").change(async function() {
    const forced = $(this).hasClass("dlc-override-manual") ? "forceAllManual" : "forceAllDigital";
    const mode = $(this).is(":checked") ? forced : "individual";
    await setGlobalOverride(mode);
    applyModeForOverride(mode);
    game.socket.emit(`module.${MODULE_ID}`, { action: "globalOverride", mode });
    ui.notifications.info(OVERRIDE_NOTICES[mode]);
    Hooks.call("diceLink.playerModeChanged");
    refreshPanel();
  });

  // GM mode toggle (switch style)
  html.find(".dlc-gm-mode-toggle").change(async function() {
    const isManual = $(this).is(":checked");
    const newMode = isManual ? "manual" : "digital";
    
    await setPlayerMode(game.user.id, newMode);
    
    if (newMode === "manual") {
      applyManualDice();
      ui.notifications.info("Your dice: Manual");
    } else {
      applyDigitalDice();
      ui.notifications.info("Your dice: Digital");
    }
    Hooks.call("diceLink.playerModeChanged");
    refreshPanel();
  });

  // Approve / Deny buttons (approval.js does the work)
  html.find(".dlc-panel-approve").click(function() {
    approveManualRequest($(this).data("player-id"));
  });

  html.find(".dlc-panel-deny").click(function() {
    denyManualRequest($(this).data("player-id"));
  });

  // Revoke buttons
  html.find(".dlc-panel-revoke").click( async function() {
    const playerId = $(this).data("player-id");
    const player = game.users.get(playerId);
    if (!player) return;
    
    await setPlayerMode(playerId, "digital");
    
    game.socket.emit(`module.${MODULE_ID}`, {
      action: "revokeMode",
      playerId: playerId
    });
    
    ui.notifications.info(`Revoked manual dice for ${player.name}.`);
    Hooks.call("diceLink.playerModeChanged");
    refreshPanel();
  });

}

/**
 * Attach all event listeners for the Player panel
 */
export function attachPlayerPanelListeners(html) {
  // Collapse/expand sections
  html.find(".dlc-section-header").click( function() {
    const section = $(this).data("section");
    const currentCollapsed = getCollapsedSections();
    if (section && currentCollapsed.hasOwnProperty(section)) {
      currentCollapsed[section] = !currentCollapsed[section];
      // Save collapsed state to settings
      setCollapsedSections(currentCollapsed);
      refreshPanel();
    }
  });

  // Request manual button
  html.find(".dlc-player-request").click( function() {
    playerRequestManual();
    refreshPanel();
  });

  // Switch to digital button
  html.find(".dlc-player-digital").click( function() {
    playerSwitchToDigital();
    refreshPanel();
  });

}
