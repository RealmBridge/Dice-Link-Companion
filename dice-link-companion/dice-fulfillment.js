/**
 * Dice Fulfillment Module - dice-link-companion
 * Handles dice fulfillment by hiding Foundry's resolver and mirroring to our panel.
 * Uses the same shadow/mirror pattern as dialog mirroring.
 *            Dialog mirroring handles hiding/mirroring the RollResolver UI
 */

import { ASYNC_OPERATION_DELAY_MS, MODULE_ID } from "./constants.js";
import { debugResolverState, debugFulfillment, debugError } from "./debug.js";
import { getMirroredDialog } from "./state-management.js";

// ============================================================================
// DICE FULFILLMENT SETUP
// ============================================================================

/**
 * Setup Dice Link as a fulfillment method.
 * We DON'T register a custom resolver - instead we let Foundry use its native
 * RollResolver, and our dialog-mirroring.js hooks hide it and mirror to our panel.
 * This is the same shadow/mirror pattern used for roll dialogs.
 */
export function setupDiceFulfillment() {
  debugResolverState("setup_fulfillment_starting", {});
  
  // Register "dice-link" as an interactive method that uses Foundry's default resolver
  // Our dialog hooks will hide the resolver and mirror it to our panel
  CONFIG.Dice.fulfillment.methods["dice-link"] = {
    label: "Dice Link Companion",
    icon: "fa-dice-d20",
    interactive: true
    // No custom resolver - we mirror Foundry's default RollResolver instead
  };
  
  debugResolverState("setup_fulfillment_complete", { methodRegistered: true });
}

// ============================================================================
// DICE TRAY ROLL - Uses Foundry's Native System
// ============================================================================

/**
 * Execute a dice tray roll using Foundry's native Roll.evaluate().
 * Foundry will show its RollResolver dialog, which our dialog-mirroring.js
 * will hide and mirror to our panel using the same shadow/mirror pattern.
 */
export async function executeDiceTrayRollManually(formula, flavorText, html) {
  debugFulfillment("executeDiceTrayRollManually:", formula);
  
  try {
    const roll = new Roll(formula);
    
    // Foundry's evaluate() triggers the fulfillment system
    // Our dialog hooks hide the RollResolver and mirror it to our panel
    await roll.evaluate();
    
    // Send to chat
    await roll.toMessage({ 
      speaker: ChatMessage.getSpeaker(), 
      flavor: flavorText 
    });
    
    return "success";
  } catch (e) {
    debugError("Roll error:", e.message);
    if (e.message?.includes("cancelled")) {
      return "cancelled";
    }
    throw e;
  }
}

// ============================================================================
// MIRRORED DIALOG SUBMISSION
// ============================================================================

/**
 * Apply user choices to the mirrored dialog and submit it
 */
export async function submitMirroredDialog(userChoice) {
  const dialogRef = getMirroredDialog();
  if (!dialogRef) {
    debugError("No mirrored dialog to submit");
    return;
  }
  
  const { app, html, data: formData } = dialogRef;
  
  // Normalize html to a DOM element
  let element;
  if (html instanceof jQuery) {
    element = html[0];
  } else if (html?.element) {
    element = html.element;
  } else if (html instanceof HTMLElement) {
    element = html;
  } else {
    element = formData.element;
  }
  
  if (!element) {
    debugError("Could not find dialog element to submit");
    return;
  }
  
  try {
    // Apply user choices to form inputs in the hidden dialog
    if (userChoice.formValues) {
      for (const [name, value] of Object.entries(userChoice.formValues)) {
        const input = element.querySelector(`input[name="${name}"], select[name="${name}"], textarea[name="${name}"]`);
        if (input) {
          if (input.type === "checkbox") {
            input.checked = value;
          } else {
            input.value = value;
          }
          // Trigger change event for form validation
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    }
    
    // Find the button that matches the user's choice
    // userChoice.buttonLabel contains the label they clicked (e.g., "Advantage", "Normal", "Disadvantage")
    let targetButton = null;
    
    if (userChoice.buttonLabel) {
      // Find button with matching label
      targetButton = formData.buttons.find(btn => 
        btn.label.toLowerCase().trim() === userChoice.buttonLabel.toLowerCase().trim()
      );
    }
    
    // Fallback: try to find any submit-like button
    if (!targetButton) {
      targetButton = formData.buttons.find(btn => 
        btn.label.toLowerCase().includes("ok") || 
        btn.label.toLowerCase().includes("roll") ||
        btn.label.toLowerCase().includes("submit") ||
        btn.label.toLowerCase().includes("normal")
      );
    }
    
    if (targetButton?.element) {

      // Make dialog visible temporarily so click works
      element.style.display = "block";
      
      // Click the button
      targetButton.element.click();
      
      // Small delay to let the click process
      await new Promise(resolve => setTimeout(resolve, ASYNC_OPERATION_DELAY_MS));
      
      // The dialog should close itself after the button click
      // But hide it just in case
      if (element.style.display !== "none") {
        element.style.display = "none";
      }
    } else {
      debugError("Could not find target button:", userChoice.buttonLabel);
    }
  } catch (e) {
    debugError("Error submitting mirrored dialog:", e);
  }
}

// ============================================================================
// DSN SUPPRESSION
// ============================================================================

// Saved DSN enabled state — set when entering manual mode, restored on exit.
let _dsnEnabledBeforeManual = null;

/**
 * Called once at startup. DSN suppression is now handled directly in
 * applyDiceLinkFulfillment / removeDiceLinkFulfillment via the DSN enabled setting.
 */
export function setupDSNSuppression() {
  // No hooks needed — suppression is tied to the mode switch.
}

export function disableDSN() {
  console.error("[DLC DSN] _disableDSN called");
  if (!game.modules.get("dice-so-nice")?.active) {
    console.error("[DLC DSN] DSN module not active, skipping");
    return;
  }
  try {
    const s = game.user.getFlag("dice-so-nice", "settings") ?? {};
    console.error("[DLC DSN] flag before change:", JSON.stringify(s));
    // If our own DLC flag exists, we left DSN disabled from a previous session —
    // trust that record rather than DSN's persisted state (which already shows enabled: false)
    const dlcFlag = game.user.getFlag(MODULE_ID, "dsnEnabledBeforeDLC");
    if (dlcFlag !== undefined) {
      _dsnEnabledBeforeManual = dlcFlag;
      console.error("[DLC DSN] using DLC-persisted record, _dsnEnabledBeforeManual =", _dsnEnabledBeforeManual);
    } else {
      _dsnEnabledBeforeManual = s.enabled !== false;
      console.error("[DLC DSN] _dsnEnabledBeforeManual =", _dsnEnabledBeforeManual);
    }
    if (_dsnEnabledBeforeManual) {
      console.error("[DLC DSN] calling setFlag to disable DSN");
      game.user.setFlag("dice-so-nice", "settings", { ...s, enabled: false });
      game.user.setFlag(MODULE_ID, "dsnEnabledBeforeDLC", true);
      console.error("[DLC DSN] setFlag called, DLC record saved");
    } else {
      console.error("[DLC DSN] DSN was already disabled by user, no change made");
    }
  } catch (e) {
    console.error("[DLC DSN] error in _disableDSN:", e);
  }
}

export function restoreDSN() {
  console.error("[DLC DSN] restoreDSN called, _dsnEnabledBeforeManual =", _dsnEnabledBeforeManual);
  if (!game.modules.get("dice-so-nice")?.active) {
    console.error("[DLC DSN] DSN module not active, skipping restore");
    return;
  }
  // Check both in-memory state and the persisted DLC flag (survives page reloads)
  const dlcFlag = game.user.getFlag(MODULE_ID, "dsnEnabledBeforeDLC");
  const shouldRestore = _dsnEnabledBeforeManual === true || dlcFlag === true;
  console.error("[DLC DSN] dlcFlag =", dlcFlag, "shouldRestore =", shouldRestore);
  if (!shouldRestore) {
    console.error("[DLC DSN] nothing to restore");
    _dsnEnabledBeforeManual = null;
    return;
  }
  try {
    const s = game.user.getFlag("dice-so-nice", "settings") ?? {};
    console.error("[DLC DSN] flag before restore:", JSON.stringify(s));
    game.user.setFlag("dice-so-nice", "settings", { ...s, enabled: true });
    game.user.unsetFlag(MODULE_ID, "dsnEnabledBeforeDLC");
    console.error("[DLC DSN] DSN re-enabled, DLC record cleared");
  } catch (e) {
    console.error("[DLC DSN] error in restoreDSN:", e);
  }
  _dsnEnabledBeforeManual = null;
}

// ============================================================================
// FULFILLMENT MODE APPLICATION
// ============================================================================

/**
 * Apply Dice Link fulfillment to all dice for manual mode users.
 * Called when user is set to manual mode.
 */
export function applyDiceLinkFulfillment() {
  // Dynamically get available dice types from Foundry's configuration
  // This adapts to any custom dice Foundry supports (d4, d6, d8, d10, d12, d20, d100, etc.)
  const diceTypes = Object.keys(CONFIG.Dice.terms).filter(term => {
    // Filter to only dice terms (matches d4, d6, d8, d10, etc.)
    return /^d\d+$/.test(term) && CONFIG.Dice.terms[term];
  });
  
  for (const die of diceTypes) {
    CONFIG.Dice.fulfillment.dice[die] = "dice-link";
  }
  
  CONFIG.Dice.fulfillment.defaultMethod = "dice-link";
  disableDSN();
  debugResolverState("apply_dice_link_fulfillment", { diceTypesCount: diceTypes.length });
}

/**
 * Remove Dice Link fulfillment from all dice (return to digital).
 * Called when user switches to digital mode.
 */
export function removeDiceLinkFulfillment() {
  // Remove our fulfillment method from all dice
  const diceTypes = Object.keys(CONFIG.Dice.terms).filter(term => {
    return /^d\d+$/.test(term) && CONFIG.Dice.terms[term];
  });
  
  for (const die of diceTypes) {
    delete CONFIG.Dice.fulfillment.dice[die];
  }
  
  CONFIG.Dice.fulfillment.defaultMethod = "";
  restoreDSN();
  debugResolverState("remove_dice_link_fulfillment", { diceTypesCount: diceTypes.length });
}
