/**
 * Mode Application Module - dice-link-companion
 * Handles applying manual/digital dice modes to the Foundry dice fulfillment system.
 * These functions control whether players use our custom panel UI or Foundry's digital dice.
 */

import { disableDSN, restoreDSN } from "./dice-fulfillment.js";

let _savedDiceSound = null;

/**
 * Apply manual dice mode using our custom dice-link fulfillment method.
 * This routes all dice rolls through our panel UI for player input.
 */
async function applyManualDice() {
  // Use our "dice-link" fulfillment method instead of "manual"
  // Our dialog-mirroring.js hides Foundry's RollResolver and mirrors it to our panel
  if (CONFIG.Dice.fulfillment) {
    CONFIG.Dice.fulfillment.defaultMethod = "dice-link";
    if (CONFIG.Dice.fulfillment.dice) {
      // Dynamically get available dice types from Foundry's configuration
      // This adapts to any custom dice Foundry supports
      const diceTypes = Object.keys(CONFIG.Dice.terms).filter(term => {
        return /^d\d+$/.test(term) && CONFIG.Dice.terms[term];
      });

      for (const die of diceTypes) {
        CONFIG.Dice.fulfillment.dice[die] = "dice-link";
      }
    }
  }
  // Write "manual" to every die in the persistent config — this triggers Foundry's
  // onChange handler immediately, updating CONFIG.Dice.fulfillment.dice in memory
  // and suppressing Foundry's digital dice sound without a page reload
  try {
    const diceConfig = game.settings.get("core", "diceConfiguration");
    if (diceConfig && typeof diceConfig === "object") {
      const newConfig = {};
      for (const key of Object.keys(diceConfig)) {
        newConfig[key] = "manual";
      }
      await game.settings.set("core", "diceConfiguration", newConfig);
    }
  } catch (e) {}
  _savedDiceSound = CONFIG.sounds.dice;
  CONFIG.sounds.dice = null;
  disableDSN();
}

/**
 * Apply digital dice mode - removes our custom fulfillment method.
 * Players will see Foundry's standard digital dice animation.
 */
async function applyDigitalDice() {
  // Remove our fulfillment method, restore digital dice
  if (CONFIG.Dice.fulfillment) {
    CONFIG.Dice.fulfillment.defaultMethod = "";
    if (CONFIG.Dice.fulfillment.dice) {
      // Dynamically get available dice types from Foundry's configuration
      // This adapts to any custom dice Foundry supports
      const diceTypes = Object.keys(CONFIG.Dice.terms).filter(term => {
        return /^d\d+$/.test(term) && CONFIG.Dice.terms[term];
      });
      
      for (const die of diceTypes) {
        CONFIG.Dice.fulfillment.dice[die] = "";
      }
    }
  }
  
  // Reset every die in the persistent config back to Foundry's default (empty string)
  try {
    const diceConfig = game.settings.get("core", "diceConfiguration");
    if (diceConfig && typeof diceConfig === "object") {
      const newConfig = {};
      for (const key of Object.keys(diceConfig)) {
        newConfig[key] = "";
      }
      await game.settings.set("core", "diceConfiguration", newConfig);
    }
  } catch (e) {}
  if (_savedDiceSound !== null) {
    CONFIG.sounds.dice = _savedDiceSound;
    _savedDiceSound = null;
  }
  restoreDSN();
}

export {
  applyManualDice,
  applyDigitalDice
};
