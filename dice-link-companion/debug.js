/**
 * debug.js - all of DLC's diagnostics, in one place. Console logging (DLA keeps the
 * "[Dice Link ...]" lines in its own log), extra checks on Foundry's dice resolver, full
 * error stack traces, and the Dice So Nice check. Switched on and off by DEBUG in
 * constants.js.
 */

import { DEBUG } from "./constants.js";
const DEBUG_ENABLED = DEBUG;

/**
 * Make a console logger with its own "[Dice Link ...]" label (DLA keeps lines with that
 * label in its log). Silent when DEBUG is off.
 * @param {string} label - e.g. "[Dice Link Camera]"
 * @param {string} [method] - the console method: "log" or "error"
 */
function logger(label, method = "log") {
  return (...args) => {
    if (DEBUG_ENABLED) console[method](label, ...args);
  };
}

export const debug = logger("[Dice Link Debug]");
export const debugError = logger("[Dice Link Debug]", "error");
export const debugResolverState = logger("[Dice Link Resolver State]");  // Foundry's dice resolver
export const debugQWebChannel = logger("[Dice Link QWebChannel]");       // the link to DLA
export const debugCamera = logger("[Dice Link Camera]");                 // dice clips
export const debugChatLog = logger("[Dice Link Chat Log]");              // the chat copy in DLA

/**
 * A page element - a roll window, a button, an input - or a list of them, summarised for
 * the log: its tag, id, class, type, name, value, text, action, limits, whether it shows,
 * and whether it is still on the page (empty fields left out). Every DLC script describes
 * elements for the log with this. It never throws, so a log line can't stop a roll.
 * @param {Element|Element[]|NodeList|null} what
 * @returns {string} JSON
 */
export function describe(what) {
  const one = (el) => {
    if (el?.nodeType !== 1) return el ?? null;
    const fields = {
      tag: el.tagName, id: el.id, class: el.className, type: el.type, name: el.name,
      value: el.value, checked: el.checked, max: el.max, placeholder: el.placeholder,
      die: el.dataset?.die, action: el.dataset?.action, text: el.textContent?.trim().slice(0, 60),
      options: el.tagName === "SELECT" ? el.options.length : undefined,
      display: getComputedStyle(el).display, visibility: el.style.visibility,
      open: el.open, inPage: el.isConnected
    };
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  };
  try {
    const isList = what && typeof what === "object" && what.nodeType !== 1 && typeof what.length === "number";
    return JSON.stringify(isList ? Array.from(what, one) : one(what));
  } catch (e) {
    return `(could not describe: ${e.message})`;
  }
}

/**
 * Patch a RollResolver app instance to log whether _onSubmitForm fires,
 * what form data it receives, and whether it completes or throws.
 * Also logs if close() is called without a prior successful submit.
 * @param {ApplicationV2} resolverApp - The RollResolver ApplicationV2 instance
 */
export function patchResolverForDiagnostics(resolverApp) {
  if (!resolverApp || !DEBUG_ENABLED) return;

  let submitFired = false;

  const origSubmit = resolverApp._onSubmitForm.bind(resolverApp);
  resolverApp._onSubmitForm = async function(formConfig, event) {
    submitFired = true;
    let formDataObj = {};
    try { formDataObj = new FormDataExtended(this.element).object; } catch(e) {}
    console.log("[Dice Link Resolver Diag] _onSubmitForm called", JSON.stringify({
      formDataKeys: Object.keys(formDataObj),
      formDataValues: formDataObj
    }));
    try {
      await origSubmit(formConfig, event);
      console.log("[Dice Link Resolver Diag] _onSubmitForm completed successfully");
    } catch(e) {
      console.log("[Dice Link Resolver Diag] _onSubmitForm threw", e.message);
      throw e;
    }
  };

  const origClose = resolverApp.close.bind(resolverApp);
  resolverApp.close = async function(options) {
    console.log("[Dice Link Resolver Diag] close() called", JSON.stringify({
      submitHadFired: submitFired,
      rendered: this.rendered
    }));
    return origClose(options);
  };
}

/**
 * Install global error diagnostics to capture full stack traces for crashes that
 * occur during roll processing.  Covers two cases:
 *
 * 1. Unhandled promise rejections (e.g. "null.rolling" after attack submit).
 * 2. Errors caught-and-logged by third-party code such as midi-qol's doDamageRoll,
 *    which calls console.error(message, err) - the stack trace is on the Error object
 *    but is never printed separately, so it never appears in the DLA log.
 *
 * Must be called once at module init before any rolls can occur.
 */
export function installErrorDiagnostics() {
  if (!DEBUG_ENABLED) return;

  window.addEventListener("unhandledrejection", (event) => {
    const err = event.reason;
    if (!err) return;
    console.error(
      "[Dice Link Error Diag] Unhandled rejection:", err.message ?? String(err),
      "\nStack:", err.stack ?? "(no stack)"
    );
  });

  const _origError = console.error.bind(console);
  console.error = function(...args) {
    _origError(...args);
    for (const arg of args) {
      if (arg instanceof Error && arg.stack) {
        _origError("[Dice Link Error Diag] Stack trace:", arg.stack);
      }
    }
  };

  console.log("[Dice Link Error Diag] Error diagnostics installed");
}

/**
 * Check whether Dice So Nice suppression is currently working on this client.
 * Reports: whether DSN is active, how many hooks are registered for the pre-process
 * event, and whether firing a test event actually suppresses willTrigger3DRoll.
 *
 * Call from the Foundry CMD prompt: debugDSNStatus()
 */
function debugDSNStatus() {
  if (!DEBUG_ENABLED) return;
  const prefix = "[Dice Link DSN Diag]";

  const dsnActive = !!game.modules.get("dice-so-nice")?.active;
  console.log(prefix, "DSN active:", dsnActive);
  if (!dsnActive) {
    console.log(prefix, "DSN is not active - suppression not applicable");
    return;
  }

  // Check the suppression switch that DSN reads before any animation logic runs
  const messageHookDisabled = game.dice3d?.messageHookDisabled;
  console.log(prefix, "game.dice3d exists:", !!game.dice3d);
  console.log(prefix, "messageHookDisabled:", messageHookDisabled);
  console.log(prefix, "Suppression switch ON:", messageHookDisabled === true);

  // Check the disabledForManualRolls setting (second suppression path in DSN)
  try {
    const disabledForManualRolls = game.settings.get("dice-so-nice", "disabledForManualRolls");
    console.log(prefix, "disabledForManualRolls setting:", disabledForManualRolls);
  } catch (e) {
    console.log(prefix, "Could not read disabledForManualRolls:", e.message);
  }

  // Check that the dice-link fulfillment method is registered with interactive:true
  const diceLink = CONFIG.Dice.fulfillment?.methods?.["dice-link"];
  console.log(prefix, "dice-link method registered:", !!diceLink, "interactive:", diceLink?.interactive);
}

if (DEBUG_ENABLED) {
  globalThis.debugDSNStatus = debugDSNStatus;
  // Auto-run DSN diagnostic on ready after a short delay so the DLA connection
  // and suppression hook registration have time to complete first.
  Hooks.once("ready", () => setTimeout(debugDSNStatus, 3000));

  // Log every time DSN fires diceSoNiceMessagePreProcess during a real roll.
  // Registered before disableDSN() so we capture willTrigger3DRoll before it is modified.
  Hooks.on("diceSoNiceMessagePreProcess", (msgId, eventObj) => {
    console.log("[Dice Link DSN Diag] diceSoNiceMessagePreProcess fired - msgId:", msgId,
      "willTrigger3DRoll:", eventObj.willTrigger3DRoll);
  });
}
