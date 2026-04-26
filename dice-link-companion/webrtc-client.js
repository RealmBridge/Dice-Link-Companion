/**
 * WebRTC Client Module - Dice Link Companion
 * Handles WebRTC Data Channel communication with DLA
 * Provides same API surface as websocket-client.js for compatibility
 *
 * Uses browser-as-offerer pattern for Chrome compatibility
 * Implements manual signaling via HTTP copy-paste handshake
 */

import { debugWebRTC, debugError } from "./debug.js";
import {
  DICE_LINK_APP_HOST,
  DICE_LINK_APP_PORT,
  MODULE_ID
} from "./constants.js";
import { showOfferDialog, closeHandshakeDialog } from "./webrtc-handshake-dialog.js";

// ============================================================================
// STATE
// ============================================================================

let peerConnection = null;
let dataChannel = null;
let isConnected = false;
let isConnecting = false;
let messageQueue = [];
let connectionListeners = [];

// Store for connection state tracking
let lastError = null;
let connectionAttempts = 0;
const MAX_CONNECTION_ATTEMPTS = 5;

// ============================================================================
// CONFIGURATION
// ============================================================================

const WEBRTC_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302"] },
    { urls: ["stun:stun1.l.google.com:19302"] }
  ]
};

const DATA_CHANNEL_CONFIG = {
  ordered: true,
  maxRetransmits: 3
};

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Initiate WebRTC connection to DLA
 * Browser acts as offerer, generates SDP offer
 * @returns {Promise<boolean>} True if connection initiated successfully
 */
export async function connect() {
  if (isConnecting || (peerConnection && peerConnection.connectionState !== "failed" && peerConnection.connectionState !== "closed")) {
    debugWebRTC("Connection already in progress or connected", {
      isConnecting,
      state: peerConnection?.connectionState
    });
    return isConnected;
  }

  try {
    isConnecting = true;
    connectionAttempts++;

    debugWebRTC("Starting WebRTC connection", {
      hostname: window.location.hostname,
      attempt: connectionAttempts
    });

    // Initialize peer connection with STUN servers
    peerConnection = new RTCPeerConnection({ iceServers: WEBRTC_CONFIG.iceServers });

    // Set up connection state monitoring
    peerConnection.onconnectionstatechange = () => {
      handleConnectionStateChange(peerConnection.connectionState);
    };

    peerConnection.onicecandidateerror = (event) => {
      debugError("ICE candidate error", { error: event.errorText });
    };

    // Create data channel BEFORE generating offer
    dataChannel = peerConnection.createDataChannel("dlc-data", DATA_CHANNEL_CONFIG);
    setupDataChannel(dataChannel);

    // Generate SDP offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    debugWebRTC("SDP offer generated", {
      sdpLength: offer.sdp.length,
      offerReady: true
    });

    // Display offer to user for copy-paste handshake
    await displayOfferAndWaitForAnswer(peerConnection.localDescription);

    return true;

  } catch (error) {
    lastError = error;
    debugError("WebRTC connection failed", error);
    isConnecting = false;
    cleanupConnection();
    return false;
  }
}

/**
 * Automated test connection - bypasses copy/paste, sends offer directly via fetch
 * This tests whether the issue is in copy/paste handling or WebRTC setup
 * @returns {Promise<boolean>} True if connection successful
 */
export async function connectAutomated() {
  if (isConnecting || (peerConnection && peerConnection.connectionState !== "failed" && peerConnection.connectionState !== "closed")) {
    debugWebRTC("Connection already in progress or connected", {
      isConnecting,
      state: peerConnection?.connectionState
    });
    return isConnected;
  }

  try {
    isConnecting = true;
    connectionAttempts++;

    debugWebRTC("Starting automated WebRTC connection (no copy/paste)", {
      hostname: window.location.hostname,
      attempt: connectionAttempts
    });

    // Initialize peer connection with STUN servers
    peerConnection = new RTCPeerConnection({ iceServers: WEBRTC_CONFIG.iceServers });
    debugWebRTC("PeerConnection created", {});

    // Set up connection state monitoring
    peerConnection.onconnectionstatechange = () => {
      debugWebRTC("Connection state changed", { state: peerConnection.connectionState });
      handleConnectionStateChange(peerConnection.connectionState);
    };

    peerConnection.onicecandidateerror = (event) => {
      debugError("ICE candidate error", { error: event.errorText });
    };

    // Create data channel BEFORE generating offer
    dataChannel = peerConnection.createDataChannel("dlc-data", DATA_CHANNEL_CONFIG);
    setupDataChannel(dataChannel);
    debugWebRTC("Data channel created", {});

    // Generate SDP offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    debugWebRTC("Offer created", { sdpLength: offer.sdp.length });

    // Wait for ICE gathering to complete (important!)
    await waitForIceGatheringComplete();

    // Get the complete offer with ICE candidates
    const completeOffer = peerConnection.localDescription.sdp;
    debugWebRTC("Complete offer with ICE ready", { length: completeOffer.length });

    // Send offer directly to DLA via fetch (no copy/paste)
    debugWebRTC("Sending offer to DLA", { url: `http://127.0.0.1:${DICE_LINK_APP_PORT}/api/receive-offer` });
    const response = await fetch(`http://127.0.0.1:${DICE_LINK_APP_PORT}/api/receive-offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offer: completeOffer })
    });

    if (!response.ok) {
      throw new Error(`DLA returned error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    debugWebRTC("Received answer from DLA", {
      answerLength: result.answer.length,
      first100: result.answer.substring(0, 100)
    });

    // Set the answer directly (no textarea normalization needed)
    const answerDescription = new RTCSessionDescription({
      type: "answer",
      sdp: result.answer
    });

    debugWebRTC("Calling setRemoteDescription...", {});
    await peerConnection.setRemoteDescription(answerDescription);
    debugWebRTC("setRemoteDescription succeeded", {
      connectionState: peerConnection.connectionState,
      iceConnectionState: peerConnection.iceConnectionState
    });

    isConnecting = false;
    return true;

  } catch (error) {
    debugError("Automated WebRTC connection failed", error);
    lastError = error;
    isConnecting = false;
    cleanupConnection();
    return false;
  }
}

/**
 * Wait for ICE gathering to complete
 * @returns {Promise<void>}
 */
function waitForIceGatheringComplete() {
  return new Promise((resolve) => {
    if (peerConnection.iceGatheringState === "complete") {
      resolve();
      return;
    }

    const checkState = () => {
      if (peerConnection.iceGatheringState === "complete") {
        peerConnection.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };

    peerConnection.addEventListener("icegatheringstatechange", checkState);

    // Timeout after 5 seconds
    setTimeout(() => {
      peerConnection.removeEventListener("icegatheringstatechange", checkState);
      debugWebRTC("ICE gathering timeout, proceeding anyway", {});
      resolve();
    }, 5000);
  });
}

/**
 * Disconnect from WebRTC peer
 * Closes data channel and peer connection
 */
export function disconnect() {
  debugWebRTC("Disconnecting WebRTC", {});

  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  isConnected = false;
  isConnecting = false;
  notifyConnectionListeners(false);
}

/**
 * Send a message through the WebRTC data channel
 * Queues message if not yet connected
 * @param {Object} message - Message to send
 */
export function sendMessage(message) {
  if (isConnected && dataChannel && dataChannel.readyState === "open") {
    try {
      const payload = JSON.stringify(message);
      dataChannel.send(payload);
      debugWebRTC("Message sent", { type: message.type });
    } catch (error) {
      debugError("Failed to send message", error);
      messageQueue.push(message);
    }
  } else {
    debugWebRTC("Message queued (not connected)", { type: message.type });
    messageQueue.push(message);
  }
}

/**
 * Get current connection status
 * @returns {Object} Connection status object
 */
export function getConnectionStatus() {
  return {
    isConnected,
    isConnecting,
    peerConnectionState: peerConnection?.connectionState || "closed",
    dataChannelState: dataChannel?.readyState || "closed",
    lastError,
    queuedMessages: messageQueue.length
  };
}

/**
 * Register callback for connection state changes
 * @param {Function} callback - Called with boolean: true (connected) or false (disconnected)
 */
export function onConnectionChange(callback) {
  connectionListeners.push(callback);
  // Immediately call with current state
  callback(isConnected);
}

// ============================================================================
// INTERNAL FUNCTIONS
// ============================================================================

/**
 * Handle data channel events
 * @param {RTCDataChannel} channel - The data channel
 */
function setupDataChannel(channel) {
  channel.onopen = () => {
    debugWebRTC("Data channel opened", { label: channel.label });
    isConnected = true;
    isConnecting = false;
    connectionAttempts = 0;
    notifyConnectionListeners(true);
    flushMessageQueue();
  };

  channel.onclose = () => {
    debugWebRTC("Data channel closed", {});
    isConnected = false;
    notifyConnectionListeners(false);
  };

  channel.onerror = (error) => {
    debugError("Data channel error", { error: error.message });
  };

  channel.onmessage = (event) => {
    handleMessage(event.data);
  };
}

/**
 * Handle peer connection state changes
 * @param {string} state - New connection state
 */
function handleConnectionStateChange(state) {
  debugWebRTC("Peer connection state changed", { state });

  switch (state) {
    case "connected":
      debugWebRTC("Peer connection established", {});
      break;
    case "disconnected":
      isConnected = false;
      notifyConnectionListeners(false);
      break;
    case "failed":
      debugError("Peer connection failed", { attemptCount: connectionAttempts });
      isConnecting = false;
      if (connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
        scheduleReconnect();
      }
      break;
    case "closed":
      isConnected = false;
      isConnecting = false;
      notifyConnectionListeners(false);
      break;
  }
}

/**
 * Display SDP offer to user and wait for answer via copy-paste
 * @param {RTCSessionDescription} localDescription - The SDP offer
 */
async function displayOfferAndWaitForAnswer(localDescription) {
  debugWebRTC("Waiting for user to provide SDP answer", {});

  // Format SDP with CRLF line endings as required
  const formattedOffer = localDescription.sdp.replace(/\n/g, "\r\n");

  // Show user a dialog to copy offer and paste answer
  return new Promise((resolve, reject) => {
    showOfferDialog(formattedOffer, async (rawAnswerSDP) => {
      try {
        debugWebRTC("Raw answer SDP received from user", {
          length: rawAnswerSDP.length,
          first200: rawAnswerSDP.substring(0, 200)
        });

        // Normalize line endings to CRLF as required by RFC 8866
        // Textareas convert CRLF to LF, but WebRTC requires CRLF
        const answerSDP = rawAnswerSDP.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
        debugWebRTC("Normalized answer SDP", { rawLength: rawAnswerSDP.length, normalizedLength: answerSDP.length });

        // Create RTCSessionDescription with the normalized answer
        const answerDescription = new RTCSessionDescription({
          type: "answer",
          sdp: answerSDP
        });
        debugWebRTC("RTCSessionDescription created", { type: answerDescription.type, sdpLength: answerDescription.sdp.length });

        // Set as remote description
        try {
          debugWebRTC("Calling setRemoteDescription with answer...", {});
          await peerConnection.setRemoteDescription(answerDescription);
          debugWebRTC("setRemoteDescription succeeded", {
            connectionState: peerConnection.connectionState,
            iceConnectionState: peerConnection.iceConnectionState
          });

          // Connection will be established when ICE completes
          // The data channel onopen event will fire when ready
          resolve(true);
        } catch (setRemoteError) {
          debugError("setRemoteDescription failed", {
            name: setRemoteError.name,
            message: setRemoteError.message
          });
          reject(setRemoteError);
        }
      } catch (error) {
        debugError("Failed to process answer SDP", error);
        reject(error);
      }
    });
  });
}

/**
 * Process incoming message from data channel
 * @param {string} data - JSON string message
 */
function handleMessage(data) {
  try {
    const message = JSON.parse(data);
    debugWebRTC("Message received", { type: message.type });

    switch (message.type) {
      case "connected":
        debugWebRTC("DLA confirmed connection", {});
        break;
      case "error":
        debugError("DLA error message", { error: message.error });
        break;
      default:
        debugWebRTC("Unhandled message type", { type: message.type });
    }

  } catch (error) {
    debugError("Failed to parse message", error);
  }
}

/**
 * Flush queued messages
 */
function flushMessageQueue() {
  if (messageQueue.length === 0) return;

  debugWebRTC("Flushing message queue", { count: messageQueue.length });

  while (messageQueue.length > 0) {
    const message = messageQueue.shift();
    sendMessage(message);
  }
}

/**
 * Notify all registered listeners of connection state change
 * @param {boolean} connected - True if connected, false if disconnected
 */
function notifyConnectionListeners(connected) {
  connectionListeners.forEach(callback => {
    try {
      callback(connected);
    } catch (error) {
      debugError("Connection listener callback error", error);
    }
  });
}

/**
 * Clean up connection resources
 */
function cleanupConnection() {
  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
}

/**
 * Schedule a reconnection attempt
 */
function scheduleReconnect() {
  if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
    debugError("Max reconnection attempts reached", { attempts: connectionAttempts });
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, connectionAttempts - 1), 30000);
  debugWebRTC("Scheduling reconnect", { delay, attempt: connectionAttempts });

  setTimeout(() => {
    connect();
  }, delay);
}

// ============================================================================
// CALLBACK REGISTRATION (matching websocket-client.js API)
// ============================================================================

// Callback storage
let buttonSelectCallback = null;
let diceResultCallback = null;
let cancelCallback = null;
let rollResultCallback = null;
let diceTrayRollCallback = null;
let playerModeActionCallback = null;

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
