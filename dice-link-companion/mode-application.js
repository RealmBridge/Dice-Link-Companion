/**
 * Mode Application Module - dice-link-companion
 * Handles applying manual/digital dice modes to the Foundry dice fulfillment system.
 * These functions control whether players use our custom panel UI or Foundry's digital dice.
 */

import { applyDiceLinkFulfillment, removeDiceLinkFulfillment } from "./dice-fulfillment.js";

/**
 * Apply manual dice mode.
 * Always sets dice-link fulfillment so Foundry shows the RollResolver.
 * When DLA is connected, DLA fills values; when not, readOnly is stripped in
 * dialog-mirroring.js so the user can type directly.
 */
async function applyManualDice() {
  applyDiceLinkFulfillment();
}

/**
 * Apply digital dice mode.
 * Always restores whatever fulfillment method was active before DLC wrote to it.
 */
async function applyDigitalDice() {
  removeDiceLinkFulfillment();
}

export {
  applyManualDice,
  applyDigitalDice
};
