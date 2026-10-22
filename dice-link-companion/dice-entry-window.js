/**
 * dice-entry-window.js - Foundry's own dice entry window (its RollResolver: the window
 * asking for each die's value), for a user in manual mode. Foundry opens this same window
 * in every game system, so it is recognised by what it is, never by its title or words.
 * With DLA connected: hides it and asks DLA for the dice it needs (dice-fulfillment.js
 * hands DLA's values back to it). Without DLA: unlocks its boxes so the player can type
 * their dice values in. The game system's own roll windows (Advantage / Normal /
 * Disadvantage and the like) are left alone: the player answers them in Foundry.
 */

import { isUserInManualMode } from "./settings.js";
import { debug } from "./debug.js";
import { getConnectionStatus, sendMessage } from "./qwebchannel-client.js";
import { getDiceEntryWindow, setDiceEntryWindow, clearRollState } from "./state-management.js";

// ---- Setup ----

/**
 * Watch for Foundry's dice entry window. Called from main.mjs setup.
 * Foundry calls "renderRollResolver" for its own window and for any window built on it.
 */
export function setupDiceEntryWindow() {
  Hooks.on("renderRollResolver", onDiceEntryWindow);

  // The window closed (the roll finished, or was cancelled): forget it
  Hooks.on("closeRollResolver", (app) => {
    if (getDiceEntryWindow() === app) clearRollState();
  });
}

// ---- The window's die boxes ----

/**
 * The boxes in a dice entry window still waiting for a value, each with its die (e.g.
 * "d20") and how Foundry expects it to be filled ("dice-link", or another method set in
 * Foundry's own Dice Configuration). Read from Foundry's own markup for each die, the same
 * way Foundry finds the box for a physical die (RollResolver#registerResult).
 * @returns {Array<{input: HTMLInputElement, denomination: string, method: string}>}
 */
export function emptyDieBoxes(app) {
  const inputs = app?.element?.querySelectorAll("label[data-denomination][data-method] > input:not(:disabled)") ?? [];
  return Array.from(inputs)
    .filter(input => input.value === "")
    .map(input => ({
      input,
      denomination: input.parentElement.dataset.denomination,
      method: input.parentElement.dataset.method
    }));
}

// ---- The window opens ----

/**
 * Foundry's dice entry window opened (or redrew, e.g. for dice added to the roll). In
 * manual mode: with DLA, hide it and ask DLA for the dice; without DLA, let the player
 * type them in.
 */
function onDiceEntryWindow(app) {
  if (!isUserInManualMode()) return;
  const boxes = emptyDieBoxes(app);

  if (!getConnectionStatus()) {
    // Foundry locks the boxes of Dice Link's dice (it expects DLA to fill them): unlock them
    for (const { input } of boxes) {
      input.readOnly = false;
      input.removeAttribute("readonly");
    }
    return;
  }

  hideWindow(app.element);
  if (!boxes.length) return;   // a redraw with nothing new to ask for
  setDiceEntryWindow(app);
  askDLAForDice(boxes);
}

/**
 * Hide the window from the player. visibility:hidden keeps it active in Foundry's eyes
 * (display:none would make it close itself), and it can still be submitted.
 */
function hideWindow(element) {
  if (element?.style) {
    element.style.visibility = "hidden";
    element.style.pointerEvents = "none";
  }
}

/**
 * Send DLA the dice the window is waiting for: each die type once with its count, in the
 * order they first appear, e.g. [{type: "d20", count: 2}, {type: "d6", count: 1}] and the
 * formula "2d20 + 1d6".
 */
function askDLAForDice(boxes) {
  const dice = [];
  for (const { denomination } of boxes) {
    const entry = dice.find(d => d.type === denomination);
    if (entry) entry.count++;
    else dice.push({ type: denomination, count: 1 });
  }

  const id = `dlc-${Date.now()}`;
  const formula = dice.map(d => `${d.count}${d.type}`).join(" + ");
  debug("Asking DLA for the dice", { id, formula });
  sendMessage({ type: "diceRequest", id, dice, formula });
}
