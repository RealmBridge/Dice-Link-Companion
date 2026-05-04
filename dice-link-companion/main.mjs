/**
 * Dice Link Companion - Foundry VTT v13
 * A player-GM dice mode management system with dialog mirroring.
 * Branded for Realm Bridge - https://realmbridge.co.uk
 */

import {
  MODULE_ID,
  MODULE_VERSION,
  REALM_BRIDGE_URL,
  LOGO_URL,
  LOGO_SQUARE_URL,
  ASYNC_OPERATION_DELAY_MS
} from "./constants.js";

import { 
  registerCoreSettings, 
  registerPlayerModeSettings,
  getSetting,
  setSetting,
  getPlayerMode,
  setPlayerMode,
  getGlobalOverride,
  setGlobalOverride,
  getPendingRequests,
  setPendingRequests,
  isUserInManualMode,
  getCollapsedSections,
  setCollapsedSections
} from "./settings.js";

import { 
  getPendingRollRequest,
  getHasRequestedThisSession,
  getCurrentPanelDialog,
  getPendingDiceEntry,
  getDiceEntryCancelled,
  getMirroredDialog,
  getDLAPhase,
  setPendingRollRequest,
  setHasRequestedThisSession,
  setCurrentPanelDialog,
  setPendingDiceEntry,
  setDiceEntryCancelled,
  setMirroredDialog,
  setDLAPhase,
  clearAllState,
  resetUIState,
  hasPendingOperations,
  onMirroredDialogChange
} from "./state-management.js";

import { 
  createApprovalChatMessage,
  setupChatButtonHandlers
} from "./approval.js";

import {
  setupSocketListeners,
  playerRequestManual,
  playerSwitchToDigital
} from "./socket.js";

import {
  applyManualDice,
  applyDigitalDice
} from "./mode-application.js";

import {
  setupDialogMirroring,
  handleMirroredDialogChange
} from "./dialog-mirroring.js";

import {
  debug,
  debugState,
  debugError
} from "./debug.js";

import {
  generateDiceTrayHTML,
  generateRollRequestSection,
  generatePendingRollHTML,
  generateGMPanelContent,
  generatePlayerPanelContent,
  generateMirroredDialogHTML
} from "./ui-templates.js";

import {
  refreshPanel,
  openPanel as openPanelBase,
  attachGMPanelListeners,
  attachPlayerPanelListeners
} from "./dice-panel.js";

import {
  setupDiceFulfillment,
  setupDSNSuppression,
  ensureDSNEnabled,
  restoreDSN,
  executeDiceTrayRollManually,
  submitMirroredDialog,
  applyDiceLinkFulfillment,
  removeDiceLinkFulfillment
} from "./dice-fulfillment.js";

import {
  getManualRollsPermissions,
  setManualRollsPermission
} from "./settings-helpers.js";

import {
  connect as connectToDLA,
  disconnect as disconnectFromDLA,
  getConnectionStatus as getDLAConnectionStatus,
  onConnectionChange as onDLAConnectionChange,
  sendMessage as sendMessage_Common,
  setButtonSelectCallback,
  setDiceResultCallback,
  setCancelCallback,
  setDiceTrayRollCallback,
  setPlayerModeActionCallback,
  setCameraFrameCallback,
  setCameraStreamEndCallback
} from "./qwebchannel-client.js";

import { showDiceStreamFrame, endDiceStream } from "./video-feed.js";

import {
  extractRollDataForDLA,
  clearPendingDiceRequest
} from "./websocket-client.js";

// Message sending wrappers for QWebChannel
function sendRollRequest(data) {
  sendMessage_Common({ type: "rollRequest", ...data });
}

function sendDiceRequest(data) {
  sendMessage_Common({ type: "diceRequest", ...data });
}

function sendPlayerModesUpdate(data) {
  sendMessage_Common({ type: "playerModesUpdate", ...data });
}

// ============================================================================
// CUSTOM APPLICATION CLASS (ApplicationV2 for Foundry V13+)
// ============================================================================

const { ApplicationV2 } = foundry.applications.api;

class DiceLinkCompanionApp extends ApplicationV2 {
  constructor(isGM, options = {}) {
    super(options);
    this._isGM = isGM;
  }

  static DEFAULT_OPTIONS = {
    id: "dice-link-companion-panel",
    classes: ["dlc-dialog"],
    position: {
      width: 480,
      height: "auto"
    },
    window: {
      title: "Dice Link Companion",
      resizable: true,
      minimizable: true,
      positioned: true,
      contentClasses: ["dlc-window-content-constrained"]
    }
  };

  get title() {
    return "Dice Link Companion";
  }

  get isGM() {
    return this._isGM;
  }

  async _prepareContext(options) {
    return {};
  }

  async _renderHTML(context, options) {
    const content = this._isGM ? generateGMPanelContent() : generatePlayerPanelContent();
    const wrapper = document.createElement("div");
    wrapper.classList.add("window-content");
    wrapper.innerHTML = content;
    return wrapper;
  }

  _replaceHTML(result, content, options) {
    content.replaceChildren(result);
  }

  _onRender(context, options) {
    const html = this.element;
    const $html = $(html);
    
    if (this._isGM) {
      attachGMPanelListeners($html);
    } else {
      attachPlayerPanelListeners($html);
    }
    
    // Defer positioning until element is fully rendered and attached to DOM
    // Use requestAnimationFrame to ensure browser has painted the element
    requestAnimationFrame(() => {
      if (this.element?.offsetParent) {  // Check element is in DOM and visible
        this.setPosition({ height: "auto", width: "auto" });
      }
    });
  }

  async close(options = {}) {
    setCurrentPanelDialog(null);
    return super.close(options);
  }
}

// UI Template functions now imported from ui-templates.js
// Panel functions now imported from dice-panel.js

// Wrapper for openPanel that provides the DiceLinkCompanionApp class
function openPanel() {
  openPanelBase(DiceLinkCompanionApp);
}

// ============================================================================
// SCENE CONTROLS - D20 BUTTON
// ============================================================================

Hooks.on("getSceneControlButtons", (controls) => {
  if (!controls.tokens?.tools) return;

  controls.tokens.tools.diceLinkCompanion = {
    name: "diceLinkCompanion",
    title: "Dice Link Companion",
    icon: "fa-solid fa-dice-d20",
    button: true,
    visible: true,
    order: 100,
    onChange: () => {
      openPanel();
    }
  };
});

// ============================================================================
// INITIALIZATION
// ============================================================================

// ============================================================================
// CUSTOM RESOLVER CLASS (for dialog mirroring approach)
// ============================================================================
// MIDI-QOL NOTE
// midi-qol interception removed - dice fulfillment system handles all rolls automatically
// Roll interception also removed - dialog mirroring handles all roll dialogs automatically
// ============================================================================
// INITIALIZATION HOOKS
// ============================================================================

/**
 * Initialize the module - register core settings and hooks
 */
Hooks.once("init", async () => {
  // Register core settings (world-scoped, available immediately)
  registerCoreSettings();
});

/**
 * Ready hook - set up UI and active features when game is ready
 */
Hooks.once("ready", async () => {
  try {
    // Register per-user settings FIRST - wait for completion
    registerPlayerModeSettings();
    
    // Give settings time to register before hooks fire
    await new Promise(resolve => setTimeout(resolve, ASYNC_OPERATION_DELAY_MS));
    
    // Collapsed sections are now managed by settings.js - no need to load here
    
    // Setup socket listeners
    setupSocketListeners();
    
    // Setup UI and handlers (dialog mirroring hooks fire after this)
    setupChatButtonHandlers();
    setupDialogMirroring();
    setupDiceFulfillment();
    setupDSNSuppression();
    
    // Register state listener for mirrored dialog changes
    onMirroredDialogChange((dialogData) => {
      if (dialogData && dialogData.data) {
        handleMirroredDialogChange(dialogData, submitMirroredDialog, refreshPanel, openPanel);
        
        // Also send to Dice Link App if connected
        if (getDLAConnectionStatus()) {
          // Check if we're already in a DLA phase - don't send duplicate rollRequests
          const currentPhase = getDLAPhase();
          if (currentPhase && currentPhase !== null) {
            debug("Skipping rollRequest - already in DLA phase:", currentPhase);
            return;
          }
          
          const rollData = extractRollDataForDLA(dialogData);
          debug("Sending roll request to Dice Link App", rollData);
          sendRollRequest(rollData);
          setDLAPhase("rollSent");
        }
      }
    });
    
    // Setup QWebChannel connection with DLA
    // QWebChannel automatically detects if DLA is running via Qt
    // If not running, features remain disabled
    debug("Initializing QWebChannel connection with DLA (Qt embedded)...");
    connectToDLA().then(connected => {
      if (connected) {
        debug("QWebChannel: Connected to DLA");
        ui.notifications?.info("Connected to Dice Link App");
      } else {
        debug("QWebChannel: DLA not detected - module running in standard Foundry mode");
      }
    });
    
    // Handle connection status changes
    onDLAConnectionChange((connected) => {
      debug("Dice Link App connection status:", connected ? "connected" : "disconnected");
      if (!connected) {
        restoreDSN();
      }
      if (connected) {
        ui.notifications?.info("Connected to Dice Link App");
        // Send player modes data to DLA now that we're connected
        // (sendPlayerModes is defined later in this hook but hoisted)
        setTimeout(() => {
          if (typeof sendPlayerModes === "function") {
            debug("Sending player modes after connection established");
            sendPlayerModes();
          }
        }, 100);
      }
    });
    
    // ========================================================================
    // PHASE A: Button Selection from DLA
    // User clicked a button (Advantage/Normal/Disadvantage) in DLA.
    // We apply config changes and click the hidden Foundry dialog button.
    // This triggers Foundry to process and show its dice resolver.
    // ========================================================================
    // ========================================================================
    // DICE TRAY ROLL: DLA's dice tray initiated a roll
    // Execute the formula in Foundry - this will trigger the normal flow
    // (Foundry shows resolver -> we mirror -> send diceRequest -> etc)
    // ========================================================================
    setDiceTrayRollCallback(async (formula, flavor) => {
      debug("Dice tray roll from DLA", { formula, flavor });

      try {
        // Execute the roll using Foundry's native system
        // This triggers the normal fulfillment flow - Foundry will show
        // its resolver, our hooks will hide/mirror it, and we'll send
        // a diceRequest to DLA for the physical dice values
        await executeDiceTrayRollManually(formula, flavor, null);
      } catch (e) {
        debug("Error executing dice tray roll:", e);
        ui.notifications?.error(`Dice roll error: ${e.message}`);
      }
    });

    // Camera stream — GM client receives frames from DLA, displays locally
    // and broadcasts to all other players via socket
    setCameraFrameCallback((frameB64) => {
      showDiceStreamFrame(frameB64);
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "cameraFrame",
        frameB64: frameB64
      });
    });

    setCameraStreamEndCallback(() => {
      endDiceStream();
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "cameraStreamEnd"
      });
    });

    // ========================================================================
    // CANCEL: Roll cancelled by user in DLA
    // Close hidden Foundry dialog and clear all state
    // ========================================================================
    setCancelCallback((rollId) => {
      debug("Roll cancelled by DLA user", { rollId });
      
      const dialogRef = getMirroredDialog();
      
      // Close the hidden Foundry dialog
      if (dialogRef?.app) {
        try {
          dialogRef.app.close({ force: true });
        } catch(e) {
          debug("Error closing dialog app:", e);
        }
      }
      
      // Also try closing via the element directly
      if (dialogRef?.html) {
        const el = dialogRef.html instanceof jQuery ? dialogRef.html[0] : dialogRef.html;
        const closeBtn = el?.querySelector?.('.window-header .close, button[data-action="close"]');
        if (closeBtn) closeBtn.click();
      }
      
      // Clear all pending state
      setMirroredDialog(null);
      setPendingRollRequest(null);
      clearPendingDiceRequest();
      setDiceEntryCancelled(true);
      setDLAPhase(null);
      refreshPanel();
    });

    setButtonSelectCallback((rollId, buttonClicked, configChanges) => {
      debug("Phase A: Button selection from DLA", { rollId, buttonClicked, configChanges });
      
      // Set phase to buttonClicked - prevents sending duplicate rollRequests
      setDLAPhase("buttonClicked");
      
      // Apply config changes to the hidden dialog if any
      const dialogRef = getMirroredDialog();
      if (dialogRef && configChanges && Object.keys(configChanges).length > 0) {
        const originalHtml = dialogRef.html instanceof jQuery ? dialogRef.html : $(dialogRef.html);
        for (const [name, value] of Object.entries(configChanges)) {
          const input = originalHtml.find(`[name="${name}"]`);
          if (input.length > 0) {
            input.val(value);
            input[0].dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
      
      // Store the rollId for Phase B correlation
      const pendingRoll = getPendingRollRequest();
      if (pendingRoll) {
        pendingRoll.dlaRollId = rollId;
        pendingRoll.buttonClicked = buttonClicked;
      }
      
      // Click the button on the hidden Foundry dialog
      // This triggers Foundry to process the roll and show dice resolver
      if (buttonClicked && dialogRef?.data?.buttons) {
        debug("Clicking hidden dialog button:", buttonClicked);
        submitMirroredDialog({ buttonLabel: buttonClicked });
      }
    });
    
    // ========================================================================
    // PHASE B: Dice Results from DLA
    // User rolled dice and submitted results in DLA.
    // We inject these values into Foundry's dice resolver.
    // ========================================================================
    setDiceResultCallback((rollId, results) => {
      debug("Phase B: Dice results from DLA", { rollId, results });
      
      // Find the Foundry roll resolver in the DOM
      // The resolver is a SEPARATE dialog from the roll configuration we mirrored
      // It appears after clicking Advantage/Normal/Disadvantage button
      const resolver = document.querySelector('.roll-resolver, [data-application-part="resolver"], dialog.application');
      
      if (!resolver) {
        debug("No roll resolver found in DOM for dice injection");
        // Clear state anyway
        clearPendingDiceRequest();
        setMirroredDialog(null);
        setPendingRollRequest(null);
        setDLAPhase(null);
        refreshPanel();
        return;
      }
      
      debug("Found resolver element", { 
        tagName: resolver.tagName, 
        className: resolver.className,
        innerHTML_length: resolver.innerHTML?.length 
      });
      
      // Find all dice input fields in the resolver
      // Foundry's RollResolver uses various input patterns
      const allInputs = resolver.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
      debug("Found inputs in resolver", { 
        count: allInputs.length, 
        inputs: Array.from(allInputs).map(i => ({ name: i.name, value: i.value, placeholder: i.placeholder }))
      });
      
      // Inject dice values into the resolver inputs
      let resultIndex = 0;
      for (const input of allInputs) {
        // Skip inputs that already have values or are hidden
        if (input.value || input.type === 'hidden' || getComputedStyle(input).display === 'none') {
          continue;
        }
        
        // Get next result value
        if (resultIndex < results.length) {
          const result = results[resultIndex];
          const value = result.value;
          
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          debug("Injected dice value:", { value, inputName: input.name, inputIndex: resultIndex });
          resultIndex++;
        }
      }
      
      debug("Injection complete", { injectedCount: resultIndex, totalResults: results.length });
      
      // After injecting all values, submit the resolver
      // Small delay to let the UI update
      setTimeout(() => {
        // Look for submit button in resolver
        const submitBtn = resolver.querySelector(
          'button[type="submit"], ' +
          'button[data-action="submit"], ' +
          'button[data-action="fulfill"], ' +
          '.dialog-button.submit, ' +
          'button.submit'
        );
        
        if (submitBtn) {
          debug("Clicking resolver submit button", { buttonText: submitBtn.textContent });
          submitBtn.click();
        } else {
          // Try form submit
          const form = resolver.querySelector('form');
          if (form) {
            debug("Submitting resolver form directly");
            form.requestSubmit();
          } else {
            // Last resort - find any button that looks like submit
            const anyBtn = Array.from(resolver.querySelectorAll('button')).find(btn => 
              btn.textContent?.toLowerCase().includes('submit') || 
              btn.textContent?.toLowerCase().includes('ok') ||
              btn.textContent?.toLowerCase().includes('roll')
            );
            if (anyBtn) {
              debug("Clicking fallback button", { buttonText: anyBtn.textContent });
              anyBtn.click();
            }
          }
        }
        
        // Clear state
        clearPendingDiceRequest();
        setMirroredDialog(null);
        setPendingRollRequest(null);
        setDLAPhase(null);
        refreshPanel();
      }, 100);
    });
    
    ensureDSNEnabled();
    const globalOverride = getGlobalOverride();
    if (globalOverride === "forceAllManual") {
      applyManualDice();
    } else if (globalOverride === "forceAllDigital") {
      applyDigitalDice();
    } else {
      const myMode = getPlayerMode();
      if (myMode === "manual") {
        applyManualDice();
      } else {
        applyDigitalDice();
      }
    }

    // ========================================================================
    // PLAYER MODES: Send initial state to DLA and handle mode changes
    // All users (GM and players) receive playerModesUpdate so everyone can
    // see the Player Modes section. Only GMs see approve/deny buttons in DLA.
    // ========================================================================
    
    // Function to gather and send player modes to DLA
    const sendPlayerModes = () => {
      const players = [];
      for (const user of game.users) {
        // Include everyone (including GM) so all users can see each other's modes
        // Add isSelf flag so DLA knows which player is the logged-in user
        players.push({
          id: user.id,
          name: user.name,
          mode: getPlayerMode(user.id),
          isGM: user.isGM,
          isSelf: user.id === game.user?.id
        });
      }
      const globalOverride = getGlobalOverride();
      // Only include pending requests - DLA will only show these to GMs
      const pending = getPendingRequests();
      
      debug("Sending player modes to DLA", { 
        playerCount: players.length, 
        globalOverride,
        pendingCount: pending?.length || 0 
      });
      
      sendPlayerModesUpdate(players, globalOverride, pending);
    };

    // Re-send player modes whenever they change (via settings socket)
    Hooks.on("diceLink.playerModeChanged", () => {
      debug("Player mode changed - resending modes to DLA");
      sendPlayerModes();
    });

    // Handle player mode actions from DLA (GM only actions - approve/deny)
    if (game.user?.isGM) {
      setPlayerModeActionCallback(async (action, userId, newMode, globalOverride) => {
        debug("Player mode action from DLA", { action, userId, newMode, globalOverride });
        
        if (action === "approve" && userId) {
          // GM approved manual dice request - set to manual and remove from pending
          setPlayerMode(userId, "manual");
          const pending = getPendingRequests().filter(req => req.playerId !== userId);
          await setPendingRequests(pending);
        } else if (action === "deny" && userId) {
          // GM denied manual dice request - just remove from pending (keep digital)
          const pending = getPendingRequests().filter(req => req.playerId !== userId);
          await setPendingRequests(pending);
        }
        
        // Trigger update to refresh DLA
        Hooks.call("diceLink.playerModeChanged");
      });
    }
  } catch (error) {
    debugError("ERROR in ready hook:", error);
    debugError("Stack trace:", error.stack);
  }
});

// ============================================================================
// PUBLIC API
// ============================================================================

globalThis.DiceLinkCompanion = {
  openPanel,
  applyManual: applyManualDice,
  applyDigital: applyDigitalDice,
  requestManual: playerRequestManual,
  switchToDigital: playerSwitchToDigital,
  // Dice Link App connection
  connectToDLA,
  disconnectFromDLA,
  getDLAConnectionStatus
};
