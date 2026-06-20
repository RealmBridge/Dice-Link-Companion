/**
 * Break Manager
 * Handles GM-initiated session breaks: Foundry pause, draggable window, player checklist.
 */

import { MODULE_ID } from "./constants.js";
import { debug } from "./debug.js";

const { ApplicationV2 } = foundry.applications.api;

let _breakApp = null;

// ============================================================================
// APPLICATION
// ============================================================================

class BreakOverlayApp extends ApplicationV2 {
    #players = [];
    #playerBackStatus = {};
    #remaining = 0;
    #timer = null;

    static DEFAULT_OPTIONS = {
        id: "dlc-break-overlay",
        classes: ["dlc-break-app"],
        window: {
            title: "Session is on a break",
            resizable: false,
            minimizable: false,
        },
        position: { width: 304, height: "auto" }
    };

    init(durationMinutes, players) {
        this.#players = players;
        this.#playerBackStatus = {};
        for (const p of players) this.#playerBackStatus[p.id] = false;
        this.#remaining = durationMinutes * 60;
    }

    async _prepareContext(options) { return {}; }

    async _renderHTML(context, options) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = this.#buildHTML();
        return wrapper;
    }

    _replaceHTML(result, content, options) {
        content.replaceChildren(result);
    }

    async _onFirstRender(context, options) {
        await super._onFirstRender(context, options);
        const header = this.element?.querySelector('.window-header');
        if (header && !header.querySelector('.dlc-break-title-logo')) {
            const img = document.createElement('img');
            img.src = `modules/${MODULE_ID}/assets/DL_Logo_No_Background_small.ico`;
            img.className = 'dlc-break-title-logo';
            header.prepend(img);
        }
    }

    _onRender(context, options) {
        const el = this.element;

        el.querySelector('#dlc-break-back-btn')?.addEventListener('click', () => {
            markPlayerBack(game.user.id, true);
        });
        el.querySelector('#dlc-break-away-btn')?.addEventListener('click', () => {
            markPlayerAway(game.user.id, true);
        });
        if (game.user?.isGM) {
            el.querySelector('#dlc-break-end-btn')?.addEventListener('click', () => {
                game.socket.emit(`module.${MODULE_ID}`, { action: "breakEnd" });
                endBreak(true);
            });
        }

        if (!this.#timer) this.#startTimer();
        this.#refreshSelfButtons();
    }

    async close(options = {}) {
        this.stopTimer();
        if (_breakApp === this) _breakApp = null;
        return super.close(options);
    }

    stopTimer() {
        if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    }

    setPlayerBack(userId) {
        this.#playerBackStatus[userId] = true;
        this.#refreshPlayerList();
        if (userId === game.user.id) this.#refreshSelfButtons();
    }

    setPlayerAway(userId) {
        this.#playerBackStatus[userId] = false;
        this.#refreshPlayerList();
        if (userId === game.user.id) this.#refreshSelfButtons();
    }

    #startTimer() {
        this.#timer = setInterval(() => {
            this.#remaining -= 1;
            const el = this.element?.querySelector('#dlc-break-countdown');
            if (this.#remaining <= 0) {
                clearInterval(this.#timer);
                this.#timer = null;
                if (el) {
                    el.textContent = 'BREAK OVER';
                    el.classList.add('break-over');
                    el.style.fontSize = '55px';
                    el.style.whiteSpace = 'nowrap';
                }
            } else {
                if (el) el.textContent = _formatTime(this.#remaining);
            }
        }, 1000);
    }

    #refreshPlayerList() {
        const list = this.element?.querySelector('#dlc-break-player-list');
        if (list) list.innerHTML = this.#buildPlayerListHTML();
    }

    #refreshSelfButtons() {
        const isBack = this.#playerBackStatus[game.user.id] === true;
        const backBtn = this.element?.querySelector('#dlc-break-back-btn');
        const awayBtn = this.element?.querySelector('#dlc-break-away-btn');
        if (backBtn) backBtn.disabled = isBack;
        if (awayBtn) awayBtn.disabled = !isBack;
    }

    #buildPlayerListHTML() {
        return this.#players.map(p => {
            const isBack = this.#playerBackStatus[p.id] === true;
            return `<div class="dlc-break-player ${isBack ? 'is-back' : ''}">
                <span class="dlc-break-player-name">${p.name}</span>
            </div>`;
        }).join('');
    }

    #buildHTML() {
        const isGM = game.user?.isGM;
        const playerListHTML = this.#buildPlayerListHTML();

        return `
            <div class="dlc-break-panel">
                <div class="dlc-break-countdown" id="dlc-break-countdown">${_formatTime(this.#remaining)}</div>
                <div class="dlc-break-players">
                    <div class="dlc-break-players-label">Players</div>
                    <div class="dlc-break-player-list" id="dlc-break-player-list">
                        ${playerListHTML}
                    </div>
                </div>
                <div class="dlc-break-status-actions">
                    <button id="dlc-break-back-btn" class="dlc-break-back-btn">I'm Back!</button>
                    <button id="dlc-break-away-btn" class="dlc-break-away-btn" disabled>Step Away</button>
                </div>
                ${isGM ? '<button id="dlc-break-end-btn" class="dlc-break-end-btn">End Break</button>' : ''}
            </div>
        `;
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

export function handleStartBreak(data) {
    if (!game.user?.isGM) return;
    const durationMinutes = data.durationMinutes || 10;
    debug("handleStartBreak", { durationMinutes });

    if (!game.paused) game.togglePause(true, { broadcast: true });

    const players = [...game.users]
        .filter(u => u.active)
        .map(u => ({ id: u.id, name: u.name }));

    game.socket.emit(`module.${MODULE_ID}`, {
        action: "breakStart",
        durationMinutes,
        players
    });

    showBreakOverlay(durationMinutes, players);
}

export function showBreakOverlay(durationMinutes, players) {
    endBreak(false);

    _breakApp = new BreakOverlayApp();
    _breakApp.init(durationMinutes, players);
    _breakApp.render(true);
}

export function markPlayerBack(userId, isSelf = false) {
    _breakApp?.setPlayerBack(userId);
    if (isSelf) {
        game.socket.emit(`module.${MODULE_ID}`, { action: "breakPlayerBack", userId });
    }
}

export function markPlayerAway(userId, isSelf = false) {
    _breakApp?.setPlayerAway(userId);
    if (isSelf) {
        game.socket.emit(`module.${MODULE_ID}`, { action: "breakPlayerAway", userId });
    }
}

export function endBreak(unpause = true) {
    if (_breakApp) {
        _breakApp.stopTimer();
        _breakApp.close({ force: true });
        _breakApp = null;
    }
    if (unpause && game.user?.isGM && game.paused) {
        game.togglePause(false, { broadcast: true });
    }
}

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

function _formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
