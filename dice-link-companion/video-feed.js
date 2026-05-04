/**
 * Video Feed Module - dice-link-companion
 * Handles dice roll camera stream overlay on the Foundry canvas.
 */

import { REALM_BRIDGE_URL, LOGO_SQUARE_URL } from "./constants.js";
import { getCollapsedSections } from "./settings.js";
import { debugCamera, debugError } from "./debug.js";

// ── Camera stream overlay ─────────────────────────────────────────────────────

let streamOverlay = null;
let streamCanvas = null;
let streamCtx = null;
let hideTimeout = null;
let rollingAudio = null;

let _streamFrameCount = 0;
let _streamStartTime = null;

/**
 * Display a single raw-RGBA frame from the dice roll camera stream.
 * Frame format: 4-byte big-endian header (uint16 width, uint16 height) + raw RGBA bytes.
 * Creates the overlay on first call; updates the canvas on subsequent calls.
 * @param {string} frameB64 - Base64-encoded raw RGBA frame with header
 */
export function showDiceStreamFrame(frameB64) {
  if (!streamOverlay) _createOverlay();

  try {
    if (frameB64.startsWith('data:')) {
      // Network frame (WebP data URL from socket) — draw via Image object
      const img = new Image();
      img.onload = () => {
        if (streamCanvas.width !== img.naturalWidth || streamCanvas.height !== img.naturalHeight) {
          streamCanvas.width = img.naturalWidth;
          streamCanvas.height = img.naturalHeight;
        }
        streamCtx.drawImage(img, 0, 0);
      };
      img.onerror = (e) => debugError('[Camera] WebP frame decode error:', e);
      if (_streamFrameCount === 0) {
        _streamStartTime = performance.now();
        debugCamera('stream-start', { source: 'network', format: 'webp' });
      }
      img.src = frameB64;
    } else {
      // Local frame (raw RGBA with 4-byte header from QWebChannel) — putImageData
      const binary = atob(frameB64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const view = new DataView(bytes.buffer);
      const w = view.getUint16(0);
      const h = view.getUint16(2);

      if (_streamFrameCount === 0) {
        _streamStartTime = performance.now();
        debugCamera('stream-start', { width: w, height: h, source: 'local' });
      }

      if (streamCanvas.width !== w || streamCanvas.height !== h) {
        streamCanvas.width = w;
        streamCanvas.height = h;
      }

      const pixelData = new Uint8ClampedArray(bytes.buffer, 4);
      streamCtx.putImageData(new ImageData(pixelData, w, h), 0, 0);
    }
    _streamFrameCount++;
  } catch (e) {
    debugError('[Camera] Frame decode error:', e);
  }

  // Cancel any pending hide so the overlay stays up while frames are arriving
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
    if (streamOverlay) streamOverlay.style.opacity = '1';
  }

  // Start rolling sound on first frame of each roll
  if (!rollingAudio) {
    const vol = game.settings.get("core", "globalInterfaceVolume") ?? 0.5;
    rollingAudio = new Audio("sounds/dice.wav");
    rollingAudio.loop = false;
    rollingAudio.volume = vol;
    rollingAudio.play().catch(() => {});
  }
}

/**
 * Signal that the stream has ended — overlay fades out after a short pause.
 */
export function endDiceStream() {
  if (_streamStartTime !== null && _streamFrameCount > 0) {
    const elapsed = (performance.now() - _streamStartTime) / 1000;
    const fps = _streamFrameCount / elapsed;
    debugCamera('stream-end', {
      frames: _streamFrameCount,
      elapsed: elapsed.toFixed(2) + 's',
      fps: fps.toFixed(1)
    });
  }
  _streamFrameCount = 0;
  _streamStartTime = null;

  if (hideTimeout) clearTimeout(hideTimeout);
  hideTimeout = setTimeout(_removeOverlay, 2000);
  if (rollingAudio) {
    rollingAudio.pause();
    rollingAudio.currentTime = 0;
    rollingAudio = null;
  }
}

/**
 * Re-encode the current stream canvas as a WebP data URL for network broadcast.
 * Called immediately after showDiceStreamFrame draws locally, so the canvas is current.
 * @param {number} quality - WebP quality 0–1 (default 0.9)
 * @returns {string|null} WebP data URL, or null if no canvas exists yet
 */
export function getStreamCanvasWebP(quality = 0.9) {
  if (!streamCanvas) return null;
  return streamCanvas.toDataURL('image/webp', quality);
}

function _createOverlay() {
  streamOverlay = document.createElement('div');
  streamOverlay.id = 'dlc-dice-stream';
  Object.assign(streamOverlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    background: 'transparent',
    border: 'none',
    zIndex: '9999',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    pointerEvents: 'none',
    transition: 'opacity 0.5s ease'
  });

  streamCanvas = document.createElement('canvas');
  streamCtx = streamCanvas.getContext('2d');
  Object.assign(streamCanvas.style, {
    maxWidth: '50vw',
    maxHeight: '50vh',
    width: 'auto',
    height: 'auto'
  });

  streamOverlay.appendChild(streamCanvas);
  document.body.appendChild(streamOverlay);
}

function _removeOverlay() {
  if (streamOverlay) {
    streamOverlay.style.opacity = '0';
    setTimeout(() => {
      if (streamOverlay) {
        streamOverlay.remove();
        streamOverlay = null;
        streamCanvas = null;
        streamCtx = null;
      }
    }, 500);
  }
  hideTimeout = null;
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
