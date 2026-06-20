/**
 * Break Manager
 * Handles GM-initiated session breaks: Foundry pause, overlay, player checklist.
 */

import { MODULE_ID } from "./constants.js";
import { debug } from "./debug.js";

let _breakOverlay = null;
let _breakTimer = null;
let _playerBackStatus = {};  // userId -> boolean
let _breakPlayers = [];      // ordered list, set in showBreakOverlay

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Called when DLA sends startBreak. GM-only path via setStartBreakCallback.
 */
export function handleStartBreak(data) {
    if (!game.user?.isGM) return;
    const durationMinutes = data.durationMinutes || 10;
    debug("handleStartBreak", { durationMinutes });

    // Pause Foundry for everyone (broadcast is Foundry's default behaviour)
    if (!game.paused) game.togglePause(true);

    // Build player list from currently active users
    const players = [...game.users]
        .filter(u => u.active)
        .map(u => ({ id: u.id, name: u.name }));

    // Broadcast break start to all clients via module socket
    game.socket.emit(`module.${MODULE_ID}`, {
        action: "breakStart",
        durationMinutes,
        players
    });

    // Show overlay on GM's own screen
    showBreakOverlay(durationMinutes, players);
}

/**
 * Show the break overlay. Called on every client via socket, and by GM directly.
 */
export function showBreakOverlay(durationMinutes, players) {
    endBreak(false);  // clean up any stale overlay without unpausing

    _breakPlayers = players;
    _playerBackStatus = {};
    for (const p of players) _playerBackStatus[p.id] = false;

    let remaining = durationMinutes * 60;

    _breakOverlay = document.createElement('div');
    _breakOverlay.id = 'dlc-break-overlay';
    _breakOverlay.innerHTML = _buildHTML(remaining, players);
    document.body.appendChild(_breakOverlay);

    // "I'm Back!" — marks self and broadcasts to all other clients
    _breakOverlay.querySelector('#dlc-break-back-btn')?.addEventListener('click', () => {
        markPlayerBack(game.user.id, true);
    });

    // GM-only "End Break" button
    if (game.user?.isGM) {
        _breakOverlay.querySelector('#dlc-break-end-btn')?.addEventListener('click', () => {
            game.socket.emit(`module.${MODULE_ID}`, { action: "breakEnd" });
            endBreak(true);
        });
    }

    // Countdown — GM ends break when timer reaches zero
    _breakTimer = setInterval(() => {
        remaining -= 1;
        const el = _breakOverlay?.querySelector('#dlc-break-countdown');
        if (el) el.textContent = _formatTime(remaining);
        if (remaining <= 0) {
            clearInterval(_breakTimer);
            _breakTimer = null;
            if (game.user?.isGM) {
                game.socket.emit(`module.${MODULE_ID}`, { action: "breakEnd" });
                endBreak(true);
            }
        }
    }, 1000);
}

/**
 * Mark a player as back and refresh the overlay checklist.
 * @param {string} userId
 * @param {boolean} isSelf - true only when this player is clicking their own button
 */
export function markPlayerBack(userId, isSelf = false) {
    _playerBackStatus[userId] = true;
    _refreshPlayerList();
    if (isSelf) {
        const btn = _breakOverlay?.querySelector('#dlc-break-back-btn');
        if (btn) { btn.disabled = true; btn.textContent = "See you soon! ☕"; }
        game.socket.emit(`module.${MODULE_ID}`, { action: "breakPlayerBack", userId });
    }
}

/**
 * Remove the break overlay and optionally unpause Foundry.
 * Only the GM should call with unpause=true.
 */
export function endBreak(unpause = true) {
    if (_breakTimer) { clearInterval(_breakTimer); _breakTimer = null; }
    if (_breakOverlay) { _breakOverlay.remove(); _breakOverlay = null; }
    _playerBackStatus = {};
    _breakPlayers = [];
    if (unpause && game.user?.isGM && game.paused) {
        game.togglePause(false);
    }
}

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

function _refreshPlayerList() {
    if (!_breakOverlay) return;
    const list = _breakOverlay.querySelector('#dlc-break-player-list');
    if (list) list.innerHTML = _buildPlayerListHTML();
}

function _buildPlayerListHTML() {
    return _breakPlayers.map(p => {
        const isBack = _playerBackStatus[p.id] === true;
        return `<div class="dlc-break-player ${isBack ? 'is-back' : ''}">
            <span class="dlc-break-player-indicator">${isBack ? '✓' : '…'}</span>
            <span class="dlc-break-player-name">${p.name}</span>
        </div>`;
    }).join('');
}

function _buildHTML(remaining, players) {
    const isGM = game.user?.isGM;
    const playerListHTML = players.map(p =>
        `<div class="dlc-break-player">
            <span class="dlc-break-player-indicator">…</span>
            <span class="dlc-break-player-name">${p.name}</span>
        </div>`
    ).join('');

    return `
        <div class="dlc-break-panel">
            <div class="dlc-break-title">☕ Break Time!</div>
            <div class="dlc-break-countdown" id="dlc-break-countdown">${_formatTime(remaining)}</div>
            <div class="dlc-break-players">
                <div class="dlc-break-players-label">Players</div>
                <div class="dlc-break-player-list" id="dlc-break-player-list">
                    ${playerListHTML}
                </div>
            </div>
            <div class="dlc-break-actions">
                <button id="dlc-break-back-btn" class="dlc-break-back-btn">I'm Back!</button>
                ${isGM ? '<button id="dlc-break-end-btn" class="dlc-break-end-btn">End Break</button>' : ''}
            </div>
        </div>
    `;
}

function _formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
