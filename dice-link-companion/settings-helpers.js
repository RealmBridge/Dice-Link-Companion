/**
 * settings-helpers.js - Foundry's own "manual rolls" permission for each player role (the
 * GM panel's Permissions switches): reading it, and turning it on or off for a role.
 */

import { ROLE_NAMES } from "./constants.js";

/** Whether each role (1-3) has Foundry's manual rolls permission, e.g. { 1: true, 2: false, 3: false }. */
export function getManualRollsPermissions() {
  try {
    const permissions = game.settings.get("core", "permissions") || {};
    const roles = permissions.MANUAL_ROLLS || [];
    return {
      1: roles.includes(1),
      2: roles.includes(2),
      3: roles.includes(3)
    };
  } catch (e) {
    return { 1: false, 2: false, 3: false };
  }
}

/**
 * Set manual rolls permission for a specific role
 * @param {number} role - Role ID (1-3)
 * @param {boolean} enabled - Whether to enable or disable
 * @returns {Promise<boolean>} Success status
 */
export async function setManualRollsPermission(role, enabled) {
  try {
    // Save current dice config before changing permissions (Foundry can reset it)
    let currentDiceConfig = null;
    if (enabled) {
      try {
        currentDiceConfig = game.settings.get("core", "diceConfiguration") || {};
      } catch (e) {}
    }
    
    const permissions = game.settings.get("core", "permissions") || {};
    let roles = permissions.MANUAL_ROLLS || [];
    roles = [...roles];
    
    if (enabled && !roles.includes(role)) {
      roles.push(role);
    } else if (!enabled && roles.includes(role)) {
      roles = roles.filter(r => r !== role);
    }
    
    roles.sort((a, b) => a - b);
    const newPermissions = { ...permissions, MANUAL_ROLLS: roles };
    await game.settings.set("core", "permissions", newPermissions);
    
    // Restore dice config if we saved it
    if (enabled && currentDiceConfig && Object.keys(currentDiceConfig).length > 0) {
      try {
        await game.settings.set("core", "diceConfiguration", currentDiceConfig);
      } catch (e) {}
    }
    
    return true;
  } catch (e) {
    ui.notifications.error(`Failed to update permission for ${ROLE_NAMES[role]}.`);
    return false;
  }
}
