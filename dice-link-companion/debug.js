/**
 * Debug Module - Centralized debugging for Dice Link Companion
 *
 * Toggle DEBUG in constants.js to enable/disable all logging.
 */

import { DEBUG } from "./constants.js";
const DEBUG_ENABLED = DEBUG;

/**
 * Log a debug message with [Dice Link Debug] prefix
 * @param {...any} args - Arguments to log
 */
export function debug(...args) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Debug]", ...args);
  }
}

/**
 * Log a debug error
 * @param {...any} args - Arguments to log
 */
export function debugError(...args) {
  if (DEBUG_ENABLED) {
    console.error("[Dice Link Debug]", ...args);
  }
}

/**
 * Log state of a variable with label
 * @param {string} label - Description of what's being logged
 * @param {any} value - Value to log
 */
export function debugState(label, value) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Debug]", label + ":", value);
  }
}

/**
 * Log resolver state changes
 * @param {string} event - Event type (e.g., "created", "fulfillable", "submitted", "cancelled")
 * @param {any} data - Associated data
 */
export function debugResolverState(event, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Resolver State]", event, data);
  }
}

/**
 * Log fulfillment-specific debug information
 * @param {...any} args - Arguments to log
 */
export function debugFulfillment(...args) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Fulfillment]", ...args);
  }
}

/**
 * Log HTML cloning operations for mirrored dialogs
 * @param {string} stage - Stage of cloning operation
 * @param {any} data - Associated data (element info, HTML length, etc.)
 */
export function debugCloning(stage, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Cloning]", stage, data);
  }
}

/**
 * Log button/footer detection attempts and results
 * @param {string} stage - Stage of button detection (e.g., "searching", "found", "not found")
 * @param {any} data - Associated data (selector used, element found, HTML preview, etc.)
 */
export function debugButtonDetection(stage, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Button Detection]", stage, data);
  }
}

/**
 * Log panel content injection and DOM state
 * @param {string} stage - Stage of injection (e.g., "before injection", "after injection", "verification")
 * @param {any} data - Associated data (HTML length, element counts, visibility states, etc.)
 */
export function debugPanelInjection(stage, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Panel Injection]", stage, data);
  }
}

/**
 * Log CSS computed styles for elements to debug visibility issues
 * @param {string} selector - CSS selector or element description
 * @param {HTMLElement} element - Element to inspect
 */
export function debugComputedStyles(selector, element) {
  if (DEBUG_ENABLED && element) {
    const styles = window.getComputedStyle(element);
    console.log(`[Dice Link CSS Styles] ${selector}`, {
      display: styles.display,
      visibility: styles.visibility,
      opacity: styles.opacity,
      height: styles.height,
      width: styles.width,
      maxHeight: styles.maxHeight,
      overflow: styles.overflow,
      position: styles.position,
      zIndex: styles.zIndex,
      pointerEvents: styles.pointerEvents
    });
  }
}

/**
 * Log QWebChannel client events for DLA embedded browser communication
 * @param {string} event - Event type (e.g., "connecting", "connected", "signal", "error")
 * @param {any} data - Associated data
 */
export function debugQWebChannel(event, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link QWebChannel]", event, data);
  }
}

/**
 * Log camera stream events (stream start/end, frame decode errors, FPS)
 * @param {string} event - Event type (e.g., "stream-start", "stream-end", "decode-error")
 * @param {any} data - Associated data
 */
export function debugCamera(event, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Camera]", event, data);
  }
}

/**
 * Log chat log events — stylesheet collection, CSS rewriting, message collection, hook firing
 * @param {string} event - Short label for what is happening
 * @param {any} data - Associated data (counts, URLs, flags, etc.)
 */
export function debugChatLog(event, data) {
  if (DEBUG_ENABLED) {
    if (data !== undefined) {
      console.log("[Dice Link Chat Log]", event, data);
    } else {
      console.log("[Dice Link Chat Log]", event);
    }
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
 *    which calls console.error(message, err) — the stack trace is on the Error object
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
 * Log element width measurements to debug stretching
 * @param {string} stage - Stage of measurement (e.g., "content area", "panel", "cloned dialog", "nav")
 * @param {HTMLElement} element - Element to measure
 * @param {string} label - Optional label for the element
 */
export function debugElementDimensions(stage, element, label = "") {
  if (DEBUG_ENABLED && element) {
    const rect = element.getBoundingClientRect();
    const computed = window.getComputedStyle(element);
    const inlineStyle = element.getAttribute("style") || "(none)";

    console.log(`[Dice Link Dimensions] ${stage} ${label}`, {
      offsetWidth: element.offsetWidth,
      offsetHeight: element.offsetHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      boundingClientRect: {
        width: rect.width,
        height: rect.height
      },
      computedStyle: {
        width: computed.width,
        height: computed.height,
        maxWidth: computed.maxWidth,
        overflow: computed.overflow
      },
      inlineStyle: inlineStyle,
      className: element.className,
      tagName: element.tagName
    });
  }
}

/**
 * Check whether Dice So Nice suppression is currently working on this client.
 * Reports: whether DSN is active, how many hooks are registered for the pre-process
 * event, and whether firing a test event actually suppresses willTrigger3DRoll.
 *
 * Call from the Foundry CMD prompt: debugDSNStatus()
 */
export function debugDSNStatus() {
  if (!DEBUG_ENABLED) return;
  const prefix = "[Dice Link DSN Diag]";

  const dsnActive = !!game.modules.get("dice-so-nice")?.active;
  console.log(prefix, "DSN active:", dsnActive);
  if (!dsnActive) {
    console.log(prefix, "DSN is not active — suppression not applicable");
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

/**
 * Diagnose why handleStartBreak may not be working.
 * Logs all state relevant to the break pipeline before handleStartBreak is entered.
 */
export function diagnoseBreakStart() {
  const prefix = "[Dice Link Break Diag]";
  console.log(prefix, "game.user exists:", !!game.user);
  console.log(prefix, "game.user.id:", game.user?.id);
  console.log(prefix, "game.user.role:", game.user?.role);
  console.log(prefix, "game.user.isGM:", game.user?.isGM);
  console.log(prefix, "CONST.USER_ROLES.GAMEMASTER:", CONST?.USER_ROLES?.GAMEMASTER);
  console.log(prefix, "game.paused:", game.paused);
  console.log(prefix, "game.socket exists:", !!game.socket);
  console.log(prefix, "game.users count:", game.users?.size);
  const existingOverlay = document.getElementById('dlc-break-overlay');
  console.log(prefix, "existing #dlc-break-overlay in DOM:", !!existingOverlay);
}

if (DEBUG_ENABLED) {
  globalThis.debugDSNStatus = debugDSNStatus;
  // Auto-run DSN diagnostic on ready after a short delay so the DLA connection
  // and suppression hook registration have time to complete first.
  Hooks.once("ready", () => setTimeout(debugDSNStatus, 3000));

  // Log every time DSN fires diceSoNiceMessagePreProcess during a real roll.
  // Registered before disableDSN() so we capture willTrigger3DRoll before it is modified.
  Hooks.on("diceSoNiceMessagePreProcess", (msgId, eventObj) => {
    console.log("[Dice Link DSN Diag] diceSoNiceMessagePreProcess fired — msgId:", msgId,
      "willTrigger3DRoll:", eventObj.willTrigger3DRoll);
  });
}
