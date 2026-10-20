/**
 * main.mjs - Dice Link Companion's starting point (Foundry VTT v13-v14), by Realm Bridge.
 * Registers the settings, adds the D20 button that opens the DLC panel, starts every other
 * DLC script, and connects to the Dice Link App (DLA). When the connection comes or goes
 * it tells the scripts concerned: this user's dice, the chat copy and the player list.
 * Everything else (including what each script does with DLA's messages) is in its own script.
 */

import { ASYNC_OPERATION_DELAY_MS } from "./constants.js";
import { registerCoreSettings, registerPlayerModeSettings, registerPlayerModeSetting } from "./settings.js";
import { setupApprovalButtons } from "./approval.js";
import { setupSocketListeners } from "./socket.js";
import { setupDiceMethod, applyStartingMode, applyModeForConnection } from "./mode-application.js";
import { setupDialogMirroring } from "./dialog-mirroring.js";
import { setupChatLog, sendInitialChatHistory } from "./chat-log.js";
import { debug, debugError, installErrorDiagnostics } from "./debug.js";
import { openPanel, setupPanelMessages, sendPlayerModesToDLA, modesChanged } from "./dice-panel.js";
import { setupDiceFulfillment } from "./dice-fulfillment.js";
import { connect as connectToDLA, onConnectionChange as onDLAConnectionChange } from "./qwebchannel-client.js";
import { setupDiceClips } from "./video-feed.js";
import { setupBreaks } from "./break-manager.js";

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
    // invite), so the GM can approve them without reloading; they show in the panel and
    // in DLA's player list straight away.
    Hooks.on("createUser", (user) => {
      registerPlayerModeSetting(user.id);
      modesChanged();
    });

    // Give settings time to register before hooks fire
    await new Promise(resolve => setTimeout(resolve, ASYNC_OPERATION_DELAY_MS));

    // Start each script (each one also registers for the messages it handles, from DLA
    // and from the other players' screens)
    setupSocketListeners();
    setupApprovalButtons();
    setupPanelMessages();
    setupDialogMirroring();
    setupChatLog();
    setupDiceMethod();
    setupDiceFulfillment();
    setupDiceClips();
    setupBreaks();

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
      applyModeForConnection(connected);
      if (connected) {
        ui.notifications?.info("Connected to Dice Link App");
        sendInitialChatHistory();
        setTimeout(() => {
          debug("Sending player modes after connection established");
          sendPlayerModesToDLA();
        }, 100);
      }
    });

    applyStartingMode();
  } catch (error) {
    debugError("ERROR in ready hook:", error);
    debugError("Stack trace:", error.stack);
  }
});
