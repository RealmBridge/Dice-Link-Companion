/**
 * Mode Application Module - dice-link-companion
 * Handles applying manual/digital dice modes to the Foundry dice fulfillment system.
 * These functions control whether players use our custom panel UI or Foundry's digital dice.
 */

import { disableDSN, restoreDSN, applyDiceLinkFulfillment, removeDiceLinkFulfillment } from "./dice-fulfillment.js";
import { getConnectionStatus } from "./qwebchannel-client.js";

/**
 * Apply manual dice mode.
 * Only touches the fulfillment system when DLA is connected — otherwise Foundry
 * handles manual entry naturally and we must not overwrite its configuration.
 */
async function applyManualDice() {
  disableDSN();
  if (getConnectionStatus()) {
    applyDiceLinkFulfillment();
  }
}

/**
 * Apply digital dice mode.
 * Only touches the fulfillment system when DLA is connected — otherwise there
 * is nothing DLC wrote and nothing to restore.
 */
async function applyDigitalDice() {
  restoreDSN();
  if (getConnectionStatus()) {
    removeDiceLinkFulfillment();
  }
}

export {
  applyManualDice,
  applyDigitalDice
};
