/**
 * dialog-mirroring.js - Foundry's roll windows, for a user in manual mode.
 * With DLA connected: hides each roll window (the roll's options dialog, then Foundry's
 * dice resolver) and passes DLA what it needs - the roll's buttons and options (stored
 * as the "mirrored dialog"; main.mjs sends it to DLA), then which dice to roll.
 * Without DLA: unlocks Foundry's resolver so the player can type their dice values.
 */

import { isUserInManualMode } from "./settings.js";
import { debug, debugError, debugRollWindow, describeButtons } from "./debug.js";
import { getConnectionStatus, sendMessage } from "./qwebchannel-client.js";
import { getMirroredDialog, setMirroredDialog, getPendingRollRequest, setDLAPhase, clearRollState } from "./state-management.js";

/**
 * The page element of a window Foundry hands to a render hook. Foundry 13-14 hand the
 * element itself; older code paths handed a jQuery object or an object holding .element.
 * Every one of those cases is kept. Returns null if none fits.
 */
export function windowElement(html) {
  if (html instanceof jQuery) return html[0];
  if (html?.element) return html.element;
  if (html?.nodeType === 1) return html;
  return null;
}

/** Whether a roll window is Foundry's dice resolver (the window asking for each die's value). */
function isResolverWindow(app) {
  const title = (app.title || "").toLowerCase();
  return title.includes("roll resolution") || title.includes("resolver") ||
    app.constructor?.name?.toLowerCase().includes("rollresolver");
}

/**
 * Hide one of Foundry's windows from the player. visibility:hidden keeps the window active
 * in Foundry's eyes (display:none would make it close itself); programmatic clicks still work.
 */
function hideWindow(element) {
  if (element?.style) {
    element.style.visibility = "hidden";
    element.style.pointerEvents = "none";
  }
}

// Wrapper for sendDiceRequest to use QWebChannel
function sendDiceRequest(rollId, dice, formula, rollType) {
  sendMessage({
    type: "diceRequest",
    id: rollId,
    dice: dice,
    formula: formula,
    rollType: rollType
  });
}

/**
 * Setup dialog mirroring - hook into ApplicationV2 and Dialog renders
 * Exported for use in main.mjs
 */
export function setupDialogMirroring() {
  // Try specific dnd5e roll configuration dialog hooks
  Hooks.on("renderRollConfigurationDialog", (app, html) => {
    debug("[DLC-HOOK] renderRollConfigurationDialog fired", { appName: app?.constructor?.name, appId: app?.id });
    handleDialogRender(app, html);
  });

  // Hook to detect when applications close (v14 uses closeApplicationV2)
  Hooks.on("closeApplicationV2", (app) => {
    debug("[DLC-HOOK] closeApplicationV2 fired", { appName: app?.constructor?.name, appId: app?.id });
    const dialogRef = getMirroredDialog();
    if (dialogRef?.app === app) {
      debug("Mirrored roll dialog closed — clearing state");
      clearRollState();
    }
    if (app?.element?.classList?.contains("dlc-dialog")) {
      debug("DLC dialog is closing");
    }
  });

  // Generic hook for any application render - cast wide net
  Hooks.on("renderApplicationV2", (app, html) => {
    debug("[DLC-HOOK] renderApplicationV2 fired", { appName: app?.constructor?.name, appId: app?.id, htmlType: html?.constructor?.name });
    handleDialogRender(app, html);
  });
}

/**
 * Handle dialog render - check if it's a roll dialog and mirror it
 */
function handleDialogRender(app, html) {
  const htmlEl = windowElement(html);
  debug("[DLC-HTML-DIAG] app=" + (app?.constructor?.name ?? "null") +
    " nodeType=" + (htmlEl?.nodeType ?? "null") +
    " htmlType=" + (htmlEl?.constructor?.name ?? "null") +
    " inMainDoc=" + (htmlEl?.ownerDocument === document) +
    " hasStyle=" + (htmlEl?.style !== undefined));

  if (!isUserInManualMode()) {
    return;
  }

  if (!getConnectionStatus()) {
    // DLA not connected — if Foundry's RollResolver is showing, strip readOnly so the
    // user can type their physical dice values directly into Foundry's own inputs
    if (isRollDialog(app) && isResolverWindow(app) && htmlEl) {
      htmlEl.querySelectorAll('input[type="number"]').forEach(input => {
        input.readOnly = false;
        input.removeAttribute("readonly");
      });
    }
    return;
  }

  const isRoll = isRollDialog(app);
  debug("[DLC-DIALOG] handleDialogRender", { appName: app?.constructor?.name, appId: app?.id, isRollDialog: isRoll });

  // Check if this is a roll dialog we should mirror
  if (isRoll) {
    // Roll Resolution dialogs - hide, then ask DLA for the dice
    if (isResolverWindow(app)) {
      hideWindow(htmlEl);
      passRollResolverToDLA(app, html);
      return;
    }

    // Pass it to DLA before hiding it: once hidden, the second render hook for the same
    // window is skipped (see the check in passRollDialogToDLA)
    passRollDialogToDLA(app, html);
    hideWindow(htmlEl);
  }
}

/**
 * Check if an application is a roll dialog we should mirror
 * Be SPECIFIC - only target dnd5e roll configuration dialogs, not other modules
 */
function isRollDialog(app) {
  if (!app) return false;
  
  // Get identifiers for this dialog
  const className = app.constructor?.name?.toLowerCase() || "";
  const appId = (app.id || "").toLowerCase();
  const dialogTitle = (app.title || "").toLowerCase();
  
  // EXCLUDE known third-party module dialogs by checking EXACT patterns
  const excludedPatterns = [
    "monks-tokenbar",
    "tokenbar",
    "contested",
    "request-roll",
    "lmrtfy",
    "gm-screen",
    "popout",
    "compendium",
    "settings",
    "filepicker",
    "journal",
    "actor-sheet",
    "item-sheet"
  ];
  
  // Check if this is an excluded dialog
  const fullId = `${className} ${appId} ${dialogTitle}`;
  if (excludedPatterns.some(pattern => fullId.includes(pattern))) {
    return false;
  }
  
  // Check app constructor name for SPECIFIC dnd5e roll dialog classes
  const rollDialogClasses = [
    "rollconfigurationdialog",
    "d20roll",
    "damageroll",
    "rollresolver",
    "baseconfigurationdialog"
  ];
  
  if (rollDialogClasses.some(cls => className.includes(cls))) {
    return true;
  }
  
  // For title-based matching, check for dnd5e ability/skill checks
  const abilityNames = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
  const skillNames = ["acrobatics", "animal handling", "arcana", "athletics", "deception", "history", 
                      "insight", "intimidation", "investigation", "medicine", "nature", "perception", 
                      "performance", "persuasion", "religion", "sleight of hand", "stealth", "survival"];
  
  const hasAbility = abilityNames.some(ability => dialogTitle.includes(ability));
  const hasSkill = skillNames.some(skill => dialogTitle.includes(skill));
  const isCheckDialog = dialogTitle.includes("check");
  const isSaveDialog = dialogTitle.includes("saving") || dialogTitle.includes("save");
  const isAttackDialog = dialogTitle.includes("attack");
  const isDamageDialog = dialogTitle.includes("damage");
  const isInitiativeDialog = dialogTitle.includes("initiative");
  const isDeathSaveDialog = dialogTitle.includes("death") && dialogTitle.includes("sav");
  const isConcentrationSave = dialogTitle.includes("concentration") && isSaveDialog;
  
  // Match dnd5e roll dialogs by title patterns
  if (hasAbility && isCheckDialog) return true;
  if (hasSkill && isCheckDialog) return true;
  if ((hasAbility || dialogTitle.includes("ability")) && (isSaveDialog || isCheckDialog)) return true;
  if (isAttackDialog) return true;
  if (isDamageDialog) return true;
  if (isInitiativeDialog) return true;
  if (isDeathSaveDialog) return true;
  if (isConcentrationSave) return true;
  
  return false;
}

/**
 * Pass a roll's options window (e.g. dnd5e's roll configuration dialog) to DLA: store it
 * with its buttons and options as the "mirrored dialog"; main.mjs's listener then sends
 * DLA the roll request. The caller hides the window afterwards.
 */
function passRollDialogToDLA(app, html) {
  try {
    debugRollWindow("Starting passRollDialogToDLA", { appTitle: app?.title, htmlType: html?.constructor?.name });

    const dialogElement = windowElement(html);
    if (!dialogElement) {
      debugRollWindow("ERROR: Could not find the dialog element", { html });
      return;
    }

    // Log element state so we can see whether the duplicate-call guard is working
    debug("[DLC-DUPLICATE-CHECK] element state when guard runs", {
      display: dialogElement.style?.display || "(not set)",
      visibility: dialogElement.style?.visibility || "(not set)",
      tagName: dialogElement.tagName
    });

    // Skip if element is already hidden - this means we've already processed it
    // The hook fires twice (renderRollConfigurationDialog + renderApplicationV2) and
    // the second time the element has visibility:hidden set by the first processing pass
    if (dialogElement.style?.visibility === 'hidden') {
      debugRollWindow("Skipping - element already hidden (duplicate hook call)", {});
      return;
    }

    // The window's buttons and options, for DLA
    const formData = extractDialogFormData(app, html);

    // Store the dialog reference in state; the state listener in main.mjs sends DLA the roll request
    setMirroredDialog({
      app,
      html,
      data: formData
    });

    debugRollWindow("setMirroredDialog called successfully", {});

  } catch (e) {
    debugError("Error mirroring dialog:", e);
    debugRollWindow("ERROR in passRollDialogToDLA", { error: e.message, stack: e.stack });
  }
}

/**
 * Pass Foundry's dice resolver (the window asking for each die's value) to DLA: send DLA
 * the dice to roll, then hide the resolver. main.mjs fills in the values DLA sends back.
 */
function passRollResolverToDLA(app, html) {
  try {
    const element = windowElement(html) || app?.element?.[0] || app?.element;
    if (!element) {
      debug("passRollResolverToDLA: Could not find element");
      return;
    }
    
    // Extract dice inputs from Foundry's resolver
    const diceInputs = element.querySelectorAll("input[type='number'], input[data-die]");

    debug("passRollResolverToDLA: element found", JSON.stringify({
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      open: element.open
    }));
    debug("passRollResolverToDLA: all inputs in element", JSON.stringify(Array.from(
      element.querySelectorAll("input")
    ).map(i => ({ type: i.type, name: i.name, max: i.max, dataDie: i.dataset?.die, placeholder: i.placeholder }))));
    debug("passRollResolverToDLA: inputs matching selector", diceInputs.length);

    // The die type of each value the resolver asks for, e.g. ["d20", "d6", "d6"]
    const diceTypes = Array.from(diceInputs, input =>
      `d${parseInt(input.max) || parseInt(input.dataset?.faces) || 20}`);

    if (diceTypes.length === 0) {
      debug("passRollResolverToDLA: No dice inputs found");
      return;
    }

    // Phase A values (buttonClicked, dlaRollId) from the button DLA chose
    const priorRoll = getPendingRollRequest();
    const rollType = priorRoll?.buttonClicked || "normal";
    const rollId = priorRoll?.dlaRollId || `dlc-${Date.now()}`;

    // Store resolver reference (main.mjs fills its inputs when DLA sends the values)
    setMirroredDialog({
      app,
      html,
      element
    });

    // Consolidate dice of same type
    const consolidatedDice = [];
    const diceMap = new Map();
    for (const type of diceTypes) {
      if (diceMap.has(type)) {
        diceMap.get(type).count++;
      } else {
        const entry = { type, count: 1 };
        diceMap.set(type, entry);
        consolidatedDice.push(entry);
      }
    }

    // Build formula string
    const formulaParts = consolidatedDice.map(d => `${d.count}${d.type}`);
    const formula = formulaParts.join(" + ");

    debug("Sending dice request to DLA (Phase B)", { rollId, rollType, formula, dice: consolidatedDice });
    sendDiceRequest(rollId, consolidatedDice, formula, rollType);
    setDLAPhase("diceRequested");

    // Hide resolver — DLA handles dice entry
    hideWindow(element);
    
  } catch (e) {
    debugError("Error mirroring RollResolver:", e);
  }
}

/**
 * Extract relevant form data from the native dialog
 */
function extractDialogFormData(app, html) {
  const element = windowElement(html) || app?.element?.[0] || app?.element ||
    document.querySelector(`[data-appid="${app?.appId}"]`);
  
  if (!element) {
    return null;
  }
  
  const data = {
    title: app.title || app.options?.title || "Roll",
    buttons: [],
    inputs: {},
    formula: "",
    element: element
  };
  
  // Extract buttons
  const buttonElements = element.querySelectorAll("button, [data-action]");
  for (const btn of buttonElements) {
    const label = btn.textContent?.trim() || btn.dataset?.action || "";
    if (label && !btn.classList.contains("close") && !btn.classList.contains("header-control")) {
      data.buttons.push({
        label: label,
        element: btn,
        dataset: btn.dataset,
        action: btn.dataset?.action
      });
    }
  }
  
  // Extract form inputs
  const inputs = element.querySelectorAll("input, select, textarea");
  debug("[DLC-INPUTS] all form elements found in dialog", JSON.stringify(Array.from(inputs).map(i => ({
    tag: i.tagName,
    type: i.type,
    name: i.name,
    id: i.id,
    value: i.value,
    checked: i.checked,
    optionCount: i.tagName === "SELECT" ? i.options?.length : undefined
  }))));
  for (const input of inputs) {
    const name = input.name || input.id;
    if (name) {
      data.inputs[name] = {
        type: input.type,
        value: input.value,
        checked: input.checked,
        element: input,
        options: input.tagName === "SELECT" 
          ? Array.from(input.options).map(opt => ({ value: opt.value, label: opt.text }))
          : null
      };
    }
  }
  
  // Try to extract formula
  const formulaSelectors = "[data-formula], .formula, .dice-formula, .roll-formula, .dice-result";
  const formulaElement = element.querySelector(formulaSelectors);
  if (formulaElement) {
    data.formula = formulaElement.textContent.trim();
  }

  debug("extractDialogFormData: buttons captured", describeButtons(data.buttons));

  return data;
}


// Labels DLA shows for the roll options it knows; any other option name is made readable
const FIELD_LABELS = {
  situational: 'Situational Bonus',
  rollMode: 'Roll Mode',
  ability: 'Ability',
  skill: 'Skill',
  tool: 'Tool',
  dc: 'DC',
  flavor: 'Flavor Text'
};

/** A roll option's label for DLA, from its form name (e.g. "roll.0.situational"). */
function fieldLabel(fieldName) {
  const baseName = fieldName.includes('.') ? fieldName.split('.').pop() : fieldName;
  if (FIELD_LABELS[baseName]) return FIELD_LABELS[baseName];
  return baseName.charAt(0).toUpperCase() + baseName.slice(1).replace(/([A-Z])/g, ' $1');
}

/**
 * Extract roll data from a mirrored dialog and format it for sending to DLA.
 * @param {Object} dialogData - Data from setMirroredDialog
 * @returns {Object} Formatted roll data for DLA
 */
export function extractRollDataForDLA(dialogData) {
  const { data: formData } = dialogData;

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

  const configFields = [];
  if (formData?.inputs) {
    for (const [name, input] of Object.entries(formData.inputs)) {
      if (input.type === "select-one" || input.options) {
        configFields.push({ name, label: fieldLabel(name), type: "select", options: input.options || [], selected: input.value });
      } else if (input.type === "text" || input.type === "number" || !input.type) {
        configFields.push({ name, label: fieldLabel(name), type: input.type || "text", value: input.value || "" });
      }
    }
  }

  const buttons = [];
  if (formData?.buttons) {
    for (const btn of formData.buttons) {
      buttons.push({
        id: btn.action || btn.label?.toLowerCase().replace(/\s+/g, '-') || `btn-${buttons.length}`,
        label: btn.label
      });
    }
  }

  debug("[DLC-EXTRACT] configFields built for DLA", JSON.stringify(configFields));
  debug("[DLC-EXTRACT] buttons built for DLA", JSON.stringify(buttons));

  return {
    title: formData?.title || "Roll",
    subtitle: formData?.formula || "",
    formula: formData?.formula || "",
    dice,
    configFields,
    buttons
  };
}
