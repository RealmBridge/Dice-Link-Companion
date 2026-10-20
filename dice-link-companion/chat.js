/**
 * chat.js - DLC's chat cards for manual dice requests: the GM's card with Approve / Deny
 * buttons, the player's "request sent" card, and the "approved / denied" card. The
 * buttons are handled in approval.js.
 */

// The GMs' user IDs: the cards are whispered to them
const gmUserIds = () => game.users.filter(u => u.isGM).map(u => u.id);

// ============================================================================
// CHAT MESSAGE FUNCTIONS
// ============================================================================

/**
 * Create a chat message for a manual dice request
 * Sends approval buttons to GMs and confirmation to the requesting player
 */
export async function createRequestChatMessage(playerId, playerName) {
  const gmContent = `
    <div class="dice-link-request">
      <p><strong>${playerName}</strong> is requesting manual dice mode.</p>
      <div class="dlc-chat-buttons">
        <button type="button" class="dlc-chat-btn dlc-chat-approve" data-player-id="${playerId}">
          <i class="fas fa-check"></i> Approve
        </button>
        <button type="button" class="dlc-chat-btn dlc-chat-deny" data-player-id="${playerId}">
          <i class="fas fa-times"></i> Deny
        </button>
      </div>
    </div>
  `;

  await ChatMessage.create({
    content: gmContent,
    whisper: gmUserIds()
  });

  const playerContent = `
    <div class="dice-link-result dlc-result-sent">
      <p>Your request for manual dice has been sent to the GM.</p>
    </div>
  `;

  await ChatMessage.create({
    content: playerContent,
    whisper: [playerId]
  });
}

/**
 * Create a chat message showing approval/denial decision, for the player and the GMs
 */
export async function createApprovalChatMessage(playerId, playerName, approved) {
  const status = approved ? "APPROVED" : "DENIED";

  const content = `
    <div class="dice-link-result ${approved ? "dlc-result-approved" : "dlc-result-denied"}">
      <p><strong>${playerName}</strong>'s request for manual dice has been <strong class="dlc-result-status">${status}</strong>.</p>
    </div>
  `;

  await ChatMessage.create({
    content,
    whisper: [playerId, ...gmUserIds()]
  });
}
