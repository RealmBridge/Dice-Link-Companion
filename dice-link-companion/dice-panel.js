/**
 * Dice Panel Module - dice-link-companion
 * Handles panel lifecycle (open, close, refresh) and all panel event listeners.
 * This is the primary UI orchestration module.
 */

import { MODULE_ID, ROLE_NAMES, ASYNC_OPERATION_DELAY_MS, DICE_LINK_APP_PORT } from "./constants.js";
import { debug, debugState, debugError, debugPanelInjection, debugComputedStyles, debugClonedButtonClick, debugElementDimensions } from "./debug.js";
import { 
  getCurrentPanelDialog, 
  setCurrentPanelDialog,
  setDiceEntryCancelled,
  getMirroredDialog,
  setMirroredDialog,
  setDLAPhase,
  getPendingDiceEntry,
  setPendingDiceEntry,
  getPendingRollRequest,
  setPendingRollRequest
} from "./state-management.js";
import { clearPendingDiceRequest } from "./websocket-client.js";
import {
  setGlobalOverride,
  getGlobalOverride,
  setPlayerMode,
  getPlayerMode,
  isUserInManualMode,
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
import { validateDiceFormula } from "./dice-parsing.js";
import { executeDiceTrayRollManually } from "./dice-fulfillment.js";

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

  // Attach dice tray listeners (shared with player panel)
  attachDiceTrayListeners(html);
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

  // Attach dice tray listeners (shared with GM panel)
  attachDiceTrayListeners(html);
}

// ============================================================================
// DICE TRAY LISTENERS (shared between GM and Player panels)
// ============================================================================

/**
 * Attach dice tray event listeners - shared between GM and Player panels
 */
export function attachDiceTrayListeners(html) {
  // Track dice counts for badges
  const diceCounts = { 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0, 100: 0 };
  let currentModifier = 0;

  // Dice button left-click - add to formula
  html.find(".dlc-dice-btn").click( function() {
    const die = $(this).data("die");
    diceCounts[die]++;
    
    // Update badge
    const countEl = $(this).find(".dlc-die-count");
    countEl.text(diceCounts[die]).show();
    
    // Rebuild formula
    updateDiceFormula(html, diceCounts, currentModifier);
  });
  
  // Dice button right-click - remove from formula
  html.find(".dlc-dice-btn").on("contextmenu", function(e) {
    e.preventDefault(); // Prevent browser context menu
    const die = $(this).data("die");
    
    if (diceCounts[die] > 0) {
      diceCounts[die]--;
      
      // Update badge
      const countEl = $(this).find(".dlc-die-count");
      if (diceCounts[die] > 0) {
        countEl.text(diceCounts[die]).show();
      } else {
        countEl.text("").hide();
      }
      
      // Rebuild formula
      updateDiceFormula(html, diceCounts, currentModifier);
    }
  });

  // Modifier buttons
  html.find(".dlc-dice-minus").click( function() {
    currentModifier--;
    html.find(".dlc-dice-modifier").text(currentModifier >= 0 ? currentModifier : currentModifier);
    updateDiceFormula(html, diceCounts, currentModifier);
  });

  html.find(".dlc-dice-plus").click( function() {
    currentModifier++;
    html.find(".dlc-dice-modifier").text(currentModifier >= 0 ? currentModifier : currentModifier);
    updateDiceFormula(html, diceCounts, currentModifier);
  });

  // Advantage/Disadvantage toggle - directly modify the input field to show the notation
  html.find(".dlc-dice-adv-btn").click( function() {
    const input = html.find(".dlc-dice-formula-input");
    let formula = input.val().replace(/^\/r\s*/, "").trim();
    
    // Determine current state from button text
    const buttonText = $(this).text();
    let nextState = "advantage"; // Default
    
    if (buttonText === "ADV/DIS") {
      nextState = "advantage";
    } else if (buttonText === "ADV") {
      nextState = "disadvantage";
    } else if (buttonText === "DIS") {
      nextState = "normal";
    }
    
    // Remove existing kh/kl modifiers from d20 rolls
    formula = formula.replace(/(\d*)d20(?:kh|kl)/gi, (match, count) => {
      const num = count || "1";
      return `${num}d20`;
    });
    
    // Add the appropriate modifier based on next state
    if (nextState === "advantage") {
      formula = formula.replace(/(\d*)d20(?!kh|kl)/gi, (match, count) => {
        const num = count || "1";
        return `${num}d20kh`;
      });
      $(this).text("ADV").removeClass("dlc-dis-active").addClass("dlc-adv-active");
    } else if (nextState === "disadvantage") {
      formula = formula.replace(/(\d*)d20(?!kh|kl)/gi, (match, count) => {
        const num = count || "1";
        return `${num}d20kl`;
      });
      $(this).text("DIS").removeClass("dlc-adv-active").addClass("dlc-dis-active");
    } else {
      $(this).text("ADV/DIS").removeClass("dlc-adv-active dlc-dis-active");
    }
    
    // Update the input field to show the modified formula
    input.val(formula);
  });

  // Roll button - uses the formula as shown in the input field
  html.find(".dlc-dice-roll-btn").click( async function() {
    let formula = html.find(".dlc-dice-formula-input").val().replace(/^\/r\s*/, "").trim();
    
    // Validate formula using Foundry's Roll API (supports ALL Foundry dice notation)
    const validation = validateDiceFormula(formula);
    if (!validation.valid) {
      ui.notifications.warn(validation.error);
      return;
    }
    
    // Formula already has modifiers applied from ADV/DIS buttons, so just use it as-is
    const flavorText = "Manual Dice Roll";
    
    // Check mode and execute roll
    if (isUserInManualMode()) {
      try {
        // Call the global dice fulfillment function exposed by main.mjs
        const result = await executeDiceTrayRollManually(formula, flavorText, html);
        if (result === "cancelled") {
          return;
        }
        resetDiceTray(html, diceCounts);
      } catch (e) {
        debugError("Manual roll error:", e);
        ui.notifications.error("Roll execution failed.");
      }
      return;
    }
    
    // Digital mode - normal roll (formula already validated above)
    try {
      const roll = new Roll(formula);
      await roll.evaluate();
      
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker(),
        flavor: flavorText
      });
      
      resetDiceTray(html, diceCounts);
    } catch (e) {
      ui.notifications.error("Roll execution failed.");
    }
  });

  // ============================================================================
  // PENDING ROLL ACTION LISTENERS
  // ============================================================================

  // Mirrored Dialog Button Clicks
  html.find(".dlc-dialog-btn").click( async function() {
    const currentRollRequest = getPendingRollRequest();
    if (!currentRollRequest || !currentRollRequest.isMirroredDialog) {
      return;
    }
    
    const buttonLabel = $(this).data("button");
    
    // Gather form values from mirrored dialog
    const formValues = {};
    html.find(".dlc-mirrored-dialog input, .dlc-mirrored-dialog select").each(function() {
      const $input = $(this);
      const name = $input.attr("name");
      if (name) {
        if ($input.attr("type") === "checkbox") {
          formValues[name] = $input.is(":checked");
        } else {
          formValues[name] = $input.val();
        }
      }
    });
    
    // Call onComplete with the form values and button label
    if (currentRollRequest.onComplete) {
      currentRollRequest.onComplete({
        buttonLabel,
        formValues
      });
    }
  });

  // Advantage / Normal / Disadvantage buttons (Step 1: Configuration)
  html.find(".dlc-roll-action-btn[data-roll-mode]").click( async function() {
    const currentRollRequest = getPendingRollRequest();
    if (!currentRollRequest) {
      return;
    }
    const rollMode = $(this).data("roll-mode");
    const bonus = html.find(".dlc-situational-bonus").val()?.trim() || "";

    // Build the user choice object
    const userChoice = {
      advantage: rollMode === "advantage",
      disadvantage: rollMode === "disadvantage",
      critical: rollMode === "critical",
      situationalBonus: bonus || null
    };

    // Call the onComplete callback to resolve the Promise and proceed with the roll
    if (currentRollRequest.onComplete) {
      currentRollRequest.onComplete(userChoice);
    }
  });
  
  // Submit Dice Results button (Step 2: Dice Entry - single die at a time, legacy)
  html.find(".dlc-submit-dice-btn").click( async function() {
    const currentRollRequest = getPendingRollRequest();
    if (!currentRollRequest || !currentRollRequest.isFulfillment) {
      return;
    }
    
    // Gather dice values from inputs
    const diceResults = [];
    html.find(".dlc-dice-value-input").each(function() {
      const value = parseInt($(this).val()) || 0;
      const faces = parseInt($(this).data("die-faces")) || 20;
      // Clamp to valid range
      const clampedValue = Math.max(1, Math.min(faces, value));
      diceResults.push(clampedValue);
    });
    
    // Call the onComplete callback with the dice results array directly
    if (currentRollRequest.onComplete) {
      currentRollRequest.onComplete(diceResults);
    }
  });

  // Visual dice selection - click to select a die value in a row
  html.find(".dlc-die-option").click( function() {
    const $this = $(this);
    const rowIndex = $this.data("row");
    const value = $this.data("value");
    
    // Deselect all other dice in this row
    html.find(`.dlc-die-option[data-row="${rowIndex}"]`).removeClass("selected");
    
    // Select this die
    $this.addClass("selected");
  });
  
  // Helper - gather all dice results from the visual dice rows
  async function submitVisualDice() {
    const currentRollRequest = getPendingRollRequest();
    if (!currentRollRequest || !currentRollRequest.isFulfillment) return;
    
    const diceResults = [];
    const rows = html.find(".dlc-dice-row");
    let allSelected = true;
    
    rows.each(function() {
      const $row = $(this);
      const faces = parseInt($row.data("faces"));
      
      // d100 rows use a manual input
      if (faces === 100) {
        const val = parseInt($row.find(".dlc-dice-manual-input").val()) || 0;
        if (val < 1 || val > 100) {
          allSelected = false;
          diceResults.push(0);
        } else {
          diceResults.push(val);
        }
        return;
      }
      
      // All other dice use the clickable selection
      const $selected = $row.find(".dlc-die-option.selected");
      if ($selected.length > 0) {
        diceResults.push(parseInt($selected.data("value")));
      } else {
        allSelected = false;
        diceResults.push(0);
      }
    });
    
    if (!allSelected) {
      ui.notifications.warn("Please select a value for each die.");
      return;
    }
    
    if (currentRollRequest.onComplete) {
      await currentRollRequest.onComplete(diceResults);
    }
    refreshPanel();
  }

  // Submit Visual Dice button click
  html.find(".dlc-submit-visual-dice-btn").click( submitVisualDice);

  // Enter key submits the active submit button in the panel
  html.on("keydown", function(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    
    // Find whichever submit button is currently visible and click it
    const $submitBtn = html.find(".dlc-btn-success:visible").first();
    if ($submitBtn.length) $submitBtn.click();
  });

  // Cancel roll button
  html.find(".dlc-roll-cancel-btn").click( function() {
    debug("Cancel button clicked");
    // Set cancellation flag to prevent further dice prompts
    setDiceEntryCancelled(true);
    
    // Close the hidden mirrored Foundry dialog (same as DLA cancel)
    const dialogRef = getMirroredDialog();
    if (dialogRef?.app) {
      try {
        dialogRef.app.close({ force: true });
      } catch(e) {
        debug("Error closing dialog app:", e);
      }
    }
    // Also try closing via the element directly
    if (dialogRef?.html) {
      const el = dialogRef.html instanceof jQuery ? dialogRef.html[0] : dialogRef.html;
      const closeBtn = el?.querySelector?.('.window-header .close, button[data-action="close"]');
      if (closeBtn) closeBtn.click();
    }
    
    // Handle dice entry cancellation
    const currentDiceEntry = getPendingDiceEntry();
    debugState("Current dice entry", currentDiceEntry);
    if (currentDiceEntry) {
      // Resolve with null to signal cancellation
      debug("Resolving dice entry with null");
      currentDiceEntry.resolve(null);
      setPendingDiceEntry(null);
    }
    
    const currentRollRequest = getPendingRollRequest();
    debugState("Current roll request", currentRollRequest);
    if (currentRollRequest?.onComplete) {
      debug("Calling onComplete with 'cancel'");
      currentRollRequest.onComplete("cancel");
    }
    
    // Clear all pending state (same cleanup as DLA cancel)
    setMirroredDialog(null);
    setPendingRollRequest(null);
    clearPendingDiceRequest();
    setDLAPhase(null);
    
    refreshPanel();
    ui.notifications.info("Roll cancelled.");
  });
  
  // Cloned system dialog buttons (Advantage/Normal/Disadvantage)
  // These are buttons cloned from the system's roll configuration dialog
  html.find(".dlc-cloned-system-dialog nav.dialog-buttons button").click( function(e) {
    e.preventDefault();
    e.stopPropagation();
    
    const $btn = $(this);
    const action = $btn.data("action") || $btn.text().trim().toLowerCase();
    
    debugClonedButtonClick("Button clicked", {
      action,
      buttonText: $btn.text().trim(),
      dataAction: $btn.data("action")
    });
    
    const currentRollRequest = getPendingRollRequest();
    if (currentRollRequest?.onComplete) {
      debugClonedButtonClick("Calling onComplete", { action });
      currentRollRequest.onComplete(action);
      setPendingRollRequest(null);
      refreshPanel();
    } else {
      debugClonedButtonClick("No onComplete handler found", { 
        hasPendingRoll: !!currentRollRequest,
        hasOnComplete: !!currentRollRequest?.onComplete
      });
    }
  });
  
  // Sync cloned form elements (selects, inputs) back to the original hidden dialog
  // This ensures changes made in the DLC panel actually affect the roll
  attachClonedFormSyncListeners(html);
}

/**
 * Attach listeners to sync cloned form elements back to the original hidden dialog
 * When user changes a select or input in our panel, update the corresponding element
 * in Foundry's hidden dialog so the changes take effect when buttons are clicked
 */
function attachClonedFormSyncListeners(html) {
  // Sync select elements (dropdowns like Roll Mode, Attack Mode, Abilities)
  html.find(".dlc-cloned-system-dialog select").on("change", function() {
    const $select = $(this);
    const name = $select.attr("name");
    const newValue = $select.val();
    
    debug("Cloned select changed", { name, newValue });
    
    // Get the original hidden dialog
    const dialogRef = getMirroredDialog();
    if (!dialogRef || !dialogRef.html) {
      debug("No mirrored dialog reference found for syncing");
      return;
    }
    
    // Find the corresponding select in the original dialog
    const originalHtml = dialogRef.html instanceof jQuery ? dialogRef.html : $(dialogRef.html);
    const originalSelect = originalHtml.find(`select[name="${name}"]`);
    
    if (originalSelect.length > 0) {
      originalSelect.val(newValue);
      // Trigger change events so Foundry/dnd5e processes the change
      originalSelect[0].dispatchEvent(new Event("change", { bubbles: true }));
      originalSelect[0].dispatchEvent(new Event("input", { bubbles: true }));
      debug("Synced select to original dialog", { name, newValue });
    } else {
      debug("Could not find original select to sync", { name });
    }
  });
  
  // Sync text/number inputs (like Situational Bonus)
  html.find(".dlc-cloned-system-dialog input[type='text'], .dlc-cloned-system-dialog input[type='number'], .dlc-cloned-system-dialog input:not([type])").on("change input", function() {
    const $input = $(this);
    const name = $input.attr("name");
    const newValue = $input.val();
    
    // Skip if no name attribute (can't sync without it)
    if (!name) return;
    
    debug("Cloned input changed", { name, newValue });
    
    // Get the original hidden dialog
    const dialogRef = getMirroredDialog();
    if (!dialogRef || !dialogRef.html) {
      debug("No mirrored dialog reference found for syncing");
      return;
    }
    
    // Find the corresponding input in the original dialog
    const originalHtml = dialogRef.html instanceof jQuery ? dialogRef.html : $(dialogRef.html);
    const originalInput = originalHtml.find(`input[name="${name}"]`);
    
    if (originalInput.length > 0) {
      originalInput.val(newValue);
      // Trigger change events so Foundry/dnd5e processes the change
      originalInput[0].dispatchEvent(new Event("change", { bubbles: true }));
      originalInput[0].dispatchEvent(new Event("input", { bubbles: true }));
      debug("Synced input to original dialog", { name, newValue });
    } else {
      debug("Could not find original input to sync", { name });
    }
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Update the dice formula input based on current dice counts and modifier
 */
function updateDiceFormula(html, diceCounts, modifier) {
  const parts = [];
  const dieOrder = [20, 12, 10, 8, 6, 4, 100]; // Common dice order
  
  for (const die of dieOrder) {
    if (diceCounts[die] > 0) {
      parts.push(`${diceCounts[die]}d${die}`);
    }
  }
  
  let formula = parts.join("+");
  if (modifier !== 0) {
    formula += modifier > 0 ? `+${modifier}` : `${modifier}`;
  }
  
  html.find(".dlc-dice-formula-input").val(`/r ${formula}`);
}

/**
 * Reset the dice tray UI
 */
function resetDiceTray(html, diceCounts) {
  Object.keys(diceCounts).forEach(k => diceCounts[k] = 0);
  html.find(".dlc-die-count").text("0").hide();
  html.find(".dlc-dice-modifier").text("0");
  html.find(".dlc-dice-formula-input").val("/r ");
  html.find(".dlc-dice-adv-btn").text("ADV/DIS").removeClass("dlc-adv-active dlc-dis-active");
}
