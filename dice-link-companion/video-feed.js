/**
 * video-feed.js - the players' dice clips over the Foundry screen. Each player's clip has
 * its own spot; the clip fades out when their roll ends; the dice sound plays while it
 * runs. Takes this player's own clip from DLA, shows it, and sends it as small pictures to
 * the other players allowed to see it; shows the other players' clips this player may see
 * (the rules are in clip-visibility.js).
 */

import { debug, debugCamera, debugError } from "./debug.js";
import { onDLAMessage } from "./qwebchannel-client.js";
import { emitToPlayers, onPlayerMessage } from "./socket.js";
import { clipGoesToOthers, clipShownToMe } from "./clip-visibility.js";
import { currentChatVisibility } from "./chat-log.js";

// ---- Each player's clip on screen ----
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

// Whose clip a frame belongs to: the given player, or this user
const _whose = (playerId) => playerId || game.user?.id || 'self';

// Take a player's clip off the screen now (and the overlay, once no clip is left)
function _dropStream(playerId) {
  const s = _streams.get(playerId);
  if (!s) return;
  s.canvas.remove();
  _streams.delete(playerId);
  if (_streams.size === 0 && _container) { _container.remove(); _container = null; }
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
function showDiceStreamFrame(frameB64, playerId) {
  playerId = _whose(playerId);
  const s = _getOrCreateStream(playerId);

  try {
    if (frameB64.startsWith('data:')) {
      // Network frame (WebP data URL from socket) - draw via an Image object.
      const img = new Image();
      img.onload = () => {
        if (s.canvas.width !== img.naturalWidth || s.canvas.height !== img.naturalHeight) {
          s.canvas.width = img.naturalWidth;
          s.canvas.height = img.naturalHeight;
        }
        // Clear first - frames are mostly transparent, and drawImage composites, so
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
      // Local frame (raw RGBA with a 4-byte header from QWebChannel) - putImageData.
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
 * Signal that a player's stream has ended - their clip fades out after a short pause.
 * The player keeps their spot (it is freed only on disconnect).
 * @param {string} [playerId]
 */
function endDiceStream(playerId) {
  playerId = _whose(playerId);
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
    if (_streams.get(playerId) === s) _dropStream(playerId);
  }, 500);
}

/**
 * Free a player's reserved spot (call on disconnect) and drop their clip if showing,
 * so the next (re)join fills the lowest empty spot rather than the next along.
 * @param {string} playerId
 */
function freeDiceStreamSlot(playerId) {
  const i = _slots.indexOf(playerId);
  if (i !== -1) _slots[i] = null;
  const s = _streams.get(playerId);
  if (s?.hideTimeout) clearTimeout(s.hideTimeout);
  _dropStream(playerId);
}

/**
 * Encode this player's own clip canvas to a WebP data: URL for broadcast, in the
 * background (off the main thread, via toBlob) so it doesn't block the roll
 * result reaching chat. Calls back with the data URL, or null if nothing to send.
 * @param {(dataUrl: string|null) => void} callback
 * @param {number} [quality]
 */
function encodeSelfStreamWebP(callback, quality = 0.9) {
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

// ---- This player's own clip, from DLA ----
//
// Who may see it (clip-visibility.js has the rules): the roll's own dialog may pick a
// "Roll Mode" for that one roll; by the time the clip starts, Foundry has replaced that
// dialog with the dice resolver, so dice-fulfillment.js notes it when the DLA button is
// pressed. Rolls without one use the chat visibility setting (the one DLA's Public /
// Whisper / Self only / GM only buttons set).
let rollClipVisibility = null;   // this roll's visibility from its dialog, if it had one
let clipActive = false;          // a clip is being sent right now
let clipVisibility = null;       // locked when each clip starts
let clipToOthers = true;         // whether this clip goes to the other players at all

// Guards a race from the off-thread (async) broadcast encode: the last frame or
// two can still be encoding when the stream ends, so without this flag they would
// be emitted after cameraStreamEnd and re-show the tray on other players with no
// further stop to clear it. Setting it on stream-end makes any in-flight straggler
// frame drop its broadcast, so cameraStreamEnd is always the last message sent.
let localBroadcastEnded = false;

/**
 * A roll's button was pressed in DLA: its clip follows the "Roll Mode" picked in its
 * dialog (null if it had none: the chat visibility then decides), and the next frame
 * starts a new clip.
 * @param {string|null} visibility - public / gm / blind / self
 */
export function setRollClipVisibility(visibility) {
  rollClipVisibility = visibility;
  clipActive = false;
}

/** The roll is over (its dice values came, or it was cancelled): its own Roll Mode no longer applies. */
export function clearRollClipVisibility() {
  rollClipVisibility = null;
}

/**
 * Take this player's clip from DLA: show it, and send it to the other players allowed to
 * see it. Show the other players' clips, and free a player's spot when they disconnect.
 * Called from main.mjs setup.
 */
export function setupDiceClips() {
  // Show the frame here, and send it to the other players' screens over Foundry's socket
  // (DLA only gives the clip to this screen; the socket message is how the others see it).
  onDLAMessage("cameraFrame", (frameB64) => {
    const uid = game.user.id;
    if (!clipActive) {
      // First frame of a new clip: lock who may see it for the whole clip.
      clipActive = true;
      clipVisibility = rollClipVisibility || currentChatVisibility();
      clipToOthers = clipGoesToOthers(clipVisibility, game.user.isGM);
      debug("Dice clip visibility", { visibility: clipVisibility || "public", rollerIsGM: game.user.isGM, sentToOthers: clipToOthers });
    }
    localBroadcastEnded = false;
    // Draw our own clip locally in our spot, then encode for broadcast away from the main
    // thread (async toBlob) so the roll result isn't held up behind the WebP encode.
    showDiceStreamFrame(frameB64, uid);
    if (!clipToOthers) return;   // Self only, or a DM's private roll: nobody else sees it
    encodeSelfStreamWebP((networkFrame) => {
      if (networkFrame && !localBroadcastEnded) {
        emitToPlayers({
          action: "cameraFrame", frameB64: networkFrame, userId: uid,
          visibility: clipVisibility, rollerIsGM: game.user.isGM
        });
      }
    });
  });

  onDLAMessage("cameraStreamEnd", () => {
    const uid = game.user.id;
    localBroadcastEnded = true;
    const wasSent = clipToOthers;
    clipActive = false;
    endDiceStream(uid);
    if (wasSent) emitToPlayers({ action: "cameraStreamEnd", userId: uid });
  });

  // Another player's clip. Private rolls: only the people allowed to see it draw it.
  onPlayerMessage("cameraFrame", (data) => {
    if (clipShownToMe(data.visibility, data.rollerIsGM, game.user.isGM)) {
      showDiceStreamFrame(data.frameB64, data.userId);
    }
  });
  onPlayerMessage("cameraStreamEnd", (data) => endDiceStream(data.userId));

  // Free a player's clip spot when they disconnect, so a reconnect fills the lowest gap.
  Hooks.on("userConnected", (user, connected) => {
    if (!connected) freeDiceStreamSlot(user.id);
  });
}
