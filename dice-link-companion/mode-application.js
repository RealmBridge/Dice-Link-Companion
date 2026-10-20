/**
 * mode-application.js - switches this user's dice between manual and digital.
 * Manual: Foundry asks for the dice values (DLA fills them in, or the player types them
 * if DLA isn't connected). Digital: Foundry rolls the dice itself.
 * The rule for which mode a group override gives this user lives here, once.
 */

import { applyDiceLinkFulfillment, removeDiceLinkFulfillment } from "./dice-fulfillment.js";
import { getPlayerMode } from "./settings.js";
import { GLOBAL_OVERRIDE_MODES, PLAYER_MODES } from "./constants.js";

/**
 * Apply manual dice mode.
 * Always sets dice-link fulfillment so Foundry shows the RollResolver.
 * When DLA is connected, DLA fills values; when not, readOnly is stripped in
 * dialog-mirroring.js so the user can type directly.
 */
async function applyManualDice() {
  applyDiceLinkFulfillment();
}

/**
 * Apply digital dice mode.
 * Always restores whatever fulfillment method was active before DLC wrote to it.
 */
async function applyDigitalDice() {
  removeDiceLinkFulfillment();
}

/**
 * Apply the mode a group override gives this user: everyone manual, everyone digital,
 * or ("individual") the user's own setting. Used by the GM's own screen when they change
 * the override and by every other screen when the GM's message arrives.
 * @param {string} override - "forceAllManual", "forceAllDigital" or "individual"
 */
function applyModeForOverride(override) {
  if (override === GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL) return applyManualDice();
  if (override === GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL) return applyDigitalDice();
  return getPlayerMode() === PLAYER_MODES.MANUAL ? applyManualDice() : applyDigitalDice();
}

export {
  applyManualDice,
  applyDigitalDice,
  applyModeForOverride
};
