/**
 * QWebChannel Client for DLC
 * Handles communication with DLA via Qt's QWebChannel signal/slot pattern
 * Replaces WebSocket/WebRTC architecture with Qt embedded browser communication
 */

import { debugQWebChannel, debugError } from "./debug.js";

// ============================================================================
// CONNECTION STATE
// ============================================================================

let isConnected = false;
let dlaInterface = null;
let connectionChangeCallbacks = [];

// Callback storage (same API as websocket-client.js)
let buttonSelectCallback = null;
let diceResultCallback = null;
let cancelCallback = null;
let rollResultCallback = null;
let diceTrayRollCallback = null;
let playerModeActionCallback = null;
let cameraFrameCallback = null;
let cameraStreamEndCallback = null;

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

    // Connect signal handlers for all message types

    // Roll results
    if (dlaInterface.rollResultReady) {
      dlaInterface.rollResultReady.connect((result) => {
        debugQWebChannel("Received rollResult signal", {});
        if (rollResultCallback) rollResultCallback(JSON.parse(result));
      });
    }

    // Roll cancelled - callback expects: (rollId)
    if (dlaInterface.rollCancelledReady) {
      dlaInterface.rollCancelledReady.connect((data) => {
        debugQWebChannel("Received rollCancelled signal", {});
        const message = JSON.parse(data);
        if (cancelCallback) {
          cancelCallback(message.id || message.originalRollId);
        }
      });
    }

    // Roll complete
    if (dlaInterface.rollCompleteReady) {
      dlaInterface.rollCompleteReady.connect((data) => {
        debugQWebChannel("Received rollComplete signal", {});
      });
    }

    // Dice result - callback expects: (rollId, results[])
    if (dlaInterface.diceResultReady) {
      dlaInterface.diceResultReady.connect((result) => {
        debugQWebChannel("Received diceResult signal", {});
        const message = JSON.parse(result);
        if (diceResultCallback) {
          diceResultCallback(
            message.originalRollId || message.id,
            message.results || []
          );
        }
      });
    }

    // Button select - callback expects: (rollId, buttonClicked, configChanges)
    if (dlaInterface.buttonSelectReady) {
      dlaInterface.buttonSelectReady.connect((data) => {
        debugQWebChannel("Received buttonSelect signal", {});
        const message = JSON.parse(data);
        if (buttonSelectCallback) {
          buttonSelectCallback(
            message.id || message.originalRollId,
            message.button || "normal",
            message.configChanges || {}
          );
        }
      });
    }

    // Dice tray roll - callback expects: (formula, flavor)
    if (dlaInterface.diceTrayRollReady) {
      dlaInterface.diceTrayRollReady.connect((result) => {
        debugQWebChannel("Received diceTrayRoll signal", {});
        const message = JSON.parse(result);
        if (diceTrayRollCallback) {
          diceTrayRollCallback(message.formula, message.flavor);
        }
      });
    }

    // Player modes update - callback expects: (data object)
    if (dlaInterface.playerModesUpdateReady) {
      dlaInterface.playerModesUpdateReady.connect((data) => {
        debugQWebChannel("Received playerModesUpdate signal", {});
        const message = JSON.parse(data);
        if (playerModeActionCallback) {
          playerModeActionCallback(message);
        }
      });
    }

    // Connection status
    if (dlaInterface.connectionStatusReady) {
      dlaInterface.connectionStatusReady.connect((status) => {
        debugQWebChannel("Received connectionStatus signal", { status });
        handleConnectionStatusChange(status);
      });
    }

    // Camera stream frames
    if (dlaInterface.cameraFrameReady) {
      dlaInterface.cameraFrameReady.connect((frameB64) => {
        if (cameraFrameCallback) cameraFrameCallback(frameB64);
      });
    }

    // Camera stream ended
    if (dlaInterface.cameraStreamEndReady) {
      dlaInterface.cameraStreamEndReady.connect(() => {
        if (cameraStreamEndCallback) cameraStreamEndCallback();
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
 * Send roll request to DLA
 * @param {Object} data - Roll request data
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

    if (data.type === "rollRequest" && dlaInterface.receiveRollRequest) {
      debugQWebChannel("Calling receiveRollRequest...", {});
      dlaInterface.receiveRollRequest(jsonData);
      debugQWebChannel("receiveRollRequest called successfully", {});
    } else if (data.type === "diceRequest" && dlaInterface.receiveDiceRequest) {
      debugQWebChannel("Calling receiveDiceRequest...", {});
      dlaInterface.receiveDiceRequest(jsonData);
    } else if (data.type === "playerModesUpdate" && dlaInterface.receivePlayerModesUpdate) {
      debugQWebChannel("Calling receivePlayerModesUpdate...", {});
      dlaInterface.receivePlayerModesUpdate(jsonData);
    } else if ((data.type === "chatMessage" || data.type === "chatInit") && dlaInterface.receiveChatMessage) {
      dlaInterface.receiveChatMessage(jsonData);
    } else {
      debugError("Unknown message type or handler not available", {
        type: data.type,
        hasReceiveRollRequest: !!dlaInterface.receiveRollRequest,
        hasReceiveDiceRequest: !!dlaInterface.receiveDiceRequest,
        hasReceivePlayerModesUpdate: !!dlaInterface.receivePlayerModesUpdate
      });
    }
  } catch (error) {
    debugError("QWebChannel message send error", error);
  }
}

// ============================================================================
// CALLBACK REGISTRATION (same API as websocket-client.js)
// ============================================================================

export function setButtonSelectCallback(callback) {
  buttonSelectCallback = callback;
}

export function setDiceResultCallback(callback) {
  diceResultCallback = callback;
}

export function setCancelCallback(callback) {
  cancelCallback = callback;
}

export function setRollResultCallback(callback) {
  rollResultCallback = callback;
}

export function setDiceTrayRollCallback(callback) {
  diceTrayRollCallback = callback;
}

export function setPlayerModeActionCallback(callback) {
  playerModeActionCallback = callback;
}

export function setCameraFrameCallback(callback) {
  cameraFrameCallback = callback;
}

export function setCameraStreamEndCallback(callback) {
  cameraStreamEndCallback = callback;
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

export function disconnect() {
  isConnected = false;
  dlaInterface = null;
  notifyConnectionChange(false);
  debugQWebChannel("Disconnected from DLA", {});
}
