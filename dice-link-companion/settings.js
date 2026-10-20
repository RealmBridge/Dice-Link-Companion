/**
 * settings.js - DLC's saved Foundry settings: registering them, and reading and writing
 * each one - every player's dice mode, the GM's group override, pending manual dice
 * requests, and which panel sections are collapsed. Also holds the two rules every other
 * script asks: which mode a player is really in (their own setting or the GM's group
 * override), and whether their manual dice request is waiting. Defaults come from
 * constants.js. When a player's mode, the group override or the pending requests are
 * saved, Foundry tells every screen, and each one brings its DLC panel and its own DLA's
 * player list up to date (onModesSaved).
 */

import { MODULE_ID, SETTING_DEFAULTS, PLAYER_MODES, GLOBAL_OVERRIDE_MODES } from "./constants.js";
import { debug, debugError } from "./debug.js";
import { modesChanged } from "./dice-panel.js";

// Foundry calls this on every screen (the one that saved it too) when a player's mode, the
// group override or the pending requests are saved: the panel and DLA's player list catch up
const onModesSaved = () => modesChanged();

// The saved setting holding one player's dice mode, and whether it's registered yet
const playerModeKey = (userId) => `playerMode_${userId}`;
const isPlayerModeRegistered = (userId) => game.settings.settings.has(`${MODULE_ID}.${playerModeKey(userId)}`);

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
    default: SETTING_DEFAULTS.globalOverride,
    onChange: onModesSaved
  });

  // Pending approval requests storage
  game.settings.register(MODULE_ID, "pendingRequests", {
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: onModesSaved
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
  if (isPlayerModeRegistered(userId)) return;
  const key = playerModeKey(userId);
  try {
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: false,
      type: String,
      default: SETTING_DEFAULTS.playerMode,
      onChange: onModesSaved
    });
  } catch (e) {
    debugError("Failed to register setting:", `${MODULE_ID}.${key}`, e);
  }
}

/**
 * Get a setting value
 * @param {string} key - The setting key
 * @returns {*} The setting value
 */
function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

/**
 * Set a setting value
 * @param {string} key - The setting key
 * @param {*} value - The value to set
 */
async function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

/**
 * Get the current player's mode
 * @returns {string} "manual" or "digital"
 */
export function getPlayerMode(userId = game.user.id) {
  // Setting not registered yet: return the default
  if (!isPlayerModeRegistered(userId)) return SETTING_DEFAULTS.playerMode;
  try {
    return getSetting(playerModeKey(userId)) || SETTING_DEFAULTS.playerMode;
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
  return setSetting(playerModeKey(userId), mode);
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
 * The mode a player is really in: the GM's group override if one is set, otherwise the
 * player's own setting. This rule is written here only; every other script asks it.
 * @param {string} [userId] - defaults to this user
 * @param {string} [override] - the group override; defaults to the saved one
 * @returns {string} "manual" or "digital"
 */
export function getEffectiveMode(userId = game.user.id, override = getGlobalOverride()) {
  if (override === GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL) return PLAYER_MODES.MANUAL;
  if (override === GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL) return PLAYER_MODES.DIGITAL;
  return getPlayerMode(userId);
}

/**
 * Whether a player's manual dice request is waiting for the GM. Requests only count while
 * the GM leaves everyone on their own setting (no group override).
 * @param {string} userId
 * @param {string} [override] - the group override; defaults to the saved one
 * @param {Array} [pending] - the pending requests; defaults to the saved ones
 * @returns {boolean}
 */
function isRequestPending(userId, override = getGlobalOverride(), pending = getPendingRequests()) {
  return override === GLOBAL_OVERRIDE_MODES.INDIVIDUAL && pending.some(req => req.playerId === userId);
}

/**
 * Whether the group override lets a player ask for manual dice (only while there's none).
 * @param {string} [override] - defaults to the saved one
 */
export function overrideAllowsManualRequest(override = getGlobalOverride()) {
  return override === GLOBAL_OVERRIDE_MODES.INDIVIDUAL;
}

/**
 * Whether the group override lets a player switch back to digital (not while the GM
 * forces everyone to manual).
 * @param {string} [override] - defaults to the saved one
 */
export function overrideAllowsSwitchToDigital(override = getGlobalOverride()) {
  return override !== GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL;
}

/**
 * Every player with the mode they're really in and whether their request is waiting -
 * what the DLC panel and DLA's player list both show.
 * @param {string} [override] - the group override; defaults to the saved one
 * @param {Array} [pending] - the pending requests; defaults to the saved ones
 * @returns {Array<{id, name, mode, isPending, isGM, isSelf}>}
 */
export function getPlayerModes(override = getGlobalOverride(), pending = getPendingRequests()) {
  return Array.from(game.users, user => ({
    id: user.id,
    name: user.name,
    mode: getEffectiveMode(user.id, override),
    isPending: isRequestPending(user.id, override, pending),
    isGM: user.isGM,
    isSelf: user.id === game.user?.id
  }));
}

/**
 * Check if the current user is in manual dice mode right now.
 * Defensive: returns false if settings are not ready yet.
 * @returns {boolean} true if user should use manual dice
 */
export function isUserInManualMode() {
  try {
    return getEffectiveMode() === PLAYER_MODES.MANUAL;
  } catch (e) {
    // Settings not ready yet, default to digital mode
    debug("isUserInManualMode: settings not ready, defaulting to false");
    return false;
  }
}
