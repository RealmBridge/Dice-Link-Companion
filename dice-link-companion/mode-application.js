/**
 * mode-application.js - switches this user's dice between manual and digital.
 * Registers "Dice Link Companion" as a Foundry dice fulfillment method. Manual: it becomes
 * Foundry's default method for this user, so Foundry asks for the dice values (DLA fills
 * them in, or the player types them if DLA isn't connected), and Dice So Nice stops
 * animating the rolls. Digital: whatever was there before comes back and Foundry rolls the
 * dice itself. Also decides which of the two applies at start-up and when the link to DLA
 * comes or goes. Which mode a group override gives a player is decided in settings.js
 * (getEffectiveMode).
 */

import { getEffectiveMode, getGlobalOverride, isUserInManualMode } from "./settings.js";
import { PLAYER_MODES, GLOBAL_OVERRIDE_MODES } from "./constants.js";
import { debugResolverState } from "./debug.js";

// ---- The Dice Link method ----

/**
 * Setup Dice Link as a fulfillment method. Called from main.mjs setup.
 * There is no resolver of our own: Foundry's own RollResolver is used, and
 * dice-entry-window.js hides it and asks DLA for the dice.
 */
export function setupDiceMethod() {
  debugResolverState("setup_fulfillment_starting", {});

  // Register "dice-link" as an interactive method that uses Foundry's default resolver
  // Our dialog hooks will hide the resolver and ask DLA for the dice
  CONFIG.Dice.fulfillment.methods["dice-link"] = {
    label: "DICE_LINK.Title",   // Foundry looks the key up in en.json
    icon: "fa-dice-d20",
    interactive: true
    // No custom resolver - we use Foundry's default RollResolver instead
  };

  debugResolverState("setup_fulfillment_complete", { methodRegistered: true });
}

// ---- Dice So Nice ----

// Whether the Dice So Nice module is switched on in this world
const dsnActive = () => !!game.modules.get("dice-so-nice")?.active;

// Saved fulfillment defaultMethod - captured before DLC overwrites it, restored on disconnect.
let _savedDefaultMethod = null;
// Hook ID for the explicit DSN suppression hook - null when not registered.
let _dsnSuppressionHookId = null;
// Original showForRoll - saved when we intercept it, restored on disconnect.
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

function restoreDSN() {
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

// ---- Manual and digital ----

/**
 * Apply manual dice mode: Dice Link becomes Foundry's default fulfillment method, so
 * Foundry shows its RollResolver. When DLA is connected, DLA fills values; when not,
 * readOnly is stripped in dice-entry-window.js so the user can type directly.
 * (Foundry uses this default for every die the player hasn't set a method for in
 * Foundry's own Dice Configuration.)
 */
async function applyManualDice() {
  // Only save the original on first call - guards against double-calls overwriting the
  // real original with "dice-link" (which would then be "restored" to "dice-link" on exit)
  if (_savedDefaultMethod === null) {
    _savedDefaultMethod = CONFIG.Dice.fulfillment.defaultMethod ?? "";
  }

  CONFIG.Dice.fulfillment.defaultMethod = "dice-link";
  disableDSN();
  debugResolverState("apply_dice_link_fulfillment", { savedMethod: _savedDefaultMethod });
}

/**
 * Apply digital dice mode.
 * Always restores whatever fulfillment method was active before DLC wrote to it.
 */
async function applyDigitalDice() {
  // Restore whatever was configured before DLC wrote to this - don't just clear it
  CONFIG.Dice.fulfillment.defaultMethod = _savedDefaultMethod ?? "";
  _savedDefaultMethod = null;
  restoreDSN();
  debugResolverState("remove_dice_link_fulfillment", {});
}

/**
 * Apply a mode to this user's dice: "manual" or "digital".
 * @param {string} mode
 */
function applyMode(mode) {
  return mode === PLAYER_MODES.MANUAL ? applyManualDice() : applyDigitalDice();
}

/**
 * Apply the mode a group override gives this user: everyone manual, everyone digital,
 * or ("individual") the user's own setting. Used by the GM's own screen when they change
 * the override and by every other screen when the GM's message arrives.
 * @param {string} override - "forceAllManual", "forceAllDigital" or "individual"
 */
function applyModeForOverride(override) {
  return applyMode(getEffectiveMode(game.user.id, override));
}

/**
 * At start-up (each time Foundry loads, e.g. after a refresh): set this user's dice to the
 * mode they're really in, whether or not DLA is there. Manual (own setting or the GM's
 * override): manual dice - DLA fills them in once it connects, or without DLA the player
 * types them in. The GM's "everyone digital" override: digital dice. Otherwise Foundry is
 * left as it is, with Dice So Nice animating.
 * (Foundry forgets DLC's dice setting on every reload, so it is set again here.)
 */
function applyStartingMode() {
  restoreDSN();
  if (isUserInManualMode()) {
    applyManualDice();
  } else if (getGlobalOverride() === GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL) {
    applyDigitalDice();
  }
}

/**
 * The link to DLA came or went. Connected: a user in manual mode gets manual dice.
 * Gone: back to digital dice (which also lets Dice So Nice animate again).
 * @param {boolean} connected
 */
function applyModeForConnection(connected) {
  if (!connected) {
    applyDigitalDice();
  } else if (isUserInManualMode()) {
    applyManualDice();
  }
}

export {
  applyDigitalDice,
  applyMode,
  applyModeForOverride,
  applyStartingMode,
  applyModeForConnection
};
