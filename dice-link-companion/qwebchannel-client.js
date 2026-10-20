/**
 * qwebchannel-client.js - DLC's link to the Dice Link App (DLA). DLA shows Foundry in its
 * own built-in browser and offers "dlaInterface" through Qt's QWebChannel. This script
 * finds it, announces DLC, answers DLA's connection checks, passes every message from DLA
 * to the DLC script that registered for it, and sends DLC's messages to DLA.
 */

import { debugQWebChannel, debugError } from "./debug.js";

// ============================================================================
// CONNECTION STATE
// ============================================================================

let isConnected = false;
let dlaInterface = null;
let connectionChangeCallbacks = [];

// Every message DLA sends DLC: the DLA signal it arrives on, and how its JSON is unpacked
// into what the DLC script handling it receives. The camera signals carry no JSON (a
// frame as base64 text, then a bare "stream ended"), so they are passed on as they come,
// and not logged (a frame arrives many times a second).
const FROM_DLA = {
  rollCancelled:    { signal: "rollCancelledReady",    unpack: m => [m.id || m.originalRollId] },
  diceResult:       { signal: "diceResultReady",       unpack: m => [m.originalRollId || m.id, m.results || []] },
  buttonSelect:     { signal: "buttonSelectReady",     unpack: m => [m.id || m.originalRollId, m.button || "normal", m.configChanges || {}] },
  diceTrayRoll:     { signal: "diceTrayRollReady",     unpack: m => [m.formula, m.flavor] },
  playerModeAction: { signal: "playerModeActionReady", unpack: m => [m] },   // GM's Approve / Deny in DLA's player list
  chatInteraction:  { signal: "chatInteractionReady",  unpack: m => [m] },   // a click on a chat card in DLA
  chatCommand:      { signal: "chatCommandReady",      unpack: m => [m] },   // chat typed in DLA's tray
  chatVisibility:   { signal: "chatVisibilityReady",   unpack: m => [m] },   // DLA's public / whisper / self / GM buttons
  startBreak:       { signal: "startBreakReady",       unpack: m => [m] },   // GM break from DLA's timer
  cameraFrame:      { signal: "cameraFrameReady",      raw: true },
  cameraStreamEnd:  { signal: "cameraStreamEndReady",  raw: true }
};

// The DLC function handling each message from DLA (registered with onDLAMessage)
const handlers = {};

// Every message DLC sends DLA: its type, and the DLA receiver that takes it
const TO_DLA = {
  rollRequest: "receiveRollRequest",
  diceRequest: "receiveDiceRequest",
  playerModesUpdate: "receivePlayerModesUpdate",
  chatMessage: "receiveChatMessage",
  chatInit: "receiveChatMessage",
  chatSetup: "receiveChatMessage",
  chatVisibilityState: "receiveChatMessage"
};

// ============================================================================
// INITIALIZATION - Check for QWebChannel / DLA Interface
// ============================================================================

/**
 * Initialize QWebChannel connection with DLA
 * Called during Foundry ready hook
 *
 * DLC initiates contact first (reversed messaging pattern):
 * 1. DLC checks if dlaInterface exists
 * 2. If it does, DLC sends "dlcReady" message to announce it's loaded
 * 3. DLA responds by establishing connection
 * 4. This avoids timing issues with events firing before listeners are ready
 *
 * @returns {Promise<boolean>} True if connected to DLA
 */
export async function connect() {
  debugQWebChannel("Initializing QWebChannel connection", {});
  debugQWebChannel("window.dlaInterface exists?", !!window.dlaInterface);

  // Check if dlaInterface is already available (DLA loaded first)
  if (window.dlaInterface) {
    debugQWebChannel("dlaInterface found immediately - announcing DLC is ready", {});
    return announceDLCReady(window.dlaInterface);
  }

  // If not available yet, wait briefly for it to appear
  debugQWebChannel("dlaInterface not yet available - waiting...", {});

  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      debugQWebChannel("Checking for dlaInterface...", !!window.dlaInterface);
      if (window.dlaInterface) {
        clearInterval(checkInterval);
        debugQWebChannel("dlaInterface became available", {});
        const result = announceDLCReady(window.dlaInterface);
        resolve(result);
      }
    }, 100);

    // Timeout after 10 seconds - DLA probably not running
    setTimeout(() => {
      clearInterval(checkInterval);
      if (!window.dlaInterface) {
        debugQWebChannel("dlaInterface never appeared - DLA not running in embedded mode", { timeout: 10000 });
        resolve(false);
      }
    }, 10000);
  });
}

/**
 * Announce to DLA that DLC is ready and initialized
 * This triggers DLA to establish the connection
 * @param {Object} dlaIface - The dlaInterface object from DLA
 * @returns {Promise<boolean>} True if DLA acknowledged
 */
async function announceDLCReady(dlaIface) {
  try {
    debugQWebChannel("announceDLCReady() called", { type: typeof dlaIface, keys: Object.keys(dlaIface) });

    // Call the correct method on DLA interface to announce DLC is ready
    if (typeof dlaIface.dlcModuleInitialized === "function") {
      debugQWebChannel("Calling dlcModuleInitialized()...", {});
      dlaIface.dlcModuleInitialized();
      debugQWebChannel("dlcModuleInitialized() called successfully", {});
    } else {
      debugError("dlcModuleInitialized is NOT a function", {
        type: typeof dlaIface.dlcModuleInitialized,
        availableKeys: Object.keys(dlaIface)
      });
      return false;
    }

    // Wait for DLA's acknowledgement via dlcModuleReady signal
    debugQWebChannel("Waiting for dlcModuleReady signal...", {});
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        debugError("dlcModuleReady signal TIMEOUT - DLA did not acknowledge", {});
        resolve(false);
      }, 5000);

      if (dlaIface.dlcModuleReady) {
        debugQWebChannel("dlcModuleReady signal found, connecting...", {});
        dlaIface.dlcModuleReady.connect(function(ackJson) {
          clearTimeout(timeout);
          debugQWebChannel("DLA acknowledged via dlcModuleReady signal", { ackJson });

          // Setup the interface after DLA acknowledges
          const setupSuccess = setupDLAInterface(dlaIface);
          resolve(setupSuccess);
        });
      } else {
        clearTimeout(timeout);
        debugError("dlcModuleReady signal NOT FOUND on dlaInterface", {});
        resolve(false);
      }
    });
  } catch (error) {
    debugError("Exception in announceDLCReady", { message: error.message, stack: error.stack });
    return false;
  }
}

/**
 * Setup the DLA interface and connect all signal handlers
 * @param {Object} dlaIface - The dlaInterface object from DLA
 * @returns {boolean} True if setup successful
 */
function setupDLAInterface(dlaIface) {
  try {
    dlaInterface = dlaIface;
    isConnected = true;

    debugQWebChannel("Setting up signal handlers", {});

    // Connect a handler for every message DLA sends (see FROM_DLA)
    for (const [name, { signal, unpack, raw }] of Object.entries(FROM_DLA)) {
      if (!dlaInterface[signal]) continue;
      dlaInterface[signal].connect((...received) => {
        if (!raw) debugQWebChannel(`Received ${name} signal`, {});
        const handler = handlers[name];
        if (handler) handler(...(raw ? received : unpack(JSON.parse(received[0]))));
      });
    }

    // Connection status
    if (dlaInterface.connectionStatusReady) {
      dlaInterface.connectionStatusReady.connect((status) => {
        debugQWebChannel("Received connectionStatus signal", { status });
        handleConnectionStatusChange(status);
      });
    }

    // Connection health check - ping/pong mechanism
    if (dlaInterface.connectionPingReady) {
      dlaInterface.connectionPingReady.connect(() => {
        debugQWebChannel("Received ping, sending pong...", {});
        if (dlaInterface.receiveConnectionPong) {
          dlaInterface.receiveConnectionPong();
          debugQWebChannel("Pong sent", {});
        } else {
          debugError("receiveConnectionPong method not available", {});
        }
      });
    }

    // Notify all listeners that connection established
    notifyConnectionChange(true);
    return true;

  } catch (error) {
    debugError("QWebChannel setup failed", error);
    isConnected = false;
    return false;
  }
}

/**
 * Handle connection status changes from DLA
 * @param {string} status - "connected", "disconnected", "error"
 */
function handleConnectionStatusChange(status) {
  const wasConnected = isConnected;

  debugQWebChannel("handleConnectionStatusChange", { status, wasConnected });

  if (status === "connected") {
    isConnected = true;
  } else if (status === "disconnected" || status === "error") {
    isConnected = false;
  }

  debugQWebChannel("Connection state after handling", { isConnected });

  if (wasConnected !== isConnected) {
    debugQWebChannel("Connection state changed, notifying listeners", {});
    notifyConnectionChange(isConnected);
  }
}

/**
 * Notify all connection change callbacks
 * @param {boolean} connected - True if connected
 */
function notifyConnectionChange(connected) {
  connectionChangeCallbacks.forEach(callback => {
    try {
      callback(connected);
    } catch (error) {
      debugError("Connection change callback error", error);
    }
  });
}

// ============================================================================
// MESSAGE SENDING - Send data to DLA via QWebChannel
// ============================================================================

/**
 * Send a message to DLA; its type decides which DLA receiver gets it
 * @param {Object} data - The message, with a "type"
 */
export function sendMessage(data) {
  debugQWebChannel("sendMessage called", { type: data.type, isConnected, hasDlaInterface: !!dlaInterface });

  if (!isConnected || !dlaInterface) {
    debugError("QWebChannel not connected, cannot send message", { messageType: data.type, isConnected, hasDlaInterface: !!dlaInterface });
    return;
  }

  try {
    const jsonData = JSON.stringify(data);
    debugQWebChannel("Sending message", { type: data.type, data: jsonData });

    const receiver = TO_DLA[data.type];
    if (receiver && dlaInterface[receiver]) {
      dlaInterface[receiver](jsonData);
    } else {
      debugError("Unknown message type or handler not available", { type: data.type, receiver });
    }
  } catch (error) {
    debugError("QWebChannel message send error", error);
  }
}

// ============================================================================
// CALLBACK REGISTRATION
// ============================================================================

/**
 * Register the DLC function that handles one message from DLA (a name in FROM_DLA).
 * It receives the message's unpacked data, e.g. onDLAMessage("diceResult", (rollId, results) => ...).
 */
export function onDLAMessage(name, handler) {
  if (!FROM_DLA[name]) {
    debugError("onDLAMessage: no such message from DLA", { name });
    return;
  }
  handlers[name] = handler;
}

export function onConnectionChange(callback) {
  connectionChangeCallbacks.push(callback);
}

// ============================================================================
// STATUS QUERIES
// ============================================================================

export function getConnectionStatus() {
  return isConnected;
}
