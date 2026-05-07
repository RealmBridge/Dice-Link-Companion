/**
 * WebSocket Client Module - Dice Link Companion
 * Legacy file retained for the two functions still imported by live code.
 * All WebSocket connection logic has been replaced by qwebchannel-client.js.
 */

import { debug as debugWebSocket } from "./debug.js";

// Current pending dice request (Phase B tracking)
let pendingDiceRequest = null;

/**
 * Clear the pending dice request
 */
export function clearPendingDiceRequest() {
  pendingDiceRequest = null;
}

/**
 * Extract roll data from mirrored dialog for sending to DLA
 * @param {Object} dialogData - Data from setMirroredDialog
 * @returns {Object} Formatted roll data for DLA
 */
export function extractRollDataForDLA(dialogData) {
  const { data: formData } = dialogData;

  // Extract dice from formula (basic parsing)
  const dice = [];
  const formulaMatch = formData?.formula?.match(/(\d*)d(\d+)/gi) || [];
  for (const match of formulaMatch) {
    const parts = match.toLowerCase().match(/(\d*)d(\d+)/);
    if (parts) {
      const count = parseInt(parts[1]) || 1;
      const type = `d${parts[2]}`;
      dice.push({ type, count });
    }
  }

  // Extract config fields from form inputs
  const configFields = [];
  if (formData?.inputs) {
    for (const [name, input] of Object.entries(formData.inputs)) {
      const generateLabel = (fieldName) => {
        const labelMap = {
          'situational': 'Situational Bonus',
          'rollMode': 'Roll Mode',
          'ability': 'Ability',
          'skill': 'Skill',
          'tool': 'Tool',
          'dc': 'DC',
          'flavor': 'Flavor Text'
        };
        const baseName = fieldName.includes('.') ? fieldName.split('.').pop() : fieldName;
        if (labelMap[baseName]) return labelMap[baseName];
        return baseName.charAt(0).toUpperCase() + baseName.slice(1).replace(/([A-Z])/g, ' $1');
      };

      if (input.type === "select-one" || input.options) {
        configFields.push({
          name,
          label: generateLabel(name),
          type: "select",
          options: input.options || [],
          selected: input.value
        });
      } else if (input.type === "text" || input.type === "number" || !input.type) {
        configFields.push({
          name,
          label: generateLabel(name),
          type: input.type || "text",
          value: input.value || ""
        });
      }
    }
  }

  // Extract buttons
  const buttons = [];
  if (formData?.buttons) {
    for (const btn of formData.buttons) {
      buttons.push({
        id: btn.action || btn.label?.toLowerCase().replace(/\s+/g, '-') || `btn-${buttons.length}`,
        label: btn.label
      });
    }
  }

  debugWebSocket("[DLC-EXTRACT] configFields built for DLA", JSON.stringify(configFields));
  debugWebSocket("[DLC-EXTRACT] buttons built for DLA", JSON.stringify(buttons));

  return {
    title: formData?.title || "Roll",
    subtitle: formData?.formula || "",
    formula: formData?.formula || "",
    dice,
    configFields,
    buttons
  };
}
