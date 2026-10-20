/**
 * clip-visibility.js - who may see a player's dice clip (owner rules, 2026-10-17).
 * The rules only; video-feed.js asks them, sending this player's clip and showing the
 * other players' clips.
 *
 * The roll's visibility (Foundry v14 "messageMode", or the "Roll Mode" picked in the
 * roll's own dialog) decides who sees the clip:
 *
 *   Who rolls | Visibility          | Who sees the clip
 *   ----------+---------------------+------------------------------------------
 *   anyone    | public              | everyone
 *   player    | gm (Whisper)        | that player and the DM
 *   player    | blind (GM only)     | that player and the DM (a player always sees
 *             |                     | their own dice in the tray, so "blind" can't
 *             |                     | hide them - same as Whisper)
 *   player    | self (Self only)    | only that player
 *   DM        | gm / blind / self   | only the DM
 *
 * The roller always sees their own clip. Pure functions (no Foundry calls) so they can
 * be tested on their own. A clip message without a visibility (older sender) is shown
 * to everyone, as before.
 */

const NORMALISE = {
  public: "public", publicroll: "public", ic: "public",
  gm: "gm", gmroll: "gm",
  blind: "blind", blindroll: "blind",
  self: "self", selfroll: "self",
};

/** Map any Foundry roll/message mode name (v13 "gmroll", v14 "gm", ...) to one of
 *  public / gm / blind / self, or null if unknown. */
export function normaliseVisibility(mode) {
  return NORMALISE[String(mode ?? "").trim().toLowerCase()] || null;
}

/** Should the roller's add-on send the clip to the other players at all? */
export function clipGoesToOthers(visibility, rollerIsGM) {
  if (!visibility || visibility === "public") return true;
  if (visibility === "self") return false;
  if (rollerIsGM) return false;          // a DM's private roll: no clip for anyone else
  return true;                           // a player's gm/blind roll: sent, only DMs show it
}

/** Should THIS player's add-on show a clip it received from another player? */
export function clipShownToMe(visibility, rollerIsGM, iAmGM) {
  if (!visibility || visibility === "public") return true;
  if (visibility === "self" || rollerIsGM) return false;
  return !!iAmGM;                        // a player's gm/blind roll: DMs only
}
