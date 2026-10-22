/**
 * state-management.js - the in-memory state of the roll in progress and the open panel:
 * Foundry's hidden dice entry window for the roll in progress, and the open DLC panel -
 * and clearing the roll when it ends. Nothing here is saved; saved settings are in settings.js.
 */

// The DLC panel window, while it's open
let currentPanelDialog = null;
// Foundry's hidden dice entry window for the roll in progress, waiting for DLA's values
let diceEntryWindow = null;

export function getCurrentPanelDialog() {
  return currentPanelDialog;
}

export function getDiceEntryWindow() {
  return diceEntryWindow;
}

export function setCurrentPanelDialog(value) {
  currentPanelDialog = value;
}

export function setDiceEntryWindow(value) {
  diceEntryWindow = value;
}

/**
 * Clear the roll in progress: forget Foundry's dice entry window. Used when a roll
 * finishes, is cancelled, or its window closes.
 */
export function clearRollState() {
  setDiceEntryWindow(null);
}
