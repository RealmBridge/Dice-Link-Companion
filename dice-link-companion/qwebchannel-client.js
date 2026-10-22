/**
 * qwebchannel-client.js - DLC's link to the Dice Link App (DLA). DLA shows Foundry in its
 * own built-in browser and offers "dlaInterface" through Qt's QWebChannel. This script
 * finds it, announces DLC, answers DLA's connection checks, passes every message from DLA
 * to the DLC script that registered for it, and sends DLC's messages to DLA.
 */

import { debugQWebChannel, debugError } from "./debug.js";

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
  diceRequest: "receiveDiceRequest",
  playerModesUpdate: "receivePlayerModesUpdate",
  chatMessage: "receiveChatMessage",
  chatInit: "receiveChatMessage",
  chatSetup: "receiveChatMessage",
  chatVisibilityState: "receiveChatMessage"
};

// ---- Connecting to DLA ----

/**
 * Connect to DLA. Called from main.mjs at start-up.
 * DLC makes the first contact: it waits for DLA's dlaInterface to appear in the page,
 * tells DLA it has loaded (dlcModuleInitialized), and DLA answers (dlcModuleReady). Going
 * this way round means no message from DLA can arrive before DLC is listening.
 * @returns {Promise<boolean>} True if connected to DLA
 */
export async function connect() {
  // DLA's interface is usually there already (DLA loads the page)
  if (window.dlaInterface) {
    return announceDLCReady(window.dlaInterface);
  }

  // If not available yet, wait briefly for it to appear
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (window.dlaInterface) {
        clearInterval(checkInterval);
        const result = announceDLCReady(window.dlaInterface);
        resolve(result);
      }
    }, 100);

    // Timeout after 10 seconds - DLA probably not running
    setTimeout(() => {
      clearInterval(checkInterval);
      if (!window.dlaInterface) {
        debugQWebChannel("No DLA after 10 seconds: Foundry is not running inside the Dice Link App");
        resolve(false);
      }
    }, 10000);
  });
}

/** Tell DLA that DLC has loaded, and wait for its answer (true once connected). */
async function announceDLCReady(dlaIface) {
  try {
    // Tell DLA that DLC has loaded
    if (typeof dlaIface.dlcModuleInitialized === "function") {
      dlaIface.dlcModuleInitialized();
    } else {
      debugError("dlcModuleInitialized is NOT a function", {
        type: typeof dlaIface.dlcModuleInitialized,
        availableKeys: Object.keys(dlaIface)
      });
      return false;
    }

    // Wait for DLA's acknowledgement via dlcModuleReady signal
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        debugError("dlcModuleReady signal TIMEOUT - DLA did not acknowledge", {});
        resolve(false);
      }, 5000);

      if (dlaIface.dlcModuleReady) {
        dlaIface.dlcModuleReady.connect(function(ackJson) {
          clearTimeout(timeout);
          debugQWebChannel("DLA answered: connected", { ackJson });

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

/** DLA answered: listen to every signal it sends, and tell DLC it's connected. */
function setupDLAInterface(dlaIface) {
  try {
    dlaInterface = dlaIface;
    isConnected = true;

    // Connect a handler for every message DLA sends (see FROM_DLA)
    for (const [name, { signal, unpack, raw }] of Object.entries(FROM_DLA)) {
      if (!dlaInterface[signal]) continue;
      dlaInterface[signal].connect((...received) => {
        if (!raw) debugQWebChannel(`From DLA: ${name}`);
        const handler = handlers[name];
        if (handler) handler(...(raw ? received : unpack(JSON.parse(received[0]))));
      });
    }

    // Connection status
    if (dlaInterface.connectionStatusReady) {
      dlaInterface.connectionStatusReady.connect((status) => {
        handleConnectionStatusChange(status);
      });
    }

    // Connection health check - ping/pong mechanism
    if (dlaInterface.connectionPingReady) {
      dlaInterface.connectionPingReady.connect(() => {
        if (dlaInterface.receiveConnectionPong) {
          dlaInterface.receiveConnectionPong();
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

/** DLA reported its connection status: "connected", "disconnected" or "error". */
function handleConnectionStatusChange(status) {
  const wasConnected = isConnected;

  if (status === "connected") {
    isConnected = true;
  } else if (status === "disconnected" || status === "error") {
    isConnected = false;
  }

  debugQWebChannel("Connection status from DLA", { status, wasConnected, isConnected });

  if (wasConnected !== isConnected) {
    notifyConnectionChange(isConnected);
  }
}

/** Tell every DLC script that registered (onConnectionChange) that the link came or went. */
function notifyConnectionChange(connected) {
  connectionChangeCallbacks.forEach(callback => {
    try {
      callback(connected);
    } catch (error) {
      debugError("Connection change callback error", error);
    }
  });
}

// ---- Sending to DLA ----

/**
 * Send a message to DLA; its type decides which DLA receiver gets it. Without DLA (a
 * player using Foundry on its own) there is no one to send it to, so nothing is sent.
 * @param {Object} data - The message, with a "type"
 */
export function sendMessage(data) {
  if (!isConnected || !dlaInterface) return;

  try {
    const jsonData = JSON.stringify(data);
    debugQWebChannel(`To DLA: ${data.type}`);

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

// ---- Registering for DLA's messages ----

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

// ---- Connection status ----

export function getConnectionStatus() {
  return isConnected;
}
