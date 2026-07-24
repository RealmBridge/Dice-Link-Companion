/**
 * Type Definitions - Dice Link Companion
 * JSDoc type definitions for better IDE support and documentation.
 * Not executable - purely for type hinting.
 */

/**
 * @typedef {Object} PendingRollRequest
 * @property {string} title - Title of the roll (e.g., "Strength Check")
 * @property {string} [subtitle] - Subtitle with formula or details
 * @property {string} formula - The dice formula (e.g., "1d20+5")
 * @property {boolean} [isMirroredDialog] - Whether this came from mirrored dialog
 * @property {Object} [mirrorData] - Data extracted from mirrored dialog
 * @property {Function} onComplete - Callback when user completes the roll
 */

/**
 * @typedef {Object} MirroredDialogData
 * @property {Object} app - The Foundry application/dialog object
 * @property {HTMLElement} html - The HTML element of the dialog
 * @property {Object} data - Extracted form data
 * @property {number} timestamp - When the dialog was mirrored
 */

/**
 * @typedef {Object} CollapsedSections
 * @property {boolean} rollRequest - Roll request section collapsed
 * @property {boolean} globalOverride - Global override section collapsed
 * @property {boolean} playerModes - Player modes section collapsed
 * @property {boolean} permissions - Permissions section collapsed
 * @property {boolean} videoFeed - Video feed section collapsed
 * @property {boolean} pending - Pending approvals section collapsed
 * @property {boolean} topRow - Top row controls collapsed
 */

/**
 * @typedef {Object} DialogFormData
 * @property {string} title - Dialog title
 * @property {Array<Object>} buttons - Button definitions
 * @property {Object} inputs - Form input values
 * @property {string} formula - Extracted dice formula
 * @property {HTMLElement} element - The dialog element
 */

export {};
