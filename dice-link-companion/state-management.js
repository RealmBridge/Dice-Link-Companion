/**
 * state-management.js - the in-memory state of the roll in progress and the open panel:
 * the pending roll request, Foundry's hidden roll window (the "mirrored dialog"), where
 * the roll is in its exchange with DLA (the DLA phase), and the open DLC panel - and
 * clearing the roll when it ends. Nothing here is saved; saved settings are in settings.js.
 */

// The roll in progress: what DLA chose for it (its roll ID and button), set once DLA answers
let pendingRollRequest = null;
// The DLC panel window, while it's open
let currentPanelDialog = null;
// Foundry's hidden roll window for the roll in progress (its options dialog, then its resolver)
let mirroredDialog = null;

// Where the roll is in its exchange with DLA, so a roll window that renders again doesn't
// send DLA a second roll request: null (no roll), "rollSent" (waiting for the button),
// "buttonClicked" (waiting for the resolver), "diceRequested" (waiting for the values)
let dlaPhase = null;

export function getPendingRollRequest() {
  return pendingRollRequest;
}

export function getCurrentPanelDialog() {
  return currentPanelDialog;
}

export function getMirroredDialog() {
  return mirroredDialog;
}

export function getDLAPhase() {
  return dlaPhase;
}

export function setPendingRollRequest(value) {
  pendingRollRequest = value;
}

export function setCurrentPanelDialog(value) {
  currentPanelDialog = value;
}

export function setMirroredDialog(value) {
  mirroredDialog = value;
}

export function setDLAPhase(phase) {
  dlaPhase = phase;
}

/**
 * Clear the roll in progress: Foundry's hidden roll window, the pending roll request and
 * the DLA phase. Used when a roll finishes, is cancelled, or its window closes.
 */
export function clearRollState() {
  setMirroredDialog(null);
  setPendingRollRequest(null);
  setDLAPhase(null);
}
