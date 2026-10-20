/**
 * constants.js - the fixed values every other DLC script uses: the module's ID, the
 * debug switch, branding, timings, the player and override mode names, setting
 * defaults and Foundry's role names. Imports nothing from DLC, so any script can use it.
 */

// Debug switch - set to false to silence all DLC console logging
export const DEBUG = true;

// Module metadata
export const MODULE_ID = "dice-link-companion";

// Branding
export const REALM_BRIDGE_URL = "https://realmbridge.co.uk";
export const LOGO_URL = "modules/dice-link-companion/assets/logo-header.png";

// Timing constants (in milliseconds)
export const ASYNC_OPERATION_DELAY_MS = 40;

// Global override modes
export const GLOBAL_OVERRIDE_MODES = {
  INDIVIDUAL: "individual",          // Each player can choose their mode
  FORCE_ALL_MANUAL: "forceAllManual", // All players forced to manual mode
  FORCE_ALL_DIGITAL: "forceAllDigital" // All players forced to digital mode
};

// Player modes
export const PLAYER_MODES = {
  MANUAL: "manual",
  DIGITAL: "digital"
};

// Default settings for all players and UI state
export const SETTING_DEFAULTS = {
  globalOverride: GLOBAL_OVERRIDE_MODES.INDIVIDUAL,
  playerMode: PLAYER_MODES.DIGITAL,
  collapsedSections: {
    playerModes: true,
    pending: false,
    topRow: false
  }
};

// Foundry's player roles the GM panel's Permissions switches cover (the GM always has it)
export const ROLE_NAMES = {
  1: "Player",
  2: "Trusted Player",
  3: "Assistant GM"
};
