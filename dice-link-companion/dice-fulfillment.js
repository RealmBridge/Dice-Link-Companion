/**
 * dice-fulfillment.js - DLA's side of each roll, carried out in Foundry: hands the dice
 * values DLA sends to Foundry's dice entry window, closes that window for a roll cancelled
 * in DLA, and runs rolls from DLA's dice tray. Hiding the dice entry window, and asking
 * DLA for its dice, is done by dice-entry-window.js; switching a user's dice to manual or
 * digital is done by mode-application.js.
 */

import { debug, debugError, describe, patchResolverForDiagnostics } from "./debug.js";
import { getDiceEntryWindow, clearRollState } from "./state-management.js";
import { emptyDieBoxes } from "./dice-entry-window.js";
import { onDLAMessage } from "./qwebchannel-client.js";

// ---- Setup ----

/**
 * Register for DLA's side of each roll. Called from main.mjs setup.
 */
export function setupDiceFulfillment() {
  onDLAMessage("diceResult", onDiceResult);
  onDLAMessage("rollCancelled", onRollCancelled);
  onDLAMessage("diceTrayRoll", onDiceTrayRoll);
}

// ---- The dice values from DLA ----

/**
 * The player rolled and DLA sent the values: hand each one to Foundry's dice entry window
 * the way Foundry takes physical dice (RollResolver#registerResult). Foundry puts it in the
 * next empty box for that die and, once every box is filled, submits the roll itself.
 * @param {string} rollId
 * @param {Array<{type: string, value: number}>} results - e.g. [{type: "d20", value: 14}]
 */
function onDiceResult(rollId, results) {
  debug("Dice results from DLA", JSON.stringify({ rollId, resultCount: results.length, results }));

  const app = getDiceEntryWindow();
  patchResolverForDiagnostics(app);

  if (!app?.rendered) {
    debug("No dice entry window waiting for these values");
    clearRollState();
    return;
  }

  let filled = 0;
  for (const { type, value } of results) {
    const box = emptyDieBoxes(app).find(b => b.denomination === type);
    if (box && app.registerResult(box.method, type, value)) filled++;
    else debugError("No empty box for this die in the dice entry window", { type, value });
  }
  debug("Dice values handed to Foundry", JSON.stringify({ filled, sent: results.length }));

  // If Foundry hasn't submitted by itself (a die set to Manual in Foundry's own Dice
  // Configuration, or a value missing), submit with the window's own submit button:
  // Foundry rolls any box still empty digitally.
  const submit = app.element.querySelector('button[type="submit"]');
  if (submit && !submit.disabled) app.element.requestSubmit(submit);
  else if (!submit) debugError("No submit button in the dice entry window - the roll will not complete", describe(app.element.querySelectorAll("button")));

  // The window stays the roll in progress until it closes: Foundry may still ask for
  // another die (a reroll or an exploding die), and dice-entry-window.js asks DLA for it
}

// ---- A roll cancelled in DLA ----

/**
 * Close the hidden dice entry window and clear the roll in progress
 */
function onRollCancelled(rollId) {
  debug("Roll cancelled by DLA user", { rollId });

  const app = getDiceEntryWindow();

  // Close it without the window's own close(), which would roll the empty boxes digitally
  if (app) {
    try {
      Roll.defaultImplementation.RESOLVERS.delete(app.roll);
      foundry.applications.api.ApplicationV2.prototype.close.call(app, { force: true });
    } catch(e) {
      debug("Error closing the dice entry window:", e);
    }
  }

  clearRollState();
}

// ---- Dice tray rolls ----

/**
 * DLA's dice tray started a roll. Run the formula with Foundry's own Roll.evaluate(); this
 * triggers the normal flow (Foundry shows its dice entry window, dice-entry-window.js hides
 * it and asks DLA for the dice, and so on), then the roll goes to chat.
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
    ui.notifications?.error(game.i18n.format("DICE_LINK.Notify.RollError", { error: e.message }));
  }
}
