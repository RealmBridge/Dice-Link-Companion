/**
 * Dice Parsing Utility Module
 * Handles parsing dice formulas and executing rolls with user-provided values.
 * Uses Foundry's native Roll API for validation to support ALL Foundry dice notation.
 */

/**
 * Validate a dice formula using Foundry's native Roll.validate() method.
 * This ensures we support all Foundry-supported notation (kh, kl, x, r, cs, etc.)
 * without having to maintain our own parser.
 * 
 * @param {string} formula - The dice formula to validate
 * @returns {{valid: boolean, error: string|null}} Validation result
 */
export function validateDiceFormula(formula) {
  // Handle empty/null input
  if (!formula || typeof formula !== "string" || !formula.trim()) {
    return { valid: false, error: "Enter a dice formula first." };
  }
  
  const trimmed = formula.trim();
  
  // Use Foundry's native Roll.validate() - supports ALL Foundry dice notation
  try {
    const isValid = Roll.validate(trimmed);
    if (!isValid) {
      return { valid: false, error: "Invalid dice formula. Check your syntax." };
    }
    return { valid: true, error: null };
  } catch (e) {
    return { valid: false, error: `Invalid formula: ${e.message}` };
  }
}

/**
 * Parse dice from a formula string to determine what dice inputs we need
 * Returns array of {faces, index} for each individual die
 * @param {string} formula - Dice formula like "2d20+5" or "1d8+1d6"
 * @returns {Array} Array of {faces, index} objects for each die
 */
export function parseDiceFromFormula(formula) {
  const diceNeeded = [];
  // Match patterns like 2d20, 1d8, 4d6, etc.
  const diceRegex = /(\d+)d(\d+)/gi;
  let match;
  
  while ((match = diceRegex.exec(formula)) !== null) {
    const count = parseInt(match[1]) || 1;
    const faces = parseInt(match[2]) || 20;
    
    // Add individual dice entries
    for (let i = 0; i < count; i++) {
      diceNeeded.push({ faces, index: diceNeeded.length });
    }
  }
  
  return diceNeeded;
}

