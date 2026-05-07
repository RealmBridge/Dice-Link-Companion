/**
 * Dice Panel Module - dice-link-companion
 * Handles panel lifecycle (open, close, refresh) and all panel event listeners.
 * This is the primary UI orchestration module.
 */

import { MODULE_ID, ROLE_NAMES } from "./constants.js";
import { debug, debugState, debugPanelInjection, debugComputedStyles, debugElementDimensions } from "./debug.js";
import {
  getCurrentPanelDialog,
  setCurrentPanelDialog
} from "./state-management.js";
import {
  setGlobalOverride,
  getGlobalOverride,
  setPlayerMode,
  getPlayerMode,
  getPendingRequests,
  setPendingRequests,
  getCollapsedSections,
  setCollapsedSections
} from "./settings.js";
import { setManualRollsPermission } from "./settings-helpers.js";
import { applyManualDice, applyDigitalDice } from "./mode-application.js";
import { createApprovalChatMessage } from "./approval.js";
import { playerRequestManual, playerSwitchToDigital } from "./socket.js";
import { generateGMPanelContent, generatePlayerPanelContent } from "./ui-templates.js";

debug("dice-panel.js: All imports complete");

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
    
    // After injection, constrain the nav to match the cloned dialog's actual rendered width
    const clonedDialogEl = contentElement.find(".dlc-cloned-system-dialog")[0];
    const navEl = contentElement.find(".dlc-cloned-system-dialog nav.dialog-buttons")[0];
    if (clonedDialogEl && navEl) {
      const dialogWidth = clonedDialogEl.offsetWidth;
      if (dialogWidth > 0) {
        navEl.style.width = `${dialogWidth}px`;
        navEl.style.maxWidth = `${dialogWidth}px`;
      }
    }
    
    // Log all element dimensions to diagnose stretching
    const panelElement = panelDialog.element;
    const windowContent = panelElement.querySelector(".window-content");
    const sectionContent = panelElement.querySelector(".dlc-section-content");
    const clonedDialogCheck = panelElement.querySelector(".dlc-cloned-system-dialog");
    const nav = panelElement.querySelector("nav.dialog-buttons");
    
    debugElementDimensions("panel element", panelElement, "DLC-Panel");
    debugElementDimensions("window-content", windowContent, ".window-content");
    debugElementDimensions("section-content", sectionContent, ".dlc-section-content");
    debugElementDimensions("cloned-dialog", clonedDialogCheck, ".dlc-cloned-system-dialog");
    debugElementDimensions("nav.dialog-buttons", nav, "nav.dialog-buttons");
    
    debugPanelInjection("after injection", {
      contentHTMLLength: contentElement.html().length,
      dialogButtonsCount: contentElement.find("nav.dialog-buttons").length,
      clonedButtonsCount: contentElement.find(".dlc-cloned-system-dialog button").length,
      clonedDialogVisible: contentElement.find(".dlc-cloned-system-dialog").is(":visible"),
      dialogButtonsVisible: contentElement.find(".dlc-cloned-system-dialog nav.dialog-buttons").is(":visible"),
      clonedDialogActualWidth: clonedDialogCheck?.offsetWidth
    });
    
    // Debug computed styles of buttons to see why they're not visible
    const navButtons = contentElement.find("nav.dialog-buttons")[0];
    if (navButtons) {
      debugComputedStyles("nav.dialog-buttons", navButtons);
      const firstButton = contentElement.find("nav.dialog-buttons button")[0];
      if (firstButton) {
        debugComputedStyles("nav.dialog-buttons button", firstButton);
      }
      
      // Check if buttons are inside or outside cloned dialog
      const clonedDialog = contentElement.find(".dlc-cloned-system-dialog")[0];
      const isButtonsInsideDialog = clonedDialog && clonedDialog.contains(navButtons);
      const buttonParent = navButtons.parentElement;
      
      debugPanelInjection("button container analysis", {
        buttonContainerTagName: navButtons.tagName,
        buttonParentTagName: buttonParent?.tagName,
        buttonParentClassName: buttonParent?.className,
        isButtonsInsideClonedDialog: isButtonsInsideDialog,
        navButtonsClasses: navButtons.className,
        navButtonsComputedJustify: window.getComputedStyle(navButtons).justifyContent,
        navButtonsComputedMarginLeft: window.getComputedStyle(navButtons).marginLeft,
        navButtonsComputedMarginRight: window.getComputedStyle(navButtons).marginRight,
        navButtonsComputedMaxWidth: window.getComputedStyle(navButtons).maxWidth
      });
    }
    
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
    panelDialog.bringToTop();
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

  // Global override - All Manual toggle
  html.find(".dlc-override-manual").change(async function() {
    const checked = $(this).is(":checked");
    if (checked) {
      await setGlobalOverride("forceAllManual");
      applyManualDice();
      game.socket.emit(`module.${MODULE_ID}`, { action: "globalOverride", mode: "forceAllManual" });
      ui.notifications.info("Forced all to manual dice.");
    } else {
      await setGlobalOverride("individual");
      game.socket.emit(`module.${MODULE_ID}`, { action: "globalOverride", mode: "individual" });
      ui.notifications.info("Set to individual control.");
    }
    Hooks.call("diceLink.playerModeChanged");
    refreshPanel();
  });

  // Global override - All Digital toggle
  html.find(".dlc-override-digital").change(async function() {
    const checked = $(this).is(":checked");
    if (checked) {
      await setGlobalOverride("forceAllDigital");
      applyDigitalDice();
      game.socket.emit(`module.${MODULE_ID}`, { action: "globalOverride", mode: "forceAllDigital" });
      ui.notifications.info("Forced all to digital dice.");
    } else {
      await setGlobalOverride("individual");
      game.socket.emit(`module.${MODULE_ID}`, { action: "globalOverride", mode: "individual" });
      ui.notifications.info("Set to individual control.");
    }
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

  // Approve buttons
  html.find(".dlc-panel-approve").click( async function() {
    const playerId = $(this).data("player-id");
    const player = game.users.get(playerId);
    if (!player) return;
    
    await setPlayerMode(playerId, "manual");
    
    let pending = getPendingRequests();
    pending = pending.filter(req => req.playerId !== playerId);
    await setPendingRequests(pending);
    
    // Clear chat buttons for this player across ALL chat messages
    $(`.dlc-chat-approve[data-player-id="${playerId}"], .dlc-chat-deny[data-player-id="${playerId}"]`).each(function() {
      $(this).closest(".dlc-chat-buttons").html('<em>Request approved</em>');
    });

    game.socket.emit(`module.${MODULE_ID}`, {
      action: "applyMode",
      playerId: playerId,
      mode: "manual"
    });
    
    await createApprovalChatMessage(playerId, player.name, true);
    ui.notifications.info(`Approved manual dice for ${player.name}.`);
    Hooks.call("diceLink.playerModeChanged");
    refreshPanel();
  });

  // Deny buttons
  html.find(".dlc-panel-deny").click( async function() {
    const playerId = $(this).data("player-id");
    const player = game.users.get(playerId);
    if (!player) return;
    
    let pending = getPendingRequests();
    pending = pending.filter(req => req.playerId !== playerId);
    await setPendingRequests(pending);

    // Clear chat buttons for this player across ALL chat messages
    $(`.dlc-chat-approve[data-player-id="${playerId}"], .dlc-chat-deny[data-player-id="${playerId}"]`).each(function() {
      $(this).closest(".dlc-chat-buttons").html('<em>Request denied</em>');
    });
    
    game.socket.emit(`module.${MODULE_ID}`, {
      action: "requestDenied",
      playerId: playerId
    });
    
    await createApprovalChatMessage(playerId, player.name, false);
    ui.notifications.info(`Denied manual dice for ${player.name}.`);
    Hooks.call("diceLink.playerModeChanged");
    refreshPanel();
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
