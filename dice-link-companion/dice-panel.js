/**
 * dice-panel.js - the DLC panel (opened from the D20 button in Foundry's scene controls):
 * the panel window itself, opening it, refreshing it, and every button and switch on it,
 * for the GM panel and the player panel, including what the other screens do when the GM
 * changes the group override. The panel's HTML comes from ui-templates.js.
 * Also sends DLA the player list for its own Player Modes list, whenever the panel's changes.
 */

import { ROLE_NAMES, GLOBAL_OVERRIDE_MODES, PLAYER_MODES } from "./constants.js";
import { debug } from "./debug.js";
import {
  getCurrentPanelDialog,
  setCurrentPanelDialog
} from "./state-management.js";
import {
  setGlobalOverride,
  setPlayerMode,
  getGlobalOverride,
  getPendingRequests,
  getPlayerModes,
  getCollapsedSections,
  setCollapsedSections
} from "./settings.js";
import { setManualRollsPermission } from "./settings-helpers.js";
import { applyMode, applyModeForOverride } from "./mode-application.js";
import {
  approveManualRequest,
  denyManualRequest,
  revokeManualDice,
  playerRequestManual,
  playerSwitchToDigital
} from "./approval.js";
import { emitToPlayers, onPlayerMessage } from "./socket.js";
import { sendMessage } from "./qwebchannel-client.js";
import { generatePanelContent } from "./ui-templates.js";

// What the GM sees when they change the group override
const OVERRIDE_NOTICES = {
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL]: "Forced all to manual dice.",
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL]: "Forced all to digital dice.",
  [GLOBAL_OVERRIDE_MODES.INDIVIDUAL]: "Set to individual control."
};

// ...and what each player sees
const PLAYER_OVERRIDE_NOTICES = {
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL]: "GM has forced manual dice for everyone.",
  [GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL]: "GM has forced digital dice for everyone.",
  [GLOBAL_OVERRIDE_MODES.INDIVIDUAL]: "GM has returned to individual control."
};

// ============================================================================
// THE PANEL WINDOW (ApplicationV2 for Foundry V13+)
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

// ============================================================================
// PANEL MANAGEMENT
// ============================================================================

/**
 * Send DLA the player list for its Player Modes list: every player's mode and whether
 * their request is waiting (the same list the panel shows), with their character's name
 * and portrait.
 */
export function sendPlayerModesToDLA() {
  const globalOverride = getGlobalOverride();
  const pending = getPendingRequests();
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

  sendMessage({
    type: "playerModesUpdate",
    players,
    globalOverride: globalOverride || null,
    worldId: game.world.id,
    worldTitle: game.world.title
  });
}

/**
 * The GM changed the group override on their screen: switch this screen's dice to match,
 * and tell the player. Called from main.mjs setup.
 */
export function setupPanelMessages() {
  onPlayerMessage("globalOverride", ({ mode }) => {
    if (!PLAYER_OVERRIDE_NOTICES[mode]) return;
    applyModeForOverride(mode);
    ui.notifications.info(PLAYER_OVERRIDE_NOTICES[mode]);
    refreshPanel();
  });
}

/**
 * Players' modes or requests changed: send DLA the player list and redraw the panel.
 */
export function modesChanged() {
  debug("Player mode changed - resending modes to DLA");
  sendPlayerModesToDLA();
  refreshPanel();
}

/**
 * Refresh the panel content without recreating the dialog
 */
export function refreshPanel() {
  const panelDialog = getCurrentPanelDialog();
  if (panelDialog && panelDialog.rendered) {
    // ApplicationV2 returns HTMLElement, not jQuery - wrap in jQuery for compatibility
    const $element = $(panelDialog.element);
    const contentElement = $element.find(".window-content");

    contentElement.html(generatePanelContent(panelDialog.isGM));
    attachPanelListeners($element, panelDialog.isGM);

    // Recalculate height only, preserve width to prevent stretching
    const fixedWidth = panelDialog.position?.width || 480;
    panelDialog.setPosition({ height: "auto", width: fixedWidth });
  }
}

/**
 * Open the DLC panel (or bring to front if already open)
 */
export function openPanel() {
  debug("openPanel called");
  const panelDialog = getCurrentPanelDialog();
  debug("getCurrentPanelDialog returned:", panelDialog);
  // If panel already exists and is rendered, just bring it to front - don't recreate
  if (panelDialog && panelDialog.rendered) {
    debug("Panel exists and rendered, bringing to top");
    panelDialog.bringToFront();
    return;
  }

  // If panel exists but not rendered, close it first
  if (panelDialog) {
    debug("Panel exists but not rendered, closing first");
    try {
      panelDialog.close();
    } catch (e) {
      // Ignore errors from closing
    }
  }

  debug("Creating new panel dialog");
  const isGM = game.user.isGM;
  const newPanelDialog = new DiceLinkCompanionApp(isGM);
  debug("Setting currentPanelDialog");
  setCurrentPanelDialog(newPanelDialog);
  debug("Rendering panel");
  newPanelDialog.render(true);
}

// ============================================================================
// PANEL LISTENERS
// ============================================================================

/**
 * Fold / unfold a section when its heading is clicked (both panels), remembering it
 */
function attachSectionToggles(html) {
  html.find(".dlc-section-header").click( function() {
    const section = $(this).data("section");
    const currentCollapsed = getCollapsedSections();
    if (section && currentCollapsed.hasOwnProperty(section)) {
      currentCollapsed[section] = !currentCollapsed[section];
      // Save collapsed state to settings
      setCollapsedSections(currentCollapsed);
      refreshPanel();
    }
  });
}

/**
 * Hook up the panel's buttons and switches: the GM panel's or the player panel's
 */
function attachPanelListeners(html, isGM) {
  if (isGM) attachGMPanelListeners(html);
  else attachPlayerPanelListeners(html);
}

/**
 * Attach all event listeners for the GM panel
 */
function attachGMPanelListeners(html) {
  attachSectionToggles(html);

  // Role permission toggles
  html.find(".dlc-role-toggle").change(async function() {
    const role = parseInt($(this).data("role"));
    const enabled = $(this).is(":checked");
    const success = await setManualRollsPermission(role, enabled);
    if (success) {
      ui.notifications.info(`Manual rolls ${enabled ? 'enabled' : 'disabled'} for ${ROLE_NAMES[role]}.`);
    }
    refreshPanel();
  });

  // Refresh button
  html.find(".dlc-refresh-btn").click( function() {
    refreshPanel();
    ui.notifications.info("Panel refreshed.");
  });

  // Group override switches: ticking Manual or Digital forces everyone into it; unticking
  // returns everyone to their own setting. The GM's own screen is switched here, because
  // the socket message only reaches the other players.
  html.find(".dlc-override-manual, .dlc-override-digital").change(async function() {
    const forced = $(this).hasClass("dlc-override-manual")
      ? GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL : GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL;
    const mode = $(this).is(":checked") ? forced : GLOBAL_OVERRIDE_MODES.INDIVIDUAL;
    await setGlobalOverride(mode);
    applyModeForOverride(mode);
    emitToPlayers({ action: "globalOverride", mode });
    ui.notifications.info(OVERRIDE_NOTICES[mode]);
    modesChanged();
  });

  // GM mode toggle (switch style)
  html.find(".dlc-gm-mode-toggle").change(async function() {
    const isManual = $(this).is(":checked");
    const newMode = isManual ? PLAYER_MODES.MANUAL : PLAYER_MODES.DIGITAL;

    await setPlayerMode(game.user.id, newMode);
    applyMode(newMode);
    ui.notifications.info(isManual ? "Your dice: Manual" : "Your dice: Digital");
    modesChanged();
  });

  // Approve / Deny / Revoke buttons (approval.js does the work)
  html.find(".dlc-panel-approve").click(function() {
    approveManualRequest($(this).data("player-id"));
  });

  html.find(".dlc-panel-deny").click(function() {
    denyManualRequest($(this).data("player-id"));
  });

  html.find(".dlc-panel-revoke").click(function() {
    revokeManualDice($(this).data("player-id"));
  });
}

/**
 * Attach all event listeners for the Player panel
 */
function attachPlayerPanelListeners(html) {
  attachSectionToggles(html);

  // Request manual button
  html.find(".dlc-player-request").click( function() {
    playerRequestManual();
    refreshPanel();
  });

  // Switch to digital button
  html.find(".dlc-player-digital").click( function() {
    playerSwitchToDigital();
    refreshPanel();
  });

}
