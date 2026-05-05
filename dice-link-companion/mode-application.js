/**
 * Mode Application Module - dice-link-companion
 * Handles applying manual/digital dice modes to the Foundry dice fulfillment system.
 * These functions control whether players use our custom panel UI or Foundry's digital dice.
 */

import { disableDSN, restoreDSN } from "./dice-fulfillment.js";

/**
 * Apply manual dice mode using our custom dice-link fulfillment method.
 * This routes all dice rolls through our panel UI for player input.
 */
async function applyManualDice() {
  // Set defaultMethod to "dice-link" — this is the effective mechanism in v14.
  // In v14, diceConfiguration is always {} so per-die overrides are not needed.
  if (CONFIG.Dice.fulfillment) {
    CONFIG.Dice.fulfillment.defaultMethod = "dice-link";
  }
  disableDSN();
}

/**
 * Apply digital dice mode - removes our custom fulfillment method.
 * Players will see Foundry's standard digital dice animation.
 */
async function applyDigitalDice() {
  // Clear defaultMethod to restore Foundry's digital dice.
  // In v14, diceConfiguration is always {} so per-die overrides are not needed.
  if (CONFIG.Dice.fulfillment) {
    CONFIG.Dice.fulfillment.defaultMethod = "";
  }
  restoreDSN();
}

export {
  applyManualDice,
  applyDigitalDice
};
