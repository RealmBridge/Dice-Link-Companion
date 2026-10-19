/**
 * Dice Link Companion - Settings Module
 * Handles all game.settings registration and access.
 * Imports from constants.js for single source of truth on defaults.
 */

import { MODULE_ID, SETTING_DEFAULTS, PLAYER_MODES, GLOBAL_OVERRIDE_MODES } from "./constants.js";
import { debugError } from "./debug.js";

/**
 * Register core settings during the "init" hook.
 * These settings are available immediately when Foundry loads.
 */
export function registerCoreSettings() {
  // Global override setting - controls whether all players are forced to a mode
  game.settings.register(MODULE_ID, "globalOverride", {
    scope: "world",
    config: false,
    type: String,
    default: SETTING_DEFAULTS.globalOverride
  });

  // Pending approval requests storage
  game.settings.register(MODULE_ID, "pendingRequests", {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  // UI collapsed sections state - persists across panel refreshes
  game.settings.register(MODULE_ID, "collapsedSections", {
    scope: "client",
    config: false,
    type: Object,
    default: SETTING_DEFAULTS.collapsedSections
  });
}

/**
 * Register per-user player mode settings during the "ready" hook.
 * This runs after users are loaded so we can iterate over them.
 */
export function registerPlayerModeSettings() {
  for (const user of game.users) {
    registerPlayerModeSetting(user.id);
  }
}

/**
 * Register one player's mode setting, if it isn't already. Also used for a player added
 * after this browser loaded the game (e.g. joining through a Forge invite) - "ready" only
 * registered the players that existed then, so the GM couldn't approve them until a reload.
 * @param {string} userId - The user ID
 */
export function registerPlayerModeSetting(userId) {
  const key = `playerMode_${userId}`;
  const fullKey = `${MODULE_ID}.${key}`;
  if (game.settings.settings.has(fullKey)) return;
  try {
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: false,
      type: String,
      default: SETTING_DEFAULTS.playerMode
    });
  } catch (e) {
    debugError("Failed to register setting:", fullKey, e);
  }
}

/**
 * Get a setting value
 * @param {string} key - The setting key
 * @returns {*} The setting value
 */
export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

/**
 * Set a setting value
 * @param {string} key - The setting key
 * @param {*} value - The value to set
 */
export async function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

/**
 * Get the current player's mode
 * @returns {string} "manual" or "digital"
 */
export function getPlayerMode(userId = game.user.id) {
  const key = `playerMode_${userId}`;
  // Check if setting exists before trying to get it
  if (!game.settings.settings.has(`${MODULE_ID}.${key}`)) {
    // Setting not registered yet, return default
    return SETTING_DEFAULTS.playerMode;
  }
  try {
    return getSetting(key) || SETTING_DEFAULTS.playerMode;
  } catch (e) {
    // Fallback if setting somehow fails
    return SETTING_DEFAULTS.playerMode;
  }
}

/**
 * Set a player's mode
 * @param {string} userId - The user ID
 * @param {string} mode - "manual" or "digital"
 */
export async function setPlayerMode(userId, mode) {
  registerPlayerModeSetting(userId);   // a player added since this browser loaded the game
  return setSetting(`playerMode_${userId}`, mode);
}

/**
 * Get the global override setting
 * @returns {string} "individual", "forceAllManual", or "forceAllDigital"
 */
export function getGlobalOverride() {
  return getSetting("globalOverride");
}

/**
 * Set the global override
 * @param {string} value - The override value
 */
export async function setGlobalOverride(value) {
  return setSetting("globalOverride", value);
}

/**
 * Get pending approval requests
 * @returns {Array} Array of pending request objects
 */
export function getPendingRequests() {
  return getSetting("pendingRequests") || [];
}

/**
 * Set pending approval requests
 * @param {Array} requests - Array of pending request objects
 */
export async function setPendingRequests(requests) {
  return setSetting("pendingRequests", requests);
}

/**
 * Get collapsed sections state
 * @returns {Object} Current collapsed sections state
 */
export function getCollapsedSections() {
  try {
    const saved = getSetting("collapsedSections");
    if (!saved) return { ...SETTING_DEFAULTS.collapsedSections };
    
    // Merge with defaults to ensure all keys exist
    return { ...SETTING_DEFAULTS.collapsedSections, ...saved };
  } catch (e) {
    // Setting not registered yet
    return { ...SETTING_DEFAULTS.collapsedSections };
  }
}

/**
 * Set collapsed sections state
 * @param {Object} sections - The collapsed sections state
 */
export async function setCollapsedSections(sections) {
  return setSetting("collapsedSections", sections);
}

/**
 * Check if the current user is in manual dice mode.
 * Respects global overrides from the GM.
 * @returns {boolean} true if user should use manual dice
 */
export function isUserInManualMode() {
  const globalOverride = getGlobalOverride();
  if (globalOverride === GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL) return true;
  if (globalOverride === GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL) return false;
  const myMode = getPlayerMode();
  return myMode === PLAYER_MODES.MANUAL;
}
