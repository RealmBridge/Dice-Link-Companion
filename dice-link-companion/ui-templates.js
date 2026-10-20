/**
 * ui-templates.js - the HTML of the DLC panel: the GM panel (settings: permissions, group
 * override, the GM's own mode; pending requests; player modes) and the player panel
 * (player modes, request manual dice / switch to digital). Builds HTML only; the buttons
 * are handled in dice-panel.js.
 */

import {
  REALM_BRIDGE_URL,
  LOGO_URL,
  ROLE_NAMES,
  GLOBAL_OVERRIDE_MODES,
  PLAYER_MODES
} from "./constants.js";

import {
  getGlobalOverride,
  getPlayerMode,
  getPendingRequests,
  getCollapsedSections,
  getPlayerModes,
  overrideAllowsManualRequest,
  overrideAllowsSwitchToDigital
} from "./settings.js";

import { getManualRollsPermissions } from "./settings-helpers.js";



// ============================================================================
// PIECES BOTH PANELS USE
// ============================================================================

/** The Realm Bridge logo header at the top of the panel. */
function headerHTML() {
  return `
      <div class="dlc-header">
        <a href="${REALM_BRIDGE_URL}" target="_blank" class="dlc-logo-link" title="Visit Realm Bridge">
          <img src="${LOGO_URL}" alt="Realm Bridge" class="dlc-logo" onerror="this.style.display='none'">
        </a>
      </div>`;
}

/**
 * A panel section that folds: its heading (the +/- button and the title) and its content.
 * @param {string} section - the key its folded state is saved under (collapsedSections)
 * @param {string} [extraClass] / [style] - for the top Settings section and Pending Requests
 */
function sectionHTML(section, collapsed, icon, title, contentHTML, extraClass = "", style = "") {
  return `
        <div class="dlc-section ${extraClass} ${collapsed ? 'collapsed' : ''}"${style ? ` style="${style}"` : ''}>
          <div class="dlc-section-header" data-section="${section}">
            <span class="dlc-collapse-btn">${collapsed ? '+' : '−'}</span>
            <h3><i class="fas ${icon}"></i> ${title}</h3>
          </div>
          <div class="dlc-section-content">
            ${contentHTML}
          </div>
        </div>`;
}

/** A player's mode dot and name (and "(You)" on the player's own card). */
function playerInfoHTML(player, isYou = false) {
  return `
                  <div class="dlc-player-info">
                    <span class="dlc-mode-dot ${player.isPending ? 'pending' : player.mode}"></span>
                    <span class="dlc-player-name">${player.name}</span>${isYou ? `
                    <span class="dlc-self-indicator">(You)</span>` : ''}
                  </div>`;
}

/** The colour key under "Player Modes"; the GM's also explains the revoke corner. */
function modeLegendHTML(withRevoke) {
  return `
            <div class="dlc-mode-legend">
              <span class="dlc-legend-item"><span class="dlc-mode-dot digital"></span>Digital</span>
              <span class="dlc-legend-item"><span class="dlc-mode-dot manual"></span>Manual</span>
              <span class="dlc-legend-item"><span class="dlc-mode-dot pending"></span>Pending</span>${withRevoke ? `
              <span class="dlc-legend-item"><span class="dlc-revoke-dot"></span>Revoke</span>` : ''}
            </div>`;
}

// ============================================================================
// GM PANEL CONTENT
// ============================================================================

/**
 * Generate the complete GM control panel
 * Shows: Settings (Permissions, Override, Your Mode), Pending Requests, Player Modes
 */
function generateGMPanelContent() {
  const globalOverride = getGlobalOverride();
  const pendingRequests = getPendingRequests();
  const gmMode = getPlayerMode();
  const rolePermissions = getManualRollsPermissions();
  const collapsedSections = getCollapsedSections();

  // All users (including the GM) so everyone can see each other's modes
  const players = getPlayerModes(globalOverride, pendingRequests).map(player => ({
    ...player,
    canRevoke: globalOverride === GLOBAL_OVERRIDE_MODES.INDIVIDUAL && getPlayerMode(player.id) === PLAYER_MODES.MANUAL
  }));

  return `
    <div class="dlc-panel">
      ${headerHTML()}

      <!-- Top Row: Permissions | Global Override | GM Mode (Collapsible) -->
      ${sectionHTML("topRow", collapsedSections.topRow, "fa-cog", "Settings", `
          <div class="dlc-top-row">
        <!-- Permissions -->
        <div class="dlc-mini-section">
          <h4>Permissions</h4>
          <div class="dlc-role-toggles">
            ${[1, 2, 3].map(role => `
              <div class="dlc-toggle-row">
                <label class="dlc-switch">
                  <input type="checkbox" class="dlc-role-toggle" data-role="${role}" ${rolePermissions[role] ? 'checked' : ''}>
                  <span class="dlc-slider"></span>
                </label>
                <span class="dlc-toggle-label">${ROLE_NAMES[role]}</span>
              </div>
            `).join('')}
            <div class="dlc-toggle-row dlc-disabled">
              <label class="dlc-switch">
                <input type="checkbox" checked disabled>
                <span class="dlc-slider"></span>
              </label>
              <span class="dlc-toggle-label">GM <em>(always)</em></span>
            </div>
          </div>
        </div>

        <!-- Global Override -->
        <div class="dlc-mini-section dlc-mini-compact">
          <h4>Override</h4>
          <div class="dlc-role-toggles">
            <div class="dlc-toggle-row">
              <label class="dlc-switch">
                <input type="checkbox" class="dlc-override-manual" ${globalOverride === GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL ? 'checked' : ''}>
                <span class="dlc-slider"></span>
              </label>
              <span class="dlc-toggle-label">Manual</span>
            </div>
            <div class="dlc-toggle-row">
              <label class="dlc-switch">
                <input type="checkbox" class="dlc-override-digital" ${globalOverride === GLOBAL_OVERRIDE_MODES.FORCE_ALL_DIGITAL ? 'checked' : ''}>
                <span class="dlc-slider"></span>
              </label>
              <span class="dlc-toggle-label">Digital</span>
            </div>
          </div>
        </div>

        <!-- GM Mode -->
        <div class="dlc-mini-section dlc-mini-compact">
          <h4>Your Mode</h4>
          <div class="dlc-role-toggles">
            <div class="dlc-toggle-row">
              <label class="dlc-switch dlc-gm-mode-switch">
                <input type="checkbox" class="dlc-gm-mode-toggle" ${gmMode === PLAYER_MODES.MANUAL ? 'checked' : ''}>
                <span class="dlc-slider"></span>
              </label>
              <span class="dlc-toggle-label">${gmMode === PLAYER_MODES.MANUAL ? 'Manual' : 'Digital'}</span>
            </div>
            <button type="button" class="dlc-refresh-icon-btn dlc-refresh-btn" title="Refresh Panel" style="margin-top: 4px;">
              <i class="fas fa-sync-alt"></i>
            </button>
          </div>
          </div>
        </div>`, "dlc-top-section", "margin: 12px 12px 0 12px;")}

      <!-- Bottom Sections -->
      <div class="dlc-bottom-sections">
        ${pendingRequests.length > 0 ? `
          <!-- Pending Requests -->
          ${sectionHTML("pending", collapsedSections.pending, "fa-clock", `Pending Requests (${pendingRequests.length})`, `
              <div class="dlc-pending-list">
                ${pendingRequests.map(req => `
                  <div class="dlc-pending-item">
                    <span class="dlc-pending-name">${req.playerName}</span>
                    <div class="dlc-player-actions">
                      <button type="button" class="dlc-btn dlc-btn-sm dlc-btn-success dlc-panel-approve" data-player-id="${req.playerId}">
                        <i class="fas fa-check"></i> Approve
                      </button>
                      <button type="button" class="dlc-btn dlc-btn-sm dlc-btn-danger dlc-panel-deny" data-player-id="${req.playerId}">
                        <i class="fas fa-times"></i> Deny
                      </button>
                    </div>
                  </div>
                `).join('')}
              </div>`, "dlc-pending-section")}
        ` : ''}

        <!-- Player Modes -->
        ${sectionHTML("playerModes", collapsedSections.playerModes, "fa-users", "Player Modes", `
            ${modeLegendHTML(true)}
            ${players.length > 0 ? `
              <div class="dlc-players-grid">
                ${players.map(player => `
                  <div class="dlc-player-card${player.canRevoke ? ' dlc-player-card-revokable' : ''}">
                    ${playerInfoHTML(player)}
                    ${player.canRevoke ? `
                      <button type="button" class="dlc-revoke-corner dlc-panel-revoke" data-player-id="${player.id}" title="Revoke manual dice">
                        <i class="fas fa-times"></i>
                      </button>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            ` : '<p class="dlc-no-players">No players connected.</p>'}`)}

      </div>
    </div>
  `;
}

// ============================================================================
// PLAYER PANEL CONTENT
// ============================================================================

/**
 * Generate the complete player control panel
 * Shows: Player Modes (with request/switch buttons)
 */
function generatePlayerPanelContent() {
  const globalOverride = getGlobalOverride();
  const pendingRequests = getPendingRequests();
  const myMode = getPlayerMode();
  const myPending = pendingRequests.some(req => req.playerId === game.user.id);
  const collapsedSections = getCollapsedSections();

  // All users (including the GM) so everyone can see each other's modes
  const players = getPlayerModes(globalOverride, pendingRequests);

  const canRequest = !myPending && myMode === PLAYER_MODES.DIGITAL && overrideAllowsManualRequest(globalOverride);
  const canSwitchToDigital = myMode === PLAYER_MODES.MANUAL && overrideAllowsSwitchToDigital(globalOverride);
  
  const otherPlayers = players.filter(p => !p.isSelf);
  const selfPlayer = players.find(p => p.isSelf);

  return `
    <div class="dlc-panel dlc-player-panel">
      ${headerHTML()}

      <!-- Bottom Sections -->
      <div class="dlc-bottom-sections" style="padding-top: 12px;">
        <!-- Player Modes - Two Column Layout -->
        ${sectionHTML("playerModes", collapsedSections.playerModes, "fa-users", "Player Modes", `
            ${modeLegendHTML(false)}
            <div class="dlc-players-grid">
              ${canRequest ? `
                <button type="button" class="dlc-player-card dlc-player-action-card dlc-btn-success dlc-player-request">
                  <i class="fas fa-dice"></i> Request Manual
                </button>
              ` : ''}
              ${myPending ? `
                <div class="dlc-player-card dlc-player-pending-card">
                  <i class="fas fa-clock"></i> Awaiting GM
                </div>
              ` : ''}
              ${canSwitchToDigital ? `
                <button type="button" class="dlc-player-card dlc-player-action-card dlc-btn-secondary dlc-player-digital">
                  <i class="fas fa-desktop"></i> To Digital
                </button>
              ` : ''}
              ${selfPlayer ? `
                <div class="dlc-player-card dlc-player-card-self">
                  ${playerInfoHTML(selfPlayer, true)}
                </div>
              ` : ''}
              ${otherPlayers.map(player => `
                <div class="dlc-player-card">
                  ${playerInfoHTML(player)}
                </div>
              `).join('')}
            </div>
            ${globalOverride !== GLOBAL_OVERRIDE_MODES.INDIVIDUAL ? `
              <p class="dlc-no-players" style="margin-top: 10px;">
                <i class="fas fa-lock"></i> GM has set global override: ${globalOverride === GLOBAL_OVERRIDE_MODES.FORCE_ALL_MANUAL ? "All Manual" : "All Digital"}
              </p>
            ` : ''}`)}

      </div>
    </div>
  `;
}

/** The GM panel or the player panel. */
export function generatePanelContent(isGM) {
  return isGM ? generateGMPanelContent() : generatePlayerPanelContent();
}

