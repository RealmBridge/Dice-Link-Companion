/**
 * chat.js - the chat cards for a player's manual dice request: the GM's card with Approve /
 * Deny buttons, and the player's "request sent" card. The buttons are handled in approval.js.
 */

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
    whisper: game.users.filter(u => u.isGM).map(u => u.id)
  });

  const playerContent = `
    <div class="dice-link-result" style="border-left: 4px solid #7c3aed; padding: 10px;">
      <p>Your request for manual dice has been sent to the GM.</p>
    </div>
  `;

  await ChatMessage.create({
    content: playerContent,
    whisper: [playerId]
  });
}
