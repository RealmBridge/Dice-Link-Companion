/**
 * dice-panel.js - the DLC panel (opened from the D20 button in Foundry's scene controls):
 * opens it, refreshes it, and handles every button and switch on it, for the GM panel
 * and the player panel. The panel's HTML comes from ui-templates.js.
 */

import { ROLE_NAMES, GLOBAL_OVERRIDE_MODES, PLAYER_MODES } from "./constants.js";
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
import { applyMode, applyModeForOverride } from "./mode-application.js";
import { approveManualRequest, denyManualRequest } from "./approval.js";
import { playerRequestManual, playerSwitchToDigital, emitToPlayers } from "./socket.js";
import { generatePanelContent } from "./ui-templates.js";

debug("dice-panel.js: All imports complete");

// What the GM sees when they change the group override
const OVERRIDE_NOTICES = {
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL]: "Forced all to manual dice.",
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL]: "Forced all to digital dice.",
  [GLOBAL_OVERRIDE_MODES.INDIVIDUAL]: "Set to individual control."
};

// ============================================================================
// PANEL MANAGEMENT
// ============================================================================

/**
 * Players' modes or requests changed: tell DLA (main.mjs listens for this hook and sends
 * it the player list) and redraw the panel.
 */
export function modesChanged() {
  Hooks.call("diceLink.playerModeChanged");
  refreshPanel();
}

/**
 * Refresh the panel content without recreating the dialog
 */
export function refreshPanel() {
  const panelDialog = getCurrentPanelDialog();
  if (panelDialog && panelDialog.rendered) {
    // ApplicationV2 returns HTMLElement, not jQuery - wrap in jQuery for compatibility
    const $element = $(panelDialog.element);
    const contentElement = $element.find(".window-content");

    contentElement.html(generatePanelContent(panelDialog.isGM));
    attachPanelListeners($element, panelDialog.isGM);

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
 * Fold / unfold a section when its heading is clicked (both panels), remembering it
 */
function attachSectionToggles(html) {
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
}

/**
 * Hook up the panel's buttons and switches: the GM panel's or the player panel's
 */
export function attachPanelListeners(html, isGM) {
  if (isGM) attachGMPanelListeners(html);
  else attachPlayerPanelListeners(html);
}

/**
 * Attach all event listeners for the GM panel
 */
function attachGMPanelListeners(html) {
  attachSectionToggles(html);

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
    const forced = $(this).hasClass("dlc-override-manual")
      ? GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL : GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL;
    const mode = $(this).is(":checked") ? forced : GLOBAL_OVERRIDE_MODES.INDIVIDUAL;
    await setGlobalOverride(mode);
    applyModeForOverride(mode);
    emitToPlayers({ action: "globalOverride", mode });
    ui.notifications.info(OVERRIDE_NOTICES[mode]);
    modesChanged();
  });

  // GM mode toggle (switch style)
  html.find(".dlc-gm-mode-toggle").change(async function() {
    const isManual = $(this).is(":checked");
    const newMode = isManual ? PLAYER_MODES.MANUAL : PLAYER_MODES.DIGITAL;

    await setPlayerMode(game.user.id, newMode);
    applyMode(newMode);
    ui.notifications.info(isManual ? "Your dice: Manual" : "Your dice: Digital");
    modesChanged();
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
    
    await setPlayerMode(playerId, PLAYER_MODES.DIGITAL);

    emitToPlayers({
      action: "revokeMode",
      playerId: playerId
    });

    ui.notifications.info(`Revoked manual dice for ${player.name}.`);
    modesChanged();
  });

}

/**
 * Attach all event listeners for the Player panel
 */
function attachPlayerPanelListeners(html) {
  attachSectionToggles(html);

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
