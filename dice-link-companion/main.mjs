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
import { setupDiceEntryWindow } from "./dice-entry-window.js";
import { setupChatLog, sendInitialChatHistory } from "./chat-log.js";
import { debug, debugError, installErrorDiagnostics } from "./debug.js";
import { openPanel, setupPanelMessages, sendPlayerModesToDLA, modesChanged } from "./dice-panel.js";
import { setupDiceFulfillment } from "./dice-fulfillment.js";
import { connect as connectToDLA, onConnectionChange as onDLAConnectionChange } from "./qwebchannel-client.js";
import { setupDiceClips } from "./video-feed.js";
import { setupBreaks } from "./break-manager.js";

// ---- The D20 button in Foundry's scene controls ----

Hooks.on("getSceneControlButtons", (controls) => {
  if (!controls.tokens?.tools) return;

  controls.tokens.tools.diceLinkCompanion = {
    name: "diceLinkCompanion",
    title: "DICE_LINK.Title",   // Foundry looks the key up in en.json
    icon: "fa-solid fa-dice-d20",
    button: true,
    visible: true,
    order: 100,
    onChange: () => {
      openPanel();
    }
  };
});

// ---- Start-up ----

/**
 * Foundry is starting: register DLC's settings
 */
Hooks.once("init", async () => {
  installErrorDiagnostics();
  registerCoreSettings();
});

/**
 * The game is ready: start every DLC script and connect to DLA
 */
Hooks.once("ready", async () => {
  try {
    // Each player's mode setting (the players are known by now)...
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
    setupDiceEntryWindow();
    setupChatLog();
    setupDiceMethod();
    setupDiceFulfillment();
    setupDiceClips();
    setupBreaks();

    // Connect to DLA, if Foundry is running inside the Dice Link App (without it DLC still
    // runs: the panel, manual dice typed into Foundry, and so on). The "Connected" notice
    // comes from the connection change below.
    connectToDLA();

    // Handle connection status changes
    onDLAConnectionChange((connected) => {
      debug("Dice Link App connection status:", connected ? "connected" : "disconnected");
      applyModeForConnection(connected);
      if (connected) {
        ui.notifications?.info(game.i18n.localize("DICE_LINK.Notify.Connected"));
        sendInitialChatHistory();
        setTimeout(sendPlayerModesToDLA, 100);
      }
    });

    applyStartingMode();
  } catch (error) {
    debugError("Error while starting DLC:", error, error.stack);
  }
});
