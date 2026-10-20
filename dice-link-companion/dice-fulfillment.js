/**
 * dice-fulfillment.js - DLA's side of each roll, carried out in Foundry: presses the button
 * chosen in DLA on the hidden roll window, fills in the dice values DLA sends, cancels a
 * roll cancelled in DLA, and runs rolls from DLA's dice tray. Hiding Foundry's roll windows,
 * and telling DLA about them, is done by dialog-mirroring.js; switching a user's dice to
 * manual or digital is done by mode-application.js.
 */

import { ASYNC_OPERATION_DELAY_MS } from "./constants.js";
import { debug, debugError, describe, patchResolverForDiagnostics } from "./debug.js";
import { getMirroredDialog, getPendingRollRequest, setDLAPhase, clearRollState } from "./state-management.js";
import { windowElement } from "./dialog-mirroring.js";
import { onDLAMessage } from "./qwebchannel-client.js";
import { normaliseVisibility } from "./clip-visibility.js";
import { setRollClipVisibility, clearRollClipVisibility } from "./video-feed.js";
import { refreshPanel } from "./dice-panel.js";

// ============================================================================
// SETUP
// ============================================================================

/**
 * Register for DLA's side of each roll. Called from main.mjs setup.
 */
export function setupDiceFulfillment() {
  onDLAMessage("buttonSelect", onButtonSelect);
  onDLAMessage("diceResult", onDiceResult);
  onDLAMessage("rollCancelled", onRollCancelled);
  onDLAMessage("diceTrayRoll", onDiceTrayRoll);
}

/**
 * A roll is over (done, cancelled, or nothing to fill in): forget it, and redraw the DLC
 * panel. Nothing on the panel is about the roll, but the redraw also brings it up to date
 * with any change to the players' modes that came in since (kept from before the move).
 */
function endRoll() {
  clearRollState();
  refreshPanel();
}

// ============================================================================
// PHASE A: the button chosen in DLA
// ============================================================================

/** The "Roll Mode" picked in a mirrored roll dialog, or null if it has none. */
function readDialogVisibility(dialogRef) {
  try {
    if (!dialogRef?.html) return null;
    const html = $(windowElement(dialogRef.html));
    const select = html.find('select[name$="rollMode"], select[name$="messageMode"]').first();
    return select.length ? normaliseVisibility(select.val()) : null;
  } catch (e) {
    return null;
  }
}

/**
 * User clicked a button (Advantage/Normal/Disadvantage) in DLA.
 * We apply config changes and click the hidden Foundry dialog button.
 * This triggers Foundry to process and show its dice resolver.
 */
function onButtonSelect(rollId, buttonClicked, configChanges) {
  debug("Phase A: Button selection from DLA", { rollId, buttonClicked, configChanges });

  // Set phase to buttonClicked - prevents sending duplicate rollRequests
  setDLAPhase("buttonClicked");

  // Apply config changes to the hidden dialog if any
  const dialogRef = getMirroredDialog();
  if (dialogRef && configChanges && Object.keys(configChanges).length > 0) {
    const originalHtml = $(windowElement(dialogRef.html));
    for (const [name, value] of Object.entries(configChanges)) {
      const input = originalHtml.find(`[name="${name}"]`);
      if (input.length > 0) {
        input.val(value);
        input[0].dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }

  // Note this roll's visibility for its dice clip (the dialog is gone by then)
  setRollClipVisibility(readDialogVisibility(dialogRef));

  // Store the rollId for Phase B correlation
  const pendingRoll = getPendingRollRequest();
  if (pendingRoll) {
    pendingRoll.dlaRollId = rollId;
    pendingRoll.buttonClicked = buttonClicked;
  }

  // Click the button on the hidden Foundry dialog
  // This triggers Foundry to process the roll and show dice resolver
  if (buttonClicked && dialogRef?.data?.buttons) {
    debug("Clicking hidden dialog button:", buttonClicked);
    pressChosenButton(buttonClicked);
  }
}

/**
 * Press the button DLA chose on the hidden roll dialog (onButtonSelect applies DLA's
 * option changes to the dialog first)
 * @param {string} buttonLabel - the label clicked in DLA, e.g. "Advantage", "Normal", "Disadvantage"
 */
async function pressChosenButton(buttonLabel) {
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

  debug("pressChosenButton: element found", describe(element));
  debug("pressChosenButton: all buttons in formData", describe(formData?.buttons?.map(b => b.element)));
  debug("pressChosenButton: looking for button label", buttonLabel);

  try {
    // Find the button that matches the user's choice
    let targetButton = formData.buttons.find(btn =>
      btn.label.toLowerCase().trim() === buttonLabel.toLowerCase().trim()
    );
    
    // Fallback: try to find any submit-like button
    if (!targetButton) {
      targetButton = formData.buttons.find(btn =>
        btn.label.toLowerCase().includes("ok") ||
        btn.label.toLowerCase().includes("roll") ||
        btn.label.toLowerCase().includes("submit") ||
        btn.label.toLowerCase().includes("normal")
      );
    }

    debug("pressChosenButton: targetButton result", describe(targetButton?.element));

    if (targetButton?.element) {
      // .click() triggers ApplicationV2's _onClickAction which sets advantage/disadvantage mode.
      // form.requestSubmit() only fires 'submit' — _onClickAction never runs, mode never applied.
      // visibility:hidden elements accept programmatic clicks; no need to reveal them first.
      targetButton.element.click();

      await new Promise(resolve => setTimeout(resolve, ASYNC_OPERATION_DELAY_MS));

      debug("pressChosenButton: after click", describe(element));
    } else {
      debugError("Could not find target button:", buttonLabel);
    }
  } catch (e) {
    debugError("Error submitting mirrored dialog:", e);
  }
}

// ============================================================================
// PHASE B: the dice values from DLA
// ============================================================================

/**
 * User rolled dice and submitted results in DLA.
 * We inject these values into Foundry's dice resolver.
 */
function onDiceResult(rollId, results) {
  debug("Phase B: Dice results from DLA", JSON.stringify({ rollId, resultCount: results.length, results }));
  clearRollClipVisibility();

  // Use the stored resolver reference rather than a DOM search, which could find stale resolvers
  const resolver = getMirroredDialog()?.element;
  patchResolverForDiagnostics(getMirroredDialog()?.app);

  if (!resolver) {
    debug("No roll resolver found in DOM for dice injection");
    endRoll();
    return;
  }

  debug("Found resolver element", describe(resolver));

  // Find all dice input fields in the resolver
  const allInputs = resolver.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
  debug("Found inputs in resolver", allInputs.length, describe(allInputs));

  // Inject dice values into the resolver inputs
  let resultIndex = 0;
  for (const input of allInputs) {
    // Skip inputs that already have values or are hidden
    if (input.value || input.type === 'hidden' || getComputedStyle(input).display === 'none') {
      debug("Skipping input", JSON.stringify({ name: input.name, reason: input.value ? 'has-value' : input.type === 'hidden' ? 'hidden-type' : 'display-none' }));
      continue;
    }

    if (resultIndex < results.length) {
      const result = results[resultIndex];
      const value = result.value;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      debug("Injected dice value", JSON.stringify({ value, inputName: input.name, inputIndex: resultIndex }));
      resultIndex++;
    }
  }

  debug("Injection complete", JSON.stringify({ injectedCount: resultIndex, totalResults: results.length }));

  setTimeout(() => {
    // Log every button in the resolver so we know exactly what's available
    debug("Resolver all buttons", describe(resolver.querySelectorAll('button')));

    // Look for submit button in resolver
    const submitBtn = resolver.querySelector(
      'button[type="submit"], ' +
      'button[data-action="submit"], ' +
      'button[data-action="fulfill"], ' +
      '.dialog-button.submit, ' +
      'button.submit'
    );

    // Also check if resolver itself is a form (v14 pattern)
    const resolverIsForm = resolver.tagName === 'FORM';
    const innerForm = resolverIsForm ? null : resolver.querySelector('form');

    debug("Resolver submit search", describe(submitBtn), JSON.stringify({ resolverIsForm, innerFormFound: !!innerForm }));

    if (submitBtn) {
      debug("Clicking resolver submit button", submitBtn.textContent?.trim());
      submitBtn.click();
    } else {
      const form = innerForm || (resolverIsForm ? resolver : null);
      if (form) {
        debug("Submitting resolver form directly");
        form.requestSubmit();
      } else {
        const anyBtn = Array.from(resolver.querySelectorAll('button')).find(btn =>
          btn.textContent?.toLowerCase().includes('submit') ||
          btn.textContent?.toLowerCase().includes('ok') ||
          btn.textContent?.toLowerCase().includes('roll')
        );
        if (anyBtn) {
          debug("Clicking fallback button", anyBtn.textContent?.trim());
          anyBtn.click();
        } else {
          debug("No submit mechanism found in resolver — roll will not complete");
        }
      }
    }

    endRoll();
  }, 100);
}

// ============================================================================
// CANCEL: roll cancelled by the user in DLA
// ============================================================================

/**
 * Close the hidden Foundry window and clear the roll in progress
 */
function onRollCancelled(rollId) {
  clearRollClipVisibility();
  debug("Roll cancelled by DLA user", { rollId });

  const dialogRef = getMirroredDialog();

  // Close the hidden Foundry dialog — bypass RollResolver.close() to avoid auto-fill
  if (dialogRef?.app) {
    try {
      Roll.defaultImplementation.RESOLVERS.delete(dialogRef.app.roll);
      foundry.applications.api.ApplicationV2.prototype.close.call(dialogRef.app, { force: true });
    } catch(e) {
      debug("Error closing dialog app:", e);
    }
  }

  endRoll();
}

// ============================================================================
// DICE TRAY ROLL - Uses Foundry's Native System
// ============================================================================

/**
 * DLA's dice tray started a roll. Run the formula with Foundry's own Roll.evaluate(); this
 * triggers the normal flow (Foundry shows its resolver, dialog-mirroring.js hides it and
 * asks DLA for the dice, and so on), then the roll goes to chat.
 */
async function onDiceTrayRoll(formula, flavor) {
  debug("Dice tray roll from DLA", { formula, flavor });

  try {
    const roll = new Roll(formula);
    await roll.evaluate();
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker(),
      flavor
    });
  } catch (e) {
    debugError("Roll error:", e.message);
    if (e.message?.includes("cancelled")) return;   // cancelled in DLA: nothing to report
    debug("Error executing dice tray roll:", e);
    ui.notifications?.error(`Dice roll error: ${e.message}`);
  }
}
