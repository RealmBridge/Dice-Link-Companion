/**
 * Dialog Mirroring Module
 * Handles suppressing dnd5e roll dialogs and mirroring them to our panel UI
 */

import { getPlayerMode, getGlobalOverride } from "./settings.js";
import { debug, debugError, debugState, debugResolverCancel, debugResolverClosure, debugCloning, debugButtonDetection } from "./debug.js";
import { getConnectionStatus, sendMessage } from "./qwebchannel-client.js";

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
import { getMirroredDialog, setMirroredDialog, getPendingRollRequest, setPendingRollRequest, setDLAPhase } from "./state-management.js";

/**
 * Setup dialog mirroring - hook into ApplicationV2 and Dialog renders
 * Exported for use in main.mjs
 */
export function setupDialogMirroring() {
  // Try specific dnd5e roll configuration dialog hooks
  Hooks.on("renderRollConfigurationDialog", (app, html, data) => {
    debug("[DLC-HOOK] renderRollConfigurationDialog fired", { appName: app?.constructor?.name, appId: app?.id });
    handleDialogRender(app, html, data);
  });

  // Hook to detect when applications close (v14 uses closeApplicationV2)
  Hooks.on("closeApplicationV2", (app) => {
    debug("[DLC-HOOK] closeApplicationV2 fired", { appName: app?.constructor?.name, appId: app?.id });
    const dialogRef = getMirroredDialog();
    if (dialogRef?.app === app) {
      debug("Mirrored roll dialog closed — clearing state");
      setMirroredDialog(null);
      setPendingRollRequest(null);
      setDLAPhase(null);
    }
    if (app?.element?.classList?.contains("dlc-dialog")) {
      debug("DLC dialog is closing");
    }
  });

  // Generic hook for any application render - cast wide net
  Hooks.on("renderApplicationV2", (app, html, data) => {
    debug("[DLC-HOOK] renderApplicationV2 fired", { appName: app?.constructor?.name, appId: app?.id, htmlType: html?.constructor?.name });
    handleDialogRender(app, html, data);
  });
}

/**
 * Check if the current user is in manual dice mode
 * Respects global overrides from the GM
 * Defensive: returns false if settings not ready yet
 */
function isUserInManualMode() {
  try {
    const globalOverride = getGlobalOverride();
    if (globalOverride === "forceAllManual") return true;
    if (globalOverride === "forceAllDigital") return false;
    const myMode = getPlayerMode();
    return myMode === "manual";
  } catch (e) {
    // Settings not ready yet, default to digital mode
    debug("isUserInManualMode: settings not ready, defaulting to false");
    return false;
  }
}

/**
 * Handle dialog render - check if it's a roll dialog and mirror it
 */
function handleDialogRender(app, html, data) {
  const htmlEl = html instanceof jQuery ? html[0] : html;
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
    if (isRollDialog(app)) {
      const title = (app.title || "").toLowerCase();
      const isResolver = title.includes("roll resolution") || title.includes("resolver") ||
        app.constructor?.name?.toLowerCase().includes("rollresolver");
      if (isResolver) {
        const element = html instanceof jQuery ? html[0] : (html?.element || html);
        if (element) {
          element.querySelectorAll('input[type="number"]').forEach(input => {
            input.readOnly = false;
            input.removeAttribute("readonly");
          });
        }
      }
    }
    return;
  }

  const isRoll = isRollDialog(app);
  debug("[DLC-DIALOG] handleDialogRender", { appName: app?.constructor?.name, appId: app?.id, isRollDialog: isRoll });

  // Check if this is a roll dialog we should mirror
  if (isRoll) {
    const title = (app.title || "").toLowerCase();
    
    // Hide the native dialog element
    const htmlElement = html instanceof jQuery ? html[0] : html;
    const elementToHide = htmlElement?.style ? htmlElement : html?.element;
    
    // Roll Resolution dialogs - mirror these too using the same pattern
    if (title.includes("roll resolution") || title.includes("resolver") ||
        app.constructor?.name?.toLowerCase().includes("rollresolver")) {
      if (elementToHide?.style) {
        elementToHide.style.visibility = "hidden";
        elementToHide.style.pointerEvents = "none";
      }
      // Mirror the RollResolver to our panel
      mirrorRollResolverToPanel(app, html, data);
      return;
    }

    // IMPORTANT: Clone the HTML BEFORE hiding the element
    // Otherwise the cloned HTML will inherit our hidden styles
    mirrorDialogToPanel(app, html, data);

    // Hide the native dialog AFTER cloning
    // visibility:hidden keeps the app active in Foundry's eyes; display:none triggers auto-close
    if (elementToHide?.style) {
      elementToHide.style.visibility = "hidden";
      elementToHide.style.pointerEvents = "none";
    }
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
 * Extract data from native dialog and mirror to our panel
 */
function mirrorDialogToPanel(app, html, data) {
  try {
    debugCloning("Starting mirrorDialogToPanel", { appTitle: app?.title, htmlType: html?.constructor?.name });
    
    // Clone the system dialog's HTML element to preserve exact layout and styling
    let elementToClone;
    if (html instanceof jQuery) {
      elementToClone = html[0];
      debugCloning("HTML is jQuery", { length: html.length });
    } else if (html?.element) {
      elementToClone = html.element;
      debugCloning("HTML has .element property", { tagName: html.element?.tagName });
    } else if (html?.nodeType === 1) {
      elementToClone = html;
      debugCloning("HTML is Element (nodeType=1)", { tagName: html.tagName });
    }
    
    if (!elementToClone) {
      debugCloning("ERROR: Could not find element to clone", { html });
      return;
    }
    
    debugCloning("Element to clone found", { 
      tagName: elementToClone.tagName, 
      className: elementToClone.className,
      displayStyle: elementToClone.style?.display,
      innerHTML_length: elementToClone.innerHTML?.length 
    });
    
    // Log element state so we can see whether the duplicate-call guard is working
    debug("[DLC-DUPLICATE-CHECK] element state when guard runs", {
      display: elementToClone.style?.display || "(not set)",
      visibility: elementToClone.style?.visibility || "(not set)",
      tagName: elementToClone.tagName
    });

    // Skip if element is already hidden - this means we've already processed it
    // The hook fires twice (renderRollConfigurationDialog + renderApplicationV2) and
    // the second time the element has visibility:hidden set by the first processing pass
    if (elementToClone.style?.visibility === 'hidden') {
      debugCloning("Skipping clone - element already hidden (duplicate hook call)", {});
      return;
    }
    
    // Extract the inner content, NOT the outer <dialog> element
    // We want the .window-content (form and layout) AND the buttons to inject inline
    const windowContent = elementToClone.querySelector('.window-content');
    
    debugButtonDetection("Searching for buttons/footer", { 
      windowContentFound: !!windowContent,
      searchArea: "top-level selectors"
    });
    
    // Search for the footer/buttons in multiple locations (different systems place them differently)
    // dnd5e: buttons may be in form-buttons div inside the form
    // Other systems: may be in footer, .window-footer, .form-footer, or .dialog-buttons
    const selectors = [
      'footer',
      '.window-footer',
      '.form-footer',
      '.form-buttons',
      '.dialog-buttons',
      '[data-part="footer"]'
    ];
    
    let windowFooter = null;
    for (const selector of selectors) {
      const found = elementToClone.querySelector(selector);
      if (found) {
        debugButtonDetection(`Selector matched: ${selector}`, {
          elementTag: found.tagName,
          elementClass: found.className,
          elementHTML: found.outerHTML.substring(0, 300)
        });
        windowFooter = found;
        break;
      } else {
        debugButtonDetection(`Selector did not match: ${selector}`, {});
      }
    }
    
    // Also search within the form for buttons if not found at top level
    let buttonsInForm = null;
    if (windowContent && !windowFooter) {
      debugButtonDetection("Top-level buttons not found, searching within window-content", {});
      
      const formSelectors = [
        '.form-buttons',
        '.dialog-buttons',
        '[data-part="footer"]'
      ];
      
      for (const selector of formSelectors) {
        const found = windowContent.querySelector(selector);
        if (found) {
          debugButtonDetection(`Found in form with selector: ${selector}`, {
            elementTag: found.tagName,
            elementClass: found.className,
            elementHTML: found.outerHTML.substring(0, 300)
          });
          buttonsInForm = found;
          break;
        } else {
          debugButtonDetection(`Not found in form: ${selector}`, {});
        }
      }
      
      // If still not found, search for ANY buttons in the form
      if (!buttonsInForm) {
        debugButtonDetection("No labeled button container found, searching for plain button elements", {});
        const plainButtons = windowContent.querySelectorAll('button:not(.close):not(.header-control)');
        if (plainButtons.length > 0) {
          debugButtonDetection(`Found ${plainButtons.length} plain button elements`, {
            buttons: Array.from(plainButtons).map(b => ({ 
              text: b.textContent.trim(), 
              class: b.className,
              dataAction: b.dataset?.action
            }))
          });
        } else {
          debugButtonDetection("No button elements found at all", {
            windowContentHTML: windowContent.outerHTML.substring(0, 500)
          });
        }
      }
    }
    
    const footerToUse = windowFooter || buttonsInForm;
    
    // Wrap in a div with our identifier class so we can scope CSS overrides later
    const wrapper = document.createElement('div');
    wrapper.classList.add('dlc-cloned-system-dialog');
    
    // Clone the main window-content
    if (windowContent) {
      const windowContentClone = windowContent.cloneNode(true);
      
      // Remove any button containers already inside the window-content clone
      // to prevent duplication when we append footerToUse separately below
      const buttonSelectorsToStrip = [
        'nav.dialog-buttons', '.dialog-buttons', '.form-buttons', '.form-footer', 'footer'
      ];
      for (const sel of buttonSelectorsToStrip) {
        const existing = windowContentClone.querySelector(sel);
        if (existing) {
          debugButtonDetection(`Stripped duplicate buttons from window-content clone: ${sel}`, {
            elementClass: existing.className
          });
          existing.remove();
        }
      }
      
      wrapper.appendChild(windowContentClone);
    } else {
      // Fallback: clone the whole element if no window-content found
      wrapper.appendChild(elementToClone.cloneNode(true));
    }
    
    // Append the footer/buttons inside the form so it stays within the dialog's width constraint
    if (footerToUse) {
      const footerClone = footerToUse.cloneNode(true);
      // Remove flexrow class to prevent dnd5e's flex layout from stretching buttons
      if (footerClone.classList) {
        footerClone.classList.remove('flexrow');
        debugButtonDetection("Removed flexrow class from cloned footer", { 
          newClass: footerClone.className
        });
      }
      // Append inside the form element so buttons are constrained by the form's width
      const formInWrapper = wrapper.querySelector('form');
      if (formInWrapper) {
        formInWrapper.appendChild(footerClone);
        debugButtonDetection("Footer/buttons appended inside form", { 
          footerClass: footerClone.className,
          buttonCount: footerClone.querySelectorAll('button').length
        });
      } else {
        // Fallback: append to wrapper if no form found
        wrapper.appendChild(footerClone);
        debugButtonDetection("Footer/buttons appended to wrapper (no form found)", { 
          footerClass: footerClone.className
        });
      }
      debugButtonDetection("Footer/buttons successfully cloned and appended", { 
        footerHTML: footerToUse.outerHTML.substring(0, 300),
        footerClass: footerToUse.className,
        footerTag: footerToUse.tagName,
        buttonCount: footerToUse.querySelectorAll('button').length
      });
    } else {
      debugButtonDetection("CRITICAL: No footer/buttons found - searching entire element for buttons", {
        entireDialogHTML: elementToClone.outerHTML.substring(0, 1000),
        allButtons: Array.from(elementToClone.querySelectorAll('button:not(.close):not(.header-control)')).map(b => ({
          text: b.textContent.trim(),
          class: b.className,
          parent: b.parentElement?.className
        }))
      });
    }
    
    // Replace system dice images with DLC blank dice icons
    replaceDiceIcons(wrapper);
    
    // Convert to HTML string for state serialization
    const clonedHTMLString = wrapper.outerHTML;
    
    debugCloning("Cloned HTML string created", { 
      length: clonedHTMLString.length,
      preview: clonedHTMLString.substring(0, 200) + "..."
    });
    
    // Extract form data as backup for data access
    const formData = extractDialogFormData(app, html);
    
    // Store the cloned HTML string and dialog reference in state
    // The state listener in main.mjs will automatically handle panel updates
    setMirroredDialog({
      app,
      html,
      clonedHTML: clonedHTMLString,  // Store as HTML string for serialization
      data: formData,
      isMirroredDialog: true,
      timestamp: Date.now()
    });
    
    debugCloning("setMirroredDialog called successfully", { clonedHTMLLength: clonedHTMLString.length });
    
  } catch (e) {
    debugError("Error mirroring dialog:", e);
    debugCloning("ERROR in mirrorDialogToPanel", { error: e.message, stack: e.stack });
  }
}

/**
 * Mirror Foundry's RollResolver to our panel
 * Same pattern as dialog mirroring - hide theirs, show ours, submit to theirs
 */
function mirrorRollResolverToPanel(app, html, data) {
  try {
    // Normalize html to a DOM element
    let element;
    if (html instanceof jQuery) {
      element = html[0];
    } else if (html?.element) {
      element = html.element;
    } else if (html?.nodeType === 1) {
      element = html;
    } else {
      element = app?.element?.[0] || app?.element;
    }

    if (!element) {
      debug("mirrorRollResolverToPanel: Could not find element");
      return;
    }
    
    // Extract dice inputs from Foundry's resolver
    const diceInputs = element.querySelectorAll("input[type='number'], input[data-die]");
    const diceNeeded = [];

    debug("mirrorRollResolverToPanel: element found", JSON.stringify({
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      open: element.open
    }));
    debug("mirrorRollResolverToPanel: all inputs in element", JSON.stringify(Array.from(
      element.querySelectorAll("input")
    ).map(i => ({ type: i.type, name: i.name, max: i.max, dataDie: i.dataset?.die, placeholder: i.placeholder }))));
    debug("mirrorRollResolverToPanel: inputs matching selector", diceInputs.length);

    diceInputs.forEach((input, index) => {
      const faces = parseInt(input.max) || parseInt(input.dataset?.faces) || 20;
      const name = input.name || input.id || `die-${index}`;
      diceNeeded.push({
        type: `d${faces}`,
        faces: faces,
        index: index,
        inputName: name,
        inputElement: input
      });
    });

    if (diceNeeded.length === 0) {
      debug("mirrorRollResolverToPanel: No dice inputs found");
      return;
    }

    // Read Phase A values (buttonClicked, dlaRollId) BEFORE overwriting pending roll state
    const priorRoll = getPendingRollRequest();
    const rollType = priorRoll?.buttonClicked || "normal";
    const rollId = priorRoll?.dlaRollId || `dlc-${Date.now()}`;

    // Store resolver reference
    setMirroredDialog({
      app,
      html,
      element,
      isRollResolver: true,
      diceNeeded,
      timestamp: Date.now()
    });

    // Preserve Phase A values alongside resolver state
    setPendingRollRequest({
      ...priorRoll,
      isRollResolver: true,
      diceNeeded: diceNeeded,
    });

    // Build dice array for DLA
    const diceForDLA = diceNeeded.map(d => ({
      type: d.type,
      count: 1
    }));

    // Consolidate dice of same type
    const consolidatedDice = [];
    const diceMap = new Map();
    for (const d of diceForDLA) {
      if (diceMap.has(d.type)) {
        diceMap.get(d.type).count++;
      } else {
        const entry = { type: d.type, count: 1 };
        diceMap.set(d.type, entry);
        consolidatedDice.push(entry);
      }
    }

    // Build formula string
    const formulaParts = consolidatedDice.map(d => `${d.count}${d.type}`);
    const formula = formulaParts.join(" + ");

    debug("Sending dice request to DLA (Phase B)", { rollId, rollType, formula, dice: consolidatedDice });
    sendDiceRequest(rollId, consolidatedDice, formula, rollType);
    setDLAPhase("diceRequested");

    // Hide resolver — DLA handles dice entry; visibility:hidden keeps Foundry's app active
    element.style.visibility = "hidden";
    element.style.pointerEvents = "none";
    
  } catch (e) {
    debugError("Error mirroring RollResolver:", e);
  }
}

/**
 * Submit dice values to Foundry's hidden RollResolver
 */
async function submitToFoundryResolver(values) {
  const dialogRef = getMirroredDialog();
  if (!dialogRef || !dialogRef.isRollResolver) {
    debugError("No mirrored RollResolver to submit to");
    return;
  }
  
  const { element, diceNeeded, app } = dialogRef;
  
  try {
    // Fill in Foundry's hidden inputs with our values
    for (let i = 0; i < diceNeeded.length; i++) {
      const dieInfo = diceNeeded[i];
      const value = values[i];
      
      if (dieInfo.inputElement) {
        dieInfo.inputElement.value = value;
        dieInfo.inputElement.dispatchEvent(new Event("change", { bubbles: true }));
        dieInfo.inputElement.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    
    // Programmatic clicks work on visibility:hidden elements — no need to reveal first
    const submitButton = element.querySelector("button[type='submit'], button[data-action='submit'], .submit-button, button.default");
    if (submitButton) {
      submitButton.click();
    } else {
      // Try submitting the form directly
      const form = element.querySelector("form");
      if (form) {
        form.requestSubmit();
      }
    }

    // Small delay for processing
    await new Promise(resolve => setTimeout(resolve, 50));

    // Restore hidden state
    if (element?.style) {
      element.style.visibility = "hidden";
      element.style.pointerEvents = "none";
    }
    
    // Clear state
    setMirroredDialog(null);
    setPendingRollRequest(null);
    
  } catch (e) {
    debugError("Error submitting to Foundry resolver:", e);
  }
}

/**
 * Cancel Foundry's hidden RollResolver without submitting values
 */
export async function cancelFoundryResolver() {
  debug("cancelFoundryResolver called");
  const dialogRef = getMirroredDialog();
  if (!dialogRef || !dialogRef.isRollResolver) {
    // No resolver to cancel, just clear state
    debug("No roll resolver found, clearing state");
    setMirroredDialog(null);
    setPendingRollRequest(null);
    return;
  }
  
  const { element, app } = dialogRef;
  
  try {
    // Try to find and click a cancel/close button in the resolver
    const cancelButton = element?.querySelector("button[data-action='cancel'], button.cancel, .close-button, button[type='button']:not([type='submit'])");
    debug("Cancel button found:", !!cancelButton);
    
    if (cancelButton) {
      // Programmatic clicks work on visibility:hidden elements — no need to reveal first
      debug("Clicking cancel button");
      cancelButton.click();
      await new Promise(resolve => setTimeout(resolve, 50));
    } else if (app?.close) {
      // Fallback: close the application directly
      debug("No cancel button, closing app directly");
      await app.close();
    }

    // Ensure it's hidden
    if (element?.style) {
      element.style.visibility = "hidden";
      element.style.pointerEvents = "none";
    }
    
    // Clear state
    debug("Clearing mirrored dialog state");
    setMirroredDialog(null);
    setPendingRollRequest(null);
    
  } catch (e) {
    debugError("Error in cancelFoundryResolver:", e);
    // Still clear state on error
    setMirroredDialog(null);
    setPendingRollRequest(null);
  }
}

/**
 * Extract relevant form data from the native dialog
 */
function extractDialogFormData(app, html) {
  // Normalize html to a DOM element
  let element;
  if (html instanceof jQuery) {
    element = html[0];
  } else if (html?.element) {
    element = html.element;
  } else if (html?.nodeType === 1) {
    element = html;
  } else {
    element = app?.element?.[0] || app?.element || document.querySelector(`[data-appid="${app?.appId}"]`);
  }
  
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

  debug("extractDialogFormData: buttons captured", JSON.stringify(data.buttons.map(b => ({
    label: b.label,
    action: b.action,
    tagName: b.element?.tagName,
    type: b.element?.type
  }))));

  return data;
}


/**
 * Replace system dice images with DLC blank dice icons
 * @param {HTMLElement} wrapper - The cloned dialog wrapper element
 */
function replaceDiceIcons(wrapper) {
  const diceMap = {
    'd4': 'modules/dice-link-companion/assets/DLC%20Dice/D4/d4-blank.svg',
    'd6': 'modules/dice-link-companion/assets/DLC%20Dice/D6/d6-blank.svg',
    'd8': 'modules/dice-link-companion/assets/DLC%20Dice/D8/d8-blank.svg',
    'd10': 'modules/dice-link-companion/assets/DLC%20Dice/D10/d10-blank.svg',
    'd12': 'modules/dice-link-companion/assets/DLC%20Dice/D12/d12-blank.svg',
    'd20': 'modules/dice-link-companion/assets/DLC%20Dice/D20/d20-blank.svg',
    'd100': 'modules/dice-link-companion/assets/DLC%20Dice/D100/d100-blank.svg'
  };
  
  // Find all images that might be dice icons
  const images = wrapper.querySelectorAll('img');
  
  for (const img of images) {
    const src = img.getAttribute('src') || '';
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    
    // Check if image source or alt contains dice type
    for (const [dieType, dlcPath] of Object.entries(diceMap)) {
      if (src.toLowerCase().includes(dieType) || alt.includes(dieType)) {
        img.setAttribute('src', dlcPath);
        // Add a class so we can style it
        img.classList.add('dlc-dice-icon');
        break;
      }
    }
  }
}
