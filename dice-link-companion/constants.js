/**
 * Constants Module - Dice Link Companion
 * Centralized location for all module constants, defaults, and configuration values.
 * No dependencies on other DLC modules (Tier 1).
 * 
 * All other modules import from this file to ensure single source of truth for constants.
 */

// Debug switch — set to false to silence all DLC console logging
export const DEBUG = true;

// Module metadata
export const MODULE_ID = "dice-link-companion";
export const MODULE_VERSION = "1.0.9.55";

// Branding
export const REALM_BRIDGE_URL = "https://realmbridge.co.uk";
export const LOGO_URL = "modules/dice-link-companion/assets/logo-header.png";
export const LOGO_SQUARE_URL = "modules/dice-link-companion/assets/logo-square.png";

// Timing constants (in milliseconds)
export const ASYNC_OPERATION_DELAY_MS = 40;

// Dice Link App connection
// Use explicit 127.0.0.1 (IPv4 loopback) instead of localhost to avoid IPv4/IPv6 mismatch
// Each player connects to their own local DLA instance on explicit IPv4
export const DICE_LINK_APP_HOST = "127.0.0.1";
export const DICE_LINK_APP_PORT = 8765;
// Dice configuration
export const DICE_TYPES = ["d4", "d6", "d8", "d10", "d12", "d20", "d100"];

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
    rollRequest: false,
    globalOverride: true,
    playerModes: true,
    permissions: true,
    videoFeed: true,
    pending: false,
    topRow: false
  },
  permissions: {
    playerCanRequestManual: true,
    playerCanSwitchToDigital: true
  }
};

// UI dimensions (for future use)
export const UI_DIMENSIONS = {
  PANEL_WIDTH: 400,
  PANEL_HEIGHT_MIN: 200,
  PANEL_HEIGHT_MAX: 800
};

// Role names mapping (from Foundry)
export const ROLE_NAMES = {
  1: "Player",
  2: "Trusted Player",
  3: "Assistant GM",
  4: "GM"
};
