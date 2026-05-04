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
 * Log resolver cancellation
 * @param {string} method - Method used to cancel (e.g., "resolveResult", "reject", etc.)
 * @param {any} data - Associated data or result
 */
export function debugResolverCancel(method, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Resolver Cancel]", `Used ${method}:`, data);
  }
}

/**
 * Log resolver closure sequence
 * @param {string} stage - Stage of closure (e.g., "resolveResult called", "closing app")
 */
export function debugResolverClosure(stage) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Resolver Closure]", stage);
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
 * Log template/HTML generation for pending rolls
 * @param {string} stage - Stage of generation (e.g., "generatePendingRollHTML called", "using clonedHTML", "fallback")
 * @param {any} data - Associated data (roll object properties, HTML preview, etc.)
 */
export function debugTemplateGeneration(stage, data) {
  if (DEBUG_ENABLED) {
    console.log("[Dice Link Template]", stage, data);
  }
}

/**
 * Log section generation and HTML wrapping
 * @param {string} section - Section name (e.g., "Roll Request Section")
 * @param {string} stage - Stage (e.g., "generating", "wrapping", "complete")
 * @param {any} data - Associated data (content length, HTML preview, structure, etc.)
 */
export function debugSectionGeneration(section, stage, data) {
  if (DEBUG_ENABLED) {
    console.log(`[Dice Link ${section}]`, stage, data);
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
 * Log cloned button click events
 * @param {string} action - Button action (e.g., "advantage", "normal", "disadvantage")
 * @param {any} data - Associated data (button element info, pending roll state, etc.)
 */
export function debugClonedButtonClick(action, data) {
  if (DEBUG_ENABLED) {
    console.log(`[Dice Link Cloned Button]`, action, data);
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
