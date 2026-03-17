export async function reingestFinalReply({
  config,
  group,
  groupId,
  agentId,
  replyText,
  depth,
  messageId,
  reingestMessage,
}) {
  group.lastReingestedFinal = {
    at: Date.now(),
    agentId,
    senderId: agentId,
    depth: depth + 1,
    messageId,
  };
  group.lastDeliveryResult = {
    ...group.lastDeliveryResult,
    hadFinalText: true,
    finalTextLength: replyText.length,
  };

  await reingestMessage({
    config,
    groupId,
    senderType: "agent",
    senderId: agentId,
    content: replyText,
    depth: depth + 1,
    metadata: {
      source: "agent-dispatch",
      replyToMessageId: messageId,
    },
  });
}
