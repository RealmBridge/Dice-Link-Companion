/**
 * Video Feed Module - dice-link-companion
 * Handles dice roll camera stream overlay on the Foundry canvas.
 */

import { REALM_BRIDGE_URL, LOGO_SQUARE_URL } from "./constants.js";
import { getCollapsedSections } from "./settings.js";

// ── Camera stream overlay ─────────────────────────────────────────────────────

let streamOverlay = null;
let streamImg = null;
let hideTimeout = null;
let rollingAudio = null;

/**
 * Display a single frame from the dice roll camera stream.
 * Creates the overlay on first call; updates the image on subsequent calls.
 * @param {string} frameB64 - Base64-encoded PNG frame
 */
export function showDiceStreamFrame(frameB64) {
  if (!streamOverlay) _createOverlay();
  if (streamImg) {
    streamImg.src = 'data:image/png;base64,' + frameB64;
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
  if (hideTimeout) clearTimeout(hideTimeout);
  hideTimeout = setTimeout(_removeOverlay, 2000);
  if (rollingAudio) {
    rollingAudio.pause();
    rollingAudio.currentTime = 0;
    rollingAudio = null;
  }
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

  streamImg = document.createElement('img');
  Object.assign(streamImg.style, {
    maxWidth: '50vw',
    maxHeight: '50vh',
    width: 'auto',
    height: 'auto'
  });

  streamOverlay.appendChild(streamImg);
  document.body.appendChild(streamOverlay);
}

function _removeOverlay() {
  if (streamOverlay) {
    streamOverlay.style.opacity = '0';
    setTimeout(() => {
      if (streamOverlay) {
        streamOverlay.remove();
        streamOverlay = null;
        streamImg = null;
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
