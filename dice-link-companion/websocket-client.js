/**
 * WebSocket Client Module - Dice Link Companion
 * Handles communication with the Dice Link App (DLA)
 * 
 * DLC acts as a WebSocket CLIENT connecting to DLA's server.
 * This module manages connection state, message sending/receiving,
 * and reconnection logic.
 */

import {
  MODULE_ID,
  DICE_LINK_APP_HOST,
  DICE_LINK_APP_PORT
} from "./constants.js";
import { debug as debugWebSocket, debugError } from "./debug.js";

// ============================================================================
// STATE
// ============================================================================

let socket = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let messageQueue = []; // Queue messages if not connected
let messageIdCounter = 0;
let pendingResponses = new Map(); // Track pending roll results by ID

// Configuration
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

// Connection state listeners
const connectionListeners = [];

// ============================================================================
// CONNECTION MANAGEMENT
// ============================================================================
/**
 * Manually reconnect to the Dice Link App (resets attempt counter)
 * Useful for testing or if connection is stuck
 * @returns {Promise<boolean>} True if connection successful
 */
export async function manualReconnect() {
  debugWebSocket("Manual reconnect triggered");
  reconnectAttempts = 0;
  
  // Close existing connection if any
  if (socket) {
    socket.close();
    socket = null;
    isConnected = false;
  }
  
  // Attempt fresh connection
  return connect();
}

/**
 * Connect to the Dice Link App WebSocket server
 * Uses window.location.hostname to work with local IPs, external IPs, and UPnP port forwarding
 * @returns {Promise<boolean>} True if connection successful
 */
export function connect() {
  return new Promise((resolve) => {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
      debugWebSocket("Already connected or connecting", { readyState: socket.readyState });
      resolve(isConnected);
      return;
    }

    // Use the hostname from where Foundry is loaded
    // This works for: localhost, local IPs, external IPs, and UPnP port forwarding
    const host = window.location.hostname;
    const wsUrl = `ws://${host}:${DICE_LINK_APP_PORT}/ws/dlc`;

    debugWebSocket("Connection attempt", { 
      origin: window.location.origin, 
      hostname: host, 
      url: wsUrl 
    });

    debugWebSocket("Connecting", { url: wsUrl, attempt: reconnectAttempts + 1 });

    try {
      socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        debugWebSocket("Connected", { url: wsUrl });
        isConnected = true;
        reconnectAttempts = 0;
        
        // Send connect message with client info
        sendMessage({
          type: "connect",
          client: "dlc",
          version: game.modules.get(MODULE_ID)?.version || "unknown",
          user: {
            id: game.user?.id,
            name: game.user?.name,
            isGM: game.user?.isGM
          }
        });

        // Flush queued messages
        flushMessageQueue();
        
        // Notify listeners
        notifyConnectionListeners(true);
        
        resolve(true);
      };

      socket.onclose = (event) => {
        debugWebSocket("Disconnected", { code: event.code, reason: event.reason, wasClean: event.wasClean });
        isConnected = false;
        socket = null;
        
        // Notify listeners
        notifyConnectionListeners(false);
        
        // Attempt reconnect if not a clean close
        if (!event.wasClean && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          scheduleReconnect();
        }
        
        resolve(false);
      };

      socket.onerror = (error) => {
        debugWebSocket("Error", { error: error.message || "WebSocket error", readyState: socket?.readyState, url: wsUrl });
        // onclose will be called after onerror
      };

      socket.onmessage = (event) => {
        handleMessage(event.data);
      };

    } catch (e) {
      debugError("WebSocket connection failed:", e);
      resolve(false);
    }
  });
}

/**
 * Disconnect from the Dice Link App
 */
export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
  
  if (socket) {
    debugWebSocket("Disconnecting", {});
    socket.close(1000, "Client requested disconnect");
    socket = null;
  }
  
  isConnected = false;
  notifyConnectionListeners(false);
}

/**
 * Schedule a reconnection attempt with exponential backoff
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  
  reconnectAttempts++;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1),
    RECONNECT_MAX_DELAY_MS
  );
  
  debugWebSocket("Scheduling reconnect", { attempt: reconnectAttempts, delayMs: delay });
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Get current connection status
 * @returns {boolean} True if connected
 */
export function getConnectionStatus() {
  return isConnected;
}

/**
 * Register a listener for connection state changes
 * @param {Function} callback - Called with (isConnected) when state changes
 * @returns {Function} Unsubscribe function
 */
export function onConnectionChange(callback) {
  connectionListeners.push(callback);
  return () => {
    const index = connectionListeners.indexOf(callback);
    if (index > -1) connectionListeners.splice(index, 1);
  };
}

/**
 * Notify all connection listeners of state change
 */
function notifyConnectionListeners(connected) {
  for (const listener of connectionListeners) {
    try {
      listener(connected);
    } catch (e) {
      debugError("Error in connection listener:", e);
    }
  }
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Send a message to the Dice Link App
 * @param {Object} message - Message object to send
 * @returns {string} Message ID for tracking
 */
export function sendMessage(message) {
  // Add message ID and timestamp
  const id = `dlc-${Date.now()}-${++messageIdCounter}`;
  const fullMessage = {
    ...message,
    id,
    timestamp: Date.now()
  };

  if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
    debugWebSocket("Sending", fullMessage);
    socket.send(JSON.stringify(fullMessage));
  } else {
    debugWebSocket("Queueing (not connected)", fullMessage);
    messageQueue.push(fullMessage);
  }

  return id;
}

/**
 * Flush queued messages after reconnection
 */
function flushMessageQueue() {
  if (messageQueue.length === 0) return;
  
  debugWebSocket("Flushing message queue", { count: messageQueue.length });
  
  const queue = [...messageQueue];
  messageQueue = [];
  
  for (const message of queue) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

/**
 * Handle incoming message from Dice Link App
 * @param {string} data - Raw message data
 */
function handleMessage(data) {
  try {
    const message = JSON.parse(data);
    debugWebSocket("Received", message);

    switch (message.type) {
      case "buttonSelect":
        // Phase A: User selected a button in DLA
        handleButtonSelect(message);
        break;
      case "diceResult":
        // Phase B: User submitted dice results in DLA
        handleDiceResult(message);
        break;
      case "rollResult":
        // Legacy: Combined button + results (backward compatibility)
        handleRollResult(message);
        break;
      case "rollCancelled":
        handleRollCancelled(message);
        break;
      case "diceTrayRoll":
        // DLA dice tray initiated a roll
        handleDiceTrayRoll(message);
        break;
      case "playerModeAction":
        // Player mode changed in DLA
        handlePlayerModeAction(message);
        break;
      case "error":
        handleErrorMessage(message);
        break;
      case "connected":
        debugWebSocket("Server acknowledged connection", message);
        break;
      default:
        debugWebSocket("Unknown message type", message);
    }
  } catch (e) {
    debugError("Failed to parse message:", e, data);
  }
}

// ============================================================================
// ROLL REQUEST/RESULT HANDLING
// ============================================================================

// Callback for when button selection is received (Phase A)
let buttonSelectCallback = null;

// Callback for when dice results are received (Phase B)
let diceResultCallback = null;

// Callback for when roll is cancelled by user in DLA
let cancelCallback = null;

// Callback for when DLA dice tray initiates a roll
let diceTrayRollCallback = null;

// Callback for when player mode action occurs in DLA
let playerModeActionCallback = null;

// Legacy callback (for backward compatibility during transition)
let rollResultCallback = null;

// Current pending dice request (for tracking Phase B)
let pendingDiceRequest = null;

/**
 * Set callback for handling button selection from DLA (Phase A)
 * @param {Function} callback - Called with (rollId, buttonClicked, configChanges)
 */
export function setButtonSelectCallback(callback) {
  buttonSelectCallback = callback;
}

/**
 * Set callback for handling dice results from DLA (Phase B)
 * @param {Function} callback - Called with (rollId, results)
 */
export function setDiceResultCallback(callback) {
  diceResultCallback = callback;
}

/**
 * Set callback for handling roll cancellation from DLA
 * @param {Function} callback - Called with (rollId)
 */
export function setCancelCallback(callback) {
  cancelCallback = callback;
}

/**
 * Set callback for handling roll results from DLA (legacy/combined)
 * @param {Function} callback - Called with (rollId, results, configChanges, buttonClicked)
 */
export function setRollResultCallback(callback) {
  rollResultCallback = callback;
}

/**
 * Set callback for handling dice tray rolls from DLA
 * @param {Function} callback - Called with (formula, flavor)
 */
export function setDiceTrayRollCallback(callback) {
  diceTrayRollCallback = callback;
}

/**
 * Set callback for handling player mode actions from DLA
 * @param {Function} callback - Called with (action, userId, newMode) for mode changes
 */
export function setPlayerModeActionCallback(callback) {
  playerModeActionCallback = callback;
}

/**
 * Send a roll request to the Dice Link App
 * @param {Object} rollData - Roll data extracted from dialog
 * @returns {string} Roll ID for tracking
 */
export function sendRollRequest(rollData) {
  const message = {
    type: "rollRequest",
    player: {
      id: game.user?.id,
      name: game.user?.name
    },
    roll: {
      title: rollData.title || "Roll",
      subtitle: rollData.subtitle || "",
      formula: rollData.formula || "",
      dice: rollData.dice || []
    },
    config: {
      fields: rollData.configFields || []
    },
    buttons: rollData.buttons || []
  };

  const id = sendMessage(message);
  pendingResponses.set(id, { rollData, timestamp: Date.now() });
  return id;
}

/**
 * Send a dice request to the Dice Link App (Phase B)
 * Called after Foundry has determined the actual dice needed
 * @param {string} rollId - ID of the original roll request
 * @param {Array} dice - Array of dice objects [{type: "d20", count: 2}, {type: "d6", count: 1}]
 * @param {string} formula - The actual formula from Foundry
 * @param {string} rollType - Type of roll (advantage, normal, disadvantage)
 * @returns {string} Message ID
 */
export function sendDiceRequest(rollId, dice, formula, rollType) {
  pendingDiceRequest = {
    originalRollId: rollId,
    dice,
    formula,
    rollType,
    timestamp: Date.now()
  };
  
  const message = {
    type: "diceRequest",
    originalRollId: rollId,
    rollType: rollType || "normal",
    formula: formula || "",
    dice: dice || []
  };
  
  return sendMessage(message);
}

/**
 * Get the current pending dice request
 * @returns {Object|null} Pending dice request or null
 */
export function getPendingDiceRequest() {
  return pendingDiceRequest;
}

/**
 * Clear the pending dice request
 */
export function clearPendingDiceRequest() {
  pendingDiceRequest = null;
}

/**
 * Send player modes update to DLA
 * Sends list of players with their current modes and global override setting
 * @param {Array} players - Array of player objects {id, name, mode}
 * @param {String} globalOverride - Current global override mode (or null)
 * @param {Array} pendingRequests - Array of pending approval requests
 */
export function sendPlayerModesUpdate(players, globalOverride, pendingRequests = []) {
  const message = {
    type: "playerModesUpdate",
    players: players || [],
    globalOverride: globalOverride || null,
    pendingRequests: pendingRequests || [],
    timestamp: Date.now()
  };
  
  debugWebSocket("Sending player modes update to DLA", { 
    playerCount: players?.length || 0,
    globalOverride,
    pendingCount: pendingRequests?.length || 0
  });
  
  return sendMessage(message);
}

/**
 * Handle button selection from Dice Link App (Phase A)
 * User clicked Advantage/Normal/Disadvantage in DLA
 * @param {Object} message - Button select message
 */
function handleButtonSelect(message) {
  debugWebSocket("Processing button selection (Phase A)", message);
  
  if (buttonSelectCallback) {
    buttonSelectCallback(
      message.id || message.originalRollId,
      message.button || "normal",
      message.configChanges || {}
    );
  }
}

/**
 * Handle dice result from Dice Link App (Phase B)
 * User submitted actual dice values in DLA
 * @param {Object} message - Dice result message
 */
function handleDiceResult(message) {
  debugWebSocket("Processing dice result (Phase B)", message);
  
  if (diceResultCallback) {
    diceResultCallback(
      message.originalRollId || message.id,
      message.results || []
    );
  }
  
  // Clear pending dice request
  pendingDiceRequest = null;
}

/**
 * Handle roll result from Dice Link App (legacy combined format)
 * DLA may still send this until it is updated to use buttonSelect + diceResult
 * @param {Object} message - Roll result message
 */
function handleRollResult(message) {
  debugWebSocket("Processing roll result (legacy)", message);
  
  const button = message.button || "normal";
  const results = message.results || [];
  const configChanges = message.configChanges || {};
  
  // If results are present, treat as Phase B (dice submitted)
  if (results.length > 0 && diceResultCallback) {
    debugWebSocket("Legacy rollResult has dice results - forwarding to diceResultCallback", results);
    diceResultCallback(message.id, results);
    return;
  }
  
  // If no results, treat as Phase A (button selected only)
  if (results.length === 0 && buttonSelectCallback) {
    debugWebSocket("Legacy rollResult has no results - forwarding to buttonSelectCallback", button);
    buttonSelectCallback(message.id, button, configChanges);
    return;
  }
  
  // Final fallback to legacy callback
  if (rollResultCallback) {
    rollResultCallback(message.id, results, configChanges, button);
  }
  
  // Clean up pending response
  pendingResponses.delete(message.id);
}

/**
 * Handle roll cancellation from Dice Link App
 * @param {Object} message - Cancellation message
 */
function handleRollCancelled(message) {
  debugWebSocket("Roll cancelled", message);
  
  // Use dedicated cancel callback
  if (cancelCallback) {
    cancelCallback(message.id || message.originalRollId);
  }
  
  pendingResponses.delete(message.id);
  pendingDiceRequest = null;
}

/**
 * Handle error message from Dice Link App
 * @param {Object} message - Error message
 */
function handleErrorMessage(message) {
  debugError("Error from Dice Link App:", message.error || message.message);
  ui.notifications?.warn(`Dice Link App: ${message.error || message.message}`);
}

/**
 * Handle dice tray roll from Dice Link App
 * DLA's dice tray initiated a roll - execute it in Foundry
 * @param {Object} message - Dice tray roll message with formula and flavor
 */
function handleDiceTrayRoll(message) {
  debugWebSocket("Dice tray roll from DLA", message);
  
  const formula = message.formula;
  const flavor = message.flavor || "Manual Dice Roll";
  
  if (!formula) {
    debugError("No formula in diceTrayRoll message");
    return;
  }
  
  if (diceTrayRollCallback) {
    diceTrayRollCallback(formula, flavor);
  } else {
    debugError("No diceTrayRollCallback registered");
  }
}

/**
 * Handle player mode action from DLA
 * @param {Object} message - Player mode action message
 */
function handlePlayerModeAction(message) {
  debugWebSocket("Player mode action from DLA", message);
  
  const { action, userId, newMode, globalOverride } = message;
  
  if (playerModeActionCallback) {
    playerModeActionCallback(action, userId, newMode, globalOverride);
  } else {
    debugError("No playerModeActionCallback registered");
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Extract roll data from mirrored dialog for sending to DLA
 * @param {Object} dialogData - Data from setMirroredDialog
 * @returns {Object} Formatted roll data for DLA
 */
export function extractRollDataForDLA(dialogData) {
  const { data: formData, clonedHTML } = dialogData;
  
  // Extract dice from formula (basic parsing)
  const dice = [];
  const formulaMatch = formData?.formula?.match(/(\d*)d(\d+)/gi) || [];
  for (const match of formulaMatch) {
    const parts = match.toLowerCase().match(/(\d*)d(\d+)/);
    if (parts) {
      const count = parseInt(parts[1]) || 1;
      const type = `d${parts[2]}`;
      dice.push({ type, count });
    }
  }

  // Extract config fields from form inputs
  const configFields = [];
  if (formData?.inputs) {
    for (const [name, input] of Object.entries(formData.inputs)) {
      // Generate human-readable label from field name
      // Handles: "roll.0.situational" -> "Situational Bonus"
      //          "rollMode" -> "Roll Mode"
      //          "ability" -> "Ability"
      const generateLabel = (fieldName) => {
        // Known field name mappings
        const labelMap = {
          'situational': 'Situational Bonus',
          'rollMode': 'Roll Mode',
          'ability': 'Ability',
          'skill': 'Skill',
          'tool': 'Tool',
          'dc': 'DC',
          'flavor': 'Flavor Text'
        };
        
        // Extract the last part of dotted names (e.g., "roll.0.situational" -> "situational")
        const baseName = fieldName.includes('.') ? fieldName.split('.').pop() : fieldName;
        
        // Check if we have a known mapping
        if (labelMap[baseName]) {
          return labelMap[baseName];
        }
        
        // Otherwise, convert camelCase to Title Case
        return baseName.charAt(0).toUpperCase() + baseName.slice(1).replace(/([A-Z])/g, ' $1');
      };
      
      if (input.type === "select-one" || input.options) {
        configFields.push({
          name,
          label: generateLabel(name),
          type: "select",
          options: input.options || [],
          selected: input.value
        });
      } else if (input.type === "text" || input.type === "number" || !input.type) {
        configFields.push({
          name,
          label: generateLabel(name),
          type: input.type || "text",
          value: input.value || ""
        });
      }
    }
  }

  // Extract buttons
  const buttons = [];
  if (formData?.buttons) {
    for (const btn of formData.buttons) {
      buttons.push({
        id: btn.action || btn.label?.toLowerCase().replace(/\s+/g, '-') || `btn-${buttons.length}`,
        label: btn.label
      });
    }
  }

  return {
    title: formData?.title || "Roll",
    subtitle: formData?.formula || "",
    formula: formData?.formula || "",
    dice,
    configFields,
    buttons
  };
}
