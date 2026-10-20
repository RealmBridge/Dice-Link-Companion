/**
 * state-management.js - the in-memory state of the roll in progress and the open panel:
 * the pending roll request, Foundry's hidden roll window (the "mirrored dialog"), where
 * the roll is in its exchange with DLA (the DLA phase), and the open DLC panel - and
 * clearing the roll when it ends. Nothing here is saved; saved settings are in settings.js.
 */

// ============================================================================
// STATE VARIABLES
// ============================================================================

let pendingRollRequest = null;
let currentPanelDialog = null;
let mirroredDialog = null;

// DLA communication phase tracking
// Prevents duplicate rollRequests when dialog re-renders after button click
// Phases: null (idle), "rollSent" (waiting for button), "buttonClicked" (waiting for resolver), "diceRequested" (waiting for results)
let dlaPhase = null;

// ============================================================================
// GETTERS
// ============================================================================

/**
 * Get the pending roll request
 * @returns {Object|null} The pending roll request or null
 */
export function getPendingRollRequest() {
  return pendingRollRequest;
}

/**
 * Get the currently open panel dialog
 * @returns {Object|null} The panel dialog or null
 */
export function getCurrentPanelDialog() {
  return currentPanelDialog;
}

/**
 * Get the mirrored dialog reference
 * @returns {Object|null} The mirrored dialog or null
 */
export function getMirroredDialog() {
  return mirroredDialog;
}

/**
 * Get the current DLA communication phase
 * @returns {string|null} Current phase: null, "rollSent", "buttonClicked", "diceRequested"
 */
export function getDLAPhase() {
  return dlaPhase;
}

// ============================================================================
// SETTERS
// ============================================================================

/**
 * Set the pending roll request
 * @param {Object|null} value - The roll request to set
 */
export function setPendingRollRequest(value) {
  pendingRollRequest = value;
}

/**
 * Set the currently open panel dialog
 * @param {Object|null} value - The panel dialog to set
 */
export function setCurrentPanelDialog(value) {
  currentPanelDialog = value;
}

/**
 * Set the mirrored dialog reference
 * @param {Object|null} value - The mirrored dialog to set
 */
export function setMirroredDialog(value) {
  mirroredDialog = value;
}

/**
 * Set the DLA communication phase
 * @param {string|null} phase - Phase: null, "rollSent", "buttonClicked", "diceRequested"
 */
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
