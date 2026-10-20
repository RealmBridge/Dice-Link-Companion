/**
 * main.mjs - Dice Link Companion's starting point (Foundry VTT v13-v14), by Realm Bridge.
 * Registers the settings, adds the D20 button that opens the DLC panel, starts every other
 * DLC script, connects to the Dice Link App (DLA), and handles what DLA sends back during a
 * roll: the roll button chosen, the dice values, a cancel, a dice tray roll, the player's
 * dice clip, a GM break, and the GM's Approve / Deny from DLA's player list.
 */

import { ASYNC_OPERATION_DELAY_MS, GLOBAL_OVERRIDE_MODES } from "./constants.js";

import {
  registerCoreSettings,
  registerPlayerModeSettings,
  registerPlayerModeSetting,
  getGlobalOverride,
  getPendingRequests,
  getPlayerModes,
  isUserInManualMode
} from "./settings.js";

import {
  getPendingRollRequest,
  getMirroredDialog,
  getDLAPhase,
  setPendingRollRequest,
  setCurrentPanelDialog,
  setDLAPhase,
  clearRollState,
  onMirroredDialogChange
} from "./state-management.js";

import {
  setupChatButtonHandlers,
  approveManualRequest,
  denyManualRequest
} from "./approval.js";

import { setupSocketListeners, emitToPlayers } from "./socket.js";

import { applyManualDice, applyDigitalDice } from "./mode-application.js";

import {
  setupDialogMirroring,
  extractRollDataForDLA,
  windowElement
} from "./dialog-mirroring.js";

import {
  setupChatLog,
  sendInitialChatHistory,
  currentChatVisibility
} from "./chat-log.js";

import {
  debug,
  debugError,
  patchResolverForDiagnostics,
  installErrorDiagnostics
} from "./debug.js";

import { generatePanelContent } from "./ui-templates.js";

import {
  refreshPanel,
  openPanel as openPanelBase,
  attachPanelListeners
} from "./dice-panel.js";

import {
  setupDiceFulfillment,
  restoreDSN,
  executeDiceTrayRollManually,
  submitMirroredDialog
} from "./dice-fulfillment.js";

import {
  connect as connectToDLA,
  onConnectionChange as onDLAConnectionChange,
  sendMessage as sendMessage_Common,
  onDLAMessage
} from "./qwebchannel-client.js";

import {
  showDiceStreamFrame,
  endDiceStream,
  encodeSelfStreamWebP,
  freeDiceStreamSlot
} from "./video-feed.js";

import { handleStartBreak } from "./break-manager.js";
import { normaliseVisibility, clipGoesToOthers } from "./clip-visibility.js";

// ---- Who may see this player's dice clip (clip-visibility.js has the rules) ----
// The roll's own dialog may pick a "Roll Mode" for that one roll; by the time the clip
// starts, Foundry has replaced that dialog with the dice resolver, so it is noted when
// the DLA button is pressed. Rolls without one use the chat visibility setting (the
// one DLA's Public / Whisper / Self only / GM only buttons set).
let rollClipVisibility = null;   // this roll's visibility from its dialog, if it had one
let clipActive = false;          // a clip is being sent right now
let clipVisibility = null;       // locked when each clip starts
let clipToOthers = true;         // whether this clip goes to the other players at all

/** The "Roll Mode" picked in a mirrored roll dialog, or null if it has none. */
function readDialogVisibility(dialogRef) {
  try {
    if (!dialogRef?.html) return null;
    const html = $(windowElement(dialogRef.html));
    const select = html.find('select[name$="rollMode"], select[name$="messageMode"]').first();
    return select.length ? normaliseVisibility(select.val()) : null;
  } catch (e) {
    return null;
  }
}

// Message sending wrappers for QWebChannel
function sendRollRequest(data) {
  sendMessage_Common({
    type: "rollRequest",
    title: data.title,
    subtitle: data.subtitle,
    formula: data.formula,
    dice: data.dice,
    config: { fields: data.configFields || [] },
    buttons: data.buttons
  });
}

function sendPlayerModesUpdate(players, globalOverride) {
  sendMessage_Common({
    type: "playerModesUpdate",
    players: players || [],
    globalOverride: globalOverride || null,
    worldId: game.world.id,
    worldTitle: game.world.title
  });
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
      positioned: true
    }
  };

  get isGM() {
    return this._isGM;
  }

  async _prepareContext(options) {
    return {};
  }

  async _renderHTML(context, options) {
    const wrapper = document.createElement("div");
    wrapper.classList.add("window-content");
    wrapper.innerHTML = generatePanelContent(this._isGM);
    return wrapper;
  }

  _replaceHTML(result, content, options) {
    content.replaceChildren(result);
  }

  _onRender(context, options) {
    attachPanelListeners($(this.element), this._isGM);
        
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
// INITIALIZATION HOOKS
// ============================================================================

/**
 * Initialize the module - register core settings and hooks
 */
Hooks.once("init", async () => {
  installErrorDiagnostics();
  registerCoreSettings();
});

/**
 * Ready hook - set up UI and active features when game is ready
 */
Hooks.once("ready", async () => {
  try {
    // Register per-user settings FIRST - wait for completion
    registerPlayerModeSettings();
    // ...and for any player added later in the session (e.g. joining through a Forge
    // invite), so the GM can approve them without reloading.
    Hooks.on("createUser", (user) => registerPlayerModeSetting(user.id));
    
    // Give settings time to register before hooks fire
    await new Promise(resolve => setTimeout(resolve, ASYNC_OPERATION_DELAY_MS));

    // Setup socket listeners
    setupSocketListeners();
    
    // Setup UI and handlers (dialog mirroring hooks fire after this)
    setupChatButtonHandlers();
    setupDialogMirroring();
    setupChatLog();
    setupDiceFulfillment();
    
    // Register state listener for mirrored dialog changes
    onMirroredDialogChange((dialogData) => {
      if (dialogData && dialogData.data) {
        setPendingRollRequest({});
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
    });
    
    // Setup QWebChannel connection with DLA
    // QWebChannel automatically detects if DLA is running via Qt
    // If not running, features remain disabled
    debug("Initializing QWebChannel connection with DLA (Qt embedded)...");
    // (the "Connected to Dice Link App" notice comes from the connection change below)
    connectToDLA().then(connected => {
      if (connected) {
        debug("QWebChannel: Connected to DLA");
      } else {
        debug("QWebChannel: DLA not detected - module running in standard Foundry mode");
        // Leave Foundry's fulfillment system exactly as it was — nothing to restore
      }
    });
    
    // Handle connection status changes
    onDLAConnectionChange((connected) => {
      debug("Dice Link App connection status:", connected ? "connected" : "disconnected");
      if (!connected) {
        applyDigitalDice();   // also lets Dice So Nice animate again
      }
      if (connected) {
        ui.notifications?.info("Connected to Dice Link App");
        if (isUserInManualMode()) {
          applyManualDice();
        }
        sendInitialChatHistory();
        setTimeout(() => {
          if (typeof sendPlayerModes === "function") {
            debug("Sending player modes after connection established");
            sendPlayerModes();
          }
        }, 100);
      }
    });
    
    // ========================================================================
    // DICE TRAY ROLL: DLA's dice tray initiated a roll
    // Execute the formula in Foundry - this will trigger the normal flow
    // (Foundry shows resolver -> we mirror -> send diceRequest -> etc)
    // ========================================================================
    onDLAMessage("diceTrayRoll", async (formula, flavor) => {
      debug("Dice tray roll from DLA", { formula, flavor });

      try {
        // Execute the roll using Foundry's native system
        // This triggers the normal fulfillment flow - Foundry will show
        // its resolver, our hooks will hide/mirror it, and we'll send
        // a diceRequest to DLA for the physical dice values
        await executeDiceTrayRollManually(formula, flavor);
      } catch (e) {
        debug("Error executing dice tray roll:", e);
        ui.notifications?.error(`Dice roll error: ${e.message}`);
      }
    });

    // ========================================================================
    // CANCEL: Roll cancelled by user in DLA
    // Close hidden Foundry dialog and clear all state
    // ========================================================================
    onDLAMessage("rollCancelled", (rollId) => {
      rollClipVisibility = null;
      debug("Roll cancelled by DLA user", { rollId });
      
      const dialogRef = getMirroredDialog();
      
      // Close the hidden Foundry dialog — bypass RollResolver.close() to avoid auto-fill
      if (dialogRef?.app) {
        try {
          Roll.defaultImplementation.RESOLVERS.delete(dialogRef.app.roll);
          foundry.applications.api.ApplicationV2.prototype.close.call(dialogRef.app, { force: true });
        } catch(e) {
          debug("Error closing dialog app:", e);
        }
      }
      
      // Clear all pending state
      clearRollState();
      refreshPanel();
    });

    // ========================================================================
    // PHASE A: Button Selection from DLA
    // User clicked a button (Advantage/Normal/Disadvantage) in DLA.
    // We apply config changes and click the hidden Foundry dialog button.
    // This triggers Foundry to process and show its dice resolver.
    // ========================================================================
    onDLAMessage("buttonSelect", (rollId, buttonClicked, configChanges) => {
      debug("Phase A: Button selection from DLA", { rollId, buttonClicked, configChanges });
      
      // Set phase to buttonClicked - prevents sending duplicate rollRequests
      setDLAPhase("buttonClicked");
      
      // Apply config changes to the hidden dialog if any
      const dialogRef = getMirroredDialog();
      if (dialogRef && configChanges && Object.keys(configChanges).length > 0) {
        const originalHtml = $(windowElement(dialogRef.html));
        for (const [name, value] of Object.entries(configChanges)) {
          const input = originalHtml.find(`[name="${name}"]`);
          if (input.length > 0) {
            input.val(value);
            input[0].dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
      
      // Note this roll's visibility for its dice clip (the dialog is gone by then)
      rollClipVisibility = readDialogVisibility(dialogRef);
      clipActive = false;

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
    onDLAMessage("diceResult", (rollId, results) => {
      debug("Phase B: Dice results from DLA", JSON.stringify({ rollId, resultCount: results.length, results }));
      rollClipVisibility = null;

      // Use the stored resolver reference rather than a DOM search, which could find stale resolvers
      const resolver = getMirroredDialog()?.element;
      patchResolverForDiagnostics(getMirroredDialog()?.app);

      if (!resolver) {
        debug("No roll resolver found in DOM for dice injection");
        clearRollState();
        refreshPanel();
        return;
      }

      debug("Found resolver element", JSON.stringify({
        tagName: resolver.tagName,
        className: resolver.className,
        id: resolver.id,
        display: getComputedStyle(resolver).display
      }));

      // Find all dice input fields in the resolver
      const allInputs = resolver.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
      debug("Found inputs in resolver", JSON.stringify({
        count: allInputs.length,
        inputs: Array.from(allInputs).map(i => ({
          name: i.name,
          value: i.value,
          placeholder: i.placeholder,
          type: i.type,
          max: i.max
        }))
      }));

      // Inject dice values into the resolver inputs
      let resultIndex = 0;
      for (const input of allInputs) {
        // Skip inputs that already have values or are hidden
        if (input.value || input.type === 'hidden' || getComputedStyle(input).display === 'none') {
          debug("Skipping input", JSON.stringify({ name: input.name, reason: input.value ? 'has-value' : input.type === 'hidden' ? 'hidden-type' : 'display-none' }));
          continue;
        }

        if (resultIndex < results.length) {
          const result = results[resultIndex];
          const value = result.value;
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          debug("Injected dice value", JSON.stringify({ value, inputName: input.name, inputIndex: resultIndex }));
          resultIndex++;
        }
      }

      debug("Injection complete", JSON.stringify({ injectedCount: resultIndex, totalResults: results.length }));

      setTimeout(() => {
        // Log every button in the resolver so we know exactly what's available
        const allButtons = Array.from(resolver.querySelectorAll('button'));
        debug("Resolver all buttons", JSON.stringify(allButtons.map(b => ({
          text: b.textContent?.trim(),
          type: b.type,
          dataAction: b.dataset?.action,
          className: b.className
        }))));

        // Look for submit button in resolver
        const submitBtn = resolver.querySelector(
          'button[type="submit"], ' +
          'button[data-action="submit"], ' +
          'button[data-action="fulfill"], ' +
          '.dialog-button.submit, ' +
          'button.submit'
        );

        // Also check if resolver itself is a form (v14 pattern)
        const resolverIsForm = resolver.tagName === 'FORM';
        const innerForm = resolverIsForm ? null : resolver.querySelector('form');

        debug("Resolver submit search", JSON.stringify({
          submitBtnFound: !!submitBtn,
          submitBtnText: submitBtn?.textContent?.trim(),
          submitBtnType: submitBtn?.type,
          submitBtnAction: submitBtn?.dataset?.action,
          resolverIsForm,
          innerFormFound: !!innerForm
        }));

        if (submitBtn) {
          debug("Clicking resolver submit button", submitBtn.textContent?.trim());
          submitBtn.click();
        } else {
          const form = innerForm || (resolverIsForm ? resolver : null);
          if (form) {
            debug("Submitting resolver form directly");
            form.requestSubmit();
          } else {
            const anyBtn = Array.from(resolver.querySelectorAll('button')).find(btn =>
              btn.textContent?.toLowerCase().includes('submit') ||
              btn.textContent?.toLowerCase().includes('ok') ||
              btn.textContent?.toLowerCase().includes('roll')
            );
            if (anyBtn) {
              debug("Clicking fallback button", anyBtn.textContent?.trim());
              anyBtn.click();
            } else {
              debug("No submit mechanism found in resolver — roll will not complete");
            }
          }
        }


        clearRollState();
        refreshPanel();
      }, 100);
    });

    // GM break started from DLA's timer (break-manager.js does the work)
    onDLAMessage("startBreak", (data) => {
      debug("startBreak received from DLA", data);
      handleStartBreak(data);
    });

    // Guards a race from the off-thread (async) broadcast encode: the last frame or
    // two can still be encoding when the stream ends, so without this flag they would
    // be emitted AFTER cameraStreamEnd and re-show the tray on other players with no
    // further stop to clear it. Setting it on stream-end makes any in-flight straggler
    // frame drop its broadcast, so cameraStreamEnd is always the last message sent.
    let localBroadcastEnded = false;
    // Display frame locally and broadcast to all other players via game.socket.
    // Do not simplify — the socket broadcast is what makes video visible to players, not just GM.
    onDLAMessage("cameraFrame", (frameB64) => {
      const uid = game.user.id;
      if (!clipActive) {
        // First frame of a new clip: lock who may see it for the whole clip.
        clipActive = true;
        clipVisibility = rollClipVisibility || currentChatVisibility();
        clipToOthers = clipGoesToOthers(clipVisibility, game.user.isGM);
        debug("Dice clip visibility", { visibility: clipVisibility || "public", rollerIsGM: game.user.isGM, sentToOthers: clipToOthers });
      }
      localBroadcastEnded = false;
      // Draw our own clip locally in our spot, then encode for broadcast OFF the main
      // thread (async toBlob) so the roll result isn't held up behind the WebP encode.
      showDiceStreamFrame(frameB64, uid);
      if (!clipToOthers) return;   // Self only, or a DM's private roll: nobody else sees it
      encodeSelfStreamWebP((networkFrame) => {
        if (networkFrame && !localBroadcastEnded) {
          emitToPlayers({
            action: "cameraFrame", frameB64: networkFrame, userId: uid,
            visibility: clipVisibility, rollerIsGM: game.user.isGM
          });
        }
      });
    });
    onDLAMessage("cameraStreamEnd", () => {
      const uid = game.user.id;
      localBroadcastEnded = true;
      const wasSent = clipToOthers;
      clipActive = false;
      endDiceStream(uid);
      if (wasSent) emitToPlayers({ action: "cameraStreamEnd", userId: uid });
    });

    // Free a player's clip spot when they disconnect, so a reconnect fills the lowest gap.
    Hooks.on("userConnected", (user, connected) => {
      if (!connected) freeDiceStreamSlot(user.id);
    });

    restoreDSN();   // Dice So Nice animates until manual mode switches it off
    if (getGlobalOverride() === GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL) {
      applyDigitalDice();
    }
    // ========================================================================
    // PLAYER MODES: Send initial state to DLA and handle mode changes
    // All users (GM and players) receive playerModesUpdate so everyone can
    // see the Player Modes section. Only GMs see approve/deny buttons in DLA:
    // a player marked isPending is a manual dice request waiting for the GM.
    // ========================================================================

    // Function to gather and send player modes to DLA
    const sendPlayerModes = () => {
      const globalOverride = getGlobalOverride();
      const pending = getPendingRequests();
      // Each player's mode, plus their character's name and portrait for DLA
      const players = getPlayerModes(globalOverride, pending).map(player => {
        const actor = game.users.get(player.id)?.character;
        let portraitUrl = null;
        if (actor?.img) {
          const img = actor.img;
          portraitUrl = (img.startsWith('http://') || img.startsWith('https://'))
            ? img
            : window.location.origin + foundry.utils.getRoute(img);
        }
        return { ...player, characterName: actor?.name || null, portraitUrl };
      });
      debug("Sending player modes to DLA", {
        playerCount: players.length,
        globalOverride,
        pendingCount: pending.length
      });

      sendPlayerModesUpdate(players, globalOverride);
    };

    // Re-send player modes whenever they change (via settings socket)
    Hooks.on("diceLink.playerModeChanged", () => {
      debug("Player mode changed - resending modes to DLA");
      sendPlayerModes();
    });

    // The GM pressed Approve / Deny in DLA's player list: same as the chat card buttons
    if (game.user?.isGM) {
      onDLAMessage("playerModeAction", ({ action, playerId }) => {
        debug("Player mode action from DLA", { action, playerId });
        if (!playerId) return;
        if (action === "approve") approveManualRequest(playerId);
        else if (action === "deny") denyManualRequest(playerId);
      });
    }
  } catch (error) {
    debugError("ERROR in ready hook:", error);
    debugError("Stack trace:", error.stack);
  }
});
