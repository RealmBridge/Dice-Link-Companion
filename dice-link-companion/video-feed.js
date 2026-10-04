/**
 * Video Feed Module - dice-link-companion
 * Handles dice roll camera stream overlay on the Foundry canvas.
 */

import { REALM_BRIDGE_URL, LOGO_SQUARE_URL } from "./constants.js";
import { getCollapsedSections } from "./settings.js";
import { debugCamera, debugError } from "./debug.js";

// ── Camera stream overlay (per-player, positioned) ────────────────────────────
//
// Each Dice Link player's clip shows in its own fixed spot so multiple rolls don't
// stack in the centre. Spots fill in priority order (top-left, bottom-left,
// top-centre, bottom-centre, top-right, bottom-right); a player keeps their spot for
// the session and it is freed only on disconnect (see freeDiceStreamSlot), so a
// reconnecting player drops into the lowest empty spot rather than the next along.

const SLOT_POSITIONS = [
  { top: '0', left: '0' },                                      // 0 top-left
  { bottom: '0', left: '0' },                                   // 1 bottom-left
  { top: '0', left: '50%', transform: 'translateX(-50%)' },     // 2 top-centre
  { bottom: '0', left: '50%', transform: 'translateX(-50%)' },  // 3 bottom-centre
  { top: '0', right: '0' },                                     // 4 top-right
  { bottom: '0', right: '0' },                                  // 5 bottom-right
];

let _container = null;                   // single full-screen overlay holding all clips
const _slots = new Array(6).fill(null);  // slot index -> playerId; persists until disconnect
const _streams = new Map();              // playerId -> { canvas, ctx, hideTimeout, frameCount, startTime, slot }
let rollingAudio = null;

function _ensureContainer() {
  if (_container) return _container;
  _container = document.createElement('div');
  _container.id = 'dlc-dice-stream';
  Object.assign(_container.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    background: 'transparent', border: 'none', zIndex: '9999',
    overflow: 'hidden', pointerEvents: 'none'
  });
  document.body.appendChild(_container);
  return _container;
}

// Lowest free spot in priority order; a player already placed keeps their spot.
function _assignSlot(playerId) {
  const existing = _slots.indexOf(playerId);
  if (existing !== -1) return existing;
  const free = _slots.indexOf(null);
  if (free !== -1) { _slots[free] = playerId; return free; }
  return 0; // more than 6 players rolling at once (rare): overflow onto the first spot
}

function _getOrCreateStream(playerId) {
  let s = _streams.get(playerId);
  if (s) return s;
  const slot = _assignSlot(playerId);
  _ensureContainer();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  Object.assign(canvas.style, {
    position: 'absolute', maxWidth: '32vw', maxHeight: '48vh',
    width: 'auto', height: 'auto', opacity: '1', transition: 'opacity 0.5s ease',
    ...SLOT_POSITIONS[slot]
  });
  _container.appendChild(canvas);
  s = { canvas, ctx, hideTimeout: null, frameCount: 0, startTime: null, slot };
  _streams.set(playerId, s);
  return s;
}

function _startRollingSound() {
  if (rollingAudio) return;
  const vol = game.settings.get("core", "globalInterfaceVolume") ?? 0.5;
  rollingAudio = new Audio("sounds/dice.wav");
  rollingAudio.loop = false;
  rollingAudio.volume = vol;
  rollingAudio.play().catch(() => { rollingAudio = null; });
}

/**
 * Display one camera-stream frame for a given player, drawn in that player's spot.
 * Frame is either a raw-RGBA frame with a 4-byte (width,height) header (local, from
 * DLA) or a WebP data: URL (received from another player over the socket).
 * @param {string} frameB64
 * @param {string} [playerId] - whose clip this is (defaults to the local user)
 */
export function showDiceStreamFrame(frameB64, playerId) {
  playerId = playerId || game.user?.id || 'self';
  const s = _getOrCreateStream(playerId);

  try {
    if (frameB64.startsWith('data:')) {
      // Network frame (WebP data URL from socket) — draw via an Image object.
      const img = new Image();
      img.onload = () => {
        if (s.canvas.width !== img.naturalWidth || s.canvas.height !== img.naturalHeight) {
          s.canvas.width = img.naturalWidth;
          s.canvas.height = img.naturalHeight;
        }
        // Clear first — frames are mostly transparent, and drawImage composites, so
        // without clearing, previous frames bleed through the see-through areas.
        s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
        s.ctx.drawImage(img, 0, 0);
      };
      img.onerror = (e) => debugError('[Camera] WebP frame decode error:', e);
      if (s.frameCount === 0) {
        s.startTime = performance.now();
        debugCamera('stream-start', { player: playerId, slot: s.slot, source: 'network' });
      }
      img.src = frameB64;
    } else {
      // Local frame (raw RGBA with a 4-byte header from QWebChannel) — putImageData.
      const binary = atob(frameB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const view = new DataView(bytes.buffer);
      const w = view.getUint16(0);
      const h = view.getUint16(2);

      if (s.frameCount === 0) {
        s.startTime = performance.now();
        debugCamera('stream-start', { player: playerId, slot: s.slot, width: w, height: h, source: 'local' });
      }

      if (s.canvas.width !== w || s.canvas.height !== h) { s.canvas.width = w; s.canvas.height = h; }
      const pixelData = new Uint8ClampedArray(bytes.buffer, 4);
      s.ctx.putImageData(new ImageData(pixelData, w, h), 0, 0);
    }
    s.frameCount++;
  } catch (e) {
    debugError('[Camera] Frame decode error:', e);
  }

  // Cancel this player's pending fade so the clip stays up while frames arrive.
  if (s.hideTimeout) { clearTimeout(s.hideTimeout); s.hideTimeout = null; s.canvas.style.opacity = '1'; }
  _startRollingSound();
}

/**
 * Signal that a player's stream has ended — their clip fades out after a short pause.
 * The player keeps their spot (it is freed only on disconnect).
 * @param {string} [playerId]
 */
export function endDiceStream(playerId) {
  playerId = playerId || game.user?.id || 'self';
  const s = _streams.get(playerId);
  if (!s) return;

  if (s.startTime !== null && s.frameCount > 0) {
    const elapsed = (performance.now() - s.startTime) / 1000;
    debugCamera('stream-end', { player: playerId, frames: s.frameCount, elapsed: elapsed.toFixed(2) + 's' });
  }
  s.frameCount = 0;
  s.startTime = null;

  if (s.hideTimeout) clearTimeout(s.hideTimeout);
  s.hideTimeout = setTimeout(() => _removeStream(playerId), 2000);

  if (rollingAudio) {
    rollingAudio.pause();
    rollingAudio.currentTime = 0;
    rollingAudio = null;
  }
}

function _removeStream(playerId) {
  const s = _streams.get(playerId);
  if (!s) return;
  s.hideTimeout = null;
  s.canvas.style.opacity = '0';
  setTimeout(() => {
    s.canvas.remove();
    _streams.delete(playerId);
    if (_streams.size === 0 && _container) { _container.remove(); _container = null; }
  }, 500);
}

/**
 * Free a player's reserved spot (call on disconnect) and drop their clip if showing,
 * so the next (re)join fills the lowest empty spot rather than the next along.
 * @param {string} playerId
 */
export function freeDiceStreamSlot(playerId) {
  const i = _slots.indexOf(playerId);
  if (i !== -1) _slots[i] = null;
  const s = _streams.get(playerId);
  if (s) {
    if (s.hideTimeout) clearTimeout(s.hideTimeout);
    s.canvas.remove();
    _streams.delete(playerId);
    if (_streams.size === 0 && _container) { _container.remove(); _container = null; }
  }
}

/**
 * Encode the LOCAL player's current clip canvas to a WebP data: URL for broadcast,
 * ASYNCHRONOUSLY (off the main thread, via toBlob) so it doesn't block the roll
 * result reaching chat. Calls back with the data URL, or null if nothing to send.
 * @param {(dataUrl: string|null) => void} callback
 * @param {number} [quality]
 */
export function encodeSelfStreamWebP(callback, quality = 0.9) {
  const s = _streams.get(game.user?.id);
  if (!s || !s.canvas || !s.canvas.width || !s.canvas.height) { callback(null); return; }
  try {
    s.canvas.toBlob((blob) => {
      if (!blob) { callback(null); return; }
      const reader = new FileReader();
      reader.onload = () => callback(reader.result);
      reader.onerror = () => callback(null);
      reader.readAsDataURL(blob);
    }, 'image/webp', quality);
  } catch (e) {
    debugError('[Camera] WebP encode error:', e);
    callback(null);
  }
}

/**
 * Generate the video feed section HTML
 * Used by both GM and Player panels
 * @returns {string} HTML string for the video feed section
 */
export function generateVideoFeedSection() {
  const collapsedSections = getCollapsedSections();

  return `
    <!-- Video Feed Placeholder -->
    <div class="dlc-section ${collapsedSections.videoFeed ? 'collapsed' : ''}">
      <div class="dlc-section-header" data-section="videoFeed">
        <span class="dlc-collapse-btn">${collapsedSections.videoFeed ? '+' : '−'}</span>
        <h3><i class="fas fa-video"></i> Video Feed</h3>
      </div>
      <div class="dlc-section-content">
        <div class="dlc-video-feed">
          <div class="dlc-video-grid">
            <div class="dlc-video-cell"><span class="dlc-video-placeholder">Coming Soon</span></div>
            <div class="dlc-video-cell"><span class="dlc-video-placeholder">Future Feature</span></div>
            <div class="dlc-video-cell"><span class="dlc-video-placeholder">Stay Tuned</span></div>
            <div class="dlc-video-cell">
              <a href="${REALM_BRIDGE_URL}" target="_blank" class="dlc-video-logo-link" title="Visit Realm Bridge">
                <img src="${LOGO_SQUARE_URL}" alt="Realm Bridge" class="dlc-video-logo" onerror="this.parentElement.innerHTML='<span class=dlc-video-placeholder>Realm Bridge</span>'">
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
