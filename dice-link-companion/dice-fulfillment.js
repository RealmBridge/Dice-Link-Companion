/**
 * dice-fulfillment.js - how Foundry gets its dice values while a user is in manual mode.
 * Registers "Dice Link Companion" as a Foundry dice fulfillment method and switches it on
 * or off for every die; stops Dice So Nice animating manual rolls; presses the chosen
 * button on a hidden roll window; and runs rolls sent from DLA's dice tray.
 * Hiding Foundry's roll windows is done by dialog-mirroring.js.
 */

import { ASYNC_OPERATION_DELAY_MS } from "./constants.js";
import { debug, debugResolverState, debugFulfillment, debugError, describeButtons } from "./debug.js";
import { getMirroredDialog } from "./state-management.js";
import { windowElement } from "./dialog-mirroring.js";

// ============================================================================
// DICE FULFILLMENT SETUP
// ============================================================================

/**
 * Setup Dice Link as a fulfillment method.
 * We DON'T register a custom resolver - instead we let Foundry use its native
 * RollResolver, and our dialog-mirroring.js hooks hide it and ask DLA for the dice.
 * This is the same hide-and-pass-on pattern used for roll dialogs.
 */
export function setupDiceFulfillment() {
  debugResolverState("setup_fulfillment_starting", {});

  // Register "dice-link" as an interactive method that uses Foundry's default resolver
  // Our dialog hooks will hide the resolver and ask DLA for the dice
  CONFIG.Dice.fulfillment.methods["dice-link"] = {
    label: "Dice Link Companion",
    icon: "fa-dice-d20",
    interactive: true
    // No custom resolver - we use Foundry's default RollResolver instead
  };
  
  debugResolverState("setup_fulfillment_complete", { methodRegistered: true });
}

// ============================================================================
// DICE TRAY ROLL - Uses Foundry's Native System
// ============================================================================

/**
 * Execute a dice tray roll using Foundry's native Roll.evaluate().
 * Foundry will show its RollResolver dialog, which our dialog-mirroring.js
 * will hide, asking DLA for the dice.
 */
export async function executeDiceTrayRollManually(formula, flavorText) {
  debugFulfillment("executeDiceTrayRollManually:", formula);
  
  try {
    const roll = new Roll(formula);
    
    // Foundry's evaluate() triggers the fulfillment system
    // Our dialog hooks hide the RollResolver and ask DLA for the dice
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
 * Press the button DLA chose on the hidden roll dialog (main.mjs applies DLA's option
 * changes to the dialog first)
 */
export async function submitMirroredDialog(userChoice) {
  const dialogRef = getMirroredDialog();
  if (!dialogRef) {
    debugError("No mirrored dialog to submit");
    return;
  }
  
  const { html, data: formData } = dialogRef;
  
  const element = windowElement(html) || formData?.element;
    
  if (!element) {
    debugError("Could not find dialog element to submit");
    return;
  }
  
  debug("submitMirroredDialog: element found", JSON.stringify({
    tagName: element?.tagName,
    isConnected: element?.isConnected,
    display: element?.style?.display,
    open: element?.open,
    id: element?.id
  }));
  debug("submitMirroredDialog: all buttons in formData", describeButtons(formData?.buttons));
  debug("submitMirroredDialog: looking for button label", userChoice.buttonLabel);

  try {
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
    
    debug("submitMirroredDialog: targetButton result", JSON.stringify({
      found: !!targetButton,
      label: targetButton?.label,
      tagName: targetButton?.element?.tagName,
      type: targetButton?.element?.type,
      dataAction: targetButton?.element?.dataset?.action
    }));

    if (targetButton?.element) {
      // .click() triggers ApplicationV2's _onClickAction which sets advantage/disadvantage mode.
      // form.requestSubmit() only fires 'submit' — _onClickAction never runs, mode never applied.
      // visibility:hidden elements accept programmatic clicks; no need to reveal them first.
      targetButton.element.click();

      await new Promise(resolve => setTimeout(resolve, ASYNC_OPERATION_DELAY_MS));

      debug("submitMirroredDialog: after click", JSON.stringify({
        isConnected: element.isConnected,
        open: element.open,
        display: getComputedStyle(element).display,
        visibility: element.style.visibility
      }));
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

// Whether the Dice So Nice module is switched on in this world
const dsnActive = () => !!game.modules.get("dice-so-nice")?.active;

// Saved fulfillment defaultMethod — captured before DLC overwrites it, restored on disconnect.
let _savedDefaultMethod = null;
// Hook ID for the explicit DSN suppression hook — null when not registered.
let _dsnSuppressionHookId = null;
// Original showForRoll — saved when we intercept it, restored on disconnect.
let _origShowForRoll = null;

function disableDSN() {
  if (!dsnActive()) return;
  if (game.dice3d) {
    game.dice3d.messageHookDisabled = true;
    if (_origShowForRoll === null) {
      _origShowForRoll = game.dice3d.showForRoll.bind(game.dice3d);
      game.dice3d.showForRoll = function(...args) {
        if (game.dice3d?.messageHookDisabled) return Promise.resolve(false);
        return _origShowForRoll(...args);
      };
    }
  }
  if (_dsnSuppressionHookId === null) {
    _dsnSuppressionHookId = Hooks.on("diceSoNiceMessagePreProcess", (_msgId, eventObj) => {
      eventObj.willTrigger3DRoll = false;
    });
  }
}

export function restoreDSN() {
  if (!dsnActive()) return;
  if (game.dice3d) {
    game.dice3d.messageHookDisabled = false;
    if (_origShowForRoll !== null) {
      game.dice3d.showForRoll = _origShowForRoll;
      _origShowForRoll = null;
    }
  }
  if (_dsnSuppressionHookId !== null) {
    Hooks.off("diceSoNiceMessagePreProcess", _dsnSuppressionHookId);
    _dsnSuppressionHookId = null;
  }
}

// ============================================================================
// FULFILLMENT MODE APPLICATION
// ============================================================================

/** Foundry's die types (d4, d6, ... d100) - the dice Dice Link fills in. */
function dieTerms() {
  return Object.keys(CONFIG.Dice.terms).filter(term => /^d\d+$/.test(term) && CONFIG.Dice.terms[term]);
}

/**
 * Apply Dice Link fulfillment to all dice for manual mode users.
 * Called when user is set to manual mode.
 */
export function applyDiceLinkFulfillment() {
  // Only save the original on first call — guards against double-calls overwriting the
  // real original with "dice-link" (which would then be "restored" to "dice-link" on exit)
  if (_savedDefaultMethod === null) {
    _savedDefaultMethod = CONFIG.Dice.fulfillment.defaultMethod ?? "";
  }

  const diceTypes = dieTerms();
  for (const die of diceTypes) {
    CONFIG.Dice.fulfillment.dice[die] = "dice-link";
  }

  CONFIG.Dice.fulfillment.defaultMethod = "dice-link";
  disableDSN();
  debugResolverState("apply_dice_link_fulfillment", { diceTypesCount: diceTypes.length, savedMethod: _savedDefaultMethod });
}

/**
 * Remove Dice Link fulfillment from all dice (return to digital).
 * Called when user switches to digital mode.
 */
export function removeDiceLinkFulfillment() {
  const diceTypes = dieTerms();
  for (const die of diceTypes) {
    delete CONFIG.Dice.fulfillment.dice[die];
  }

  // Restore whatever was configured before DLC wrote to this — don't just clear it
  CONFIG.Dice.fulfillment.defaultMethod = _savedDefaultMethod ?? "";
  _savedDefaultMethod = null;
  restoreDSN();
  debugResolverState("remove_dice_link_fulfillment", { diceTypesCount: diceTypes.length });
}
