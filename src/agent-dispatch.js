import { normalizeAgentId } from "openclaw/plugin-sdk";
import { buildDispatchContext } from "./dispatch-context.js";
import { createFinalReplyDeliverer } from "./delivery-telemetry.js";
import { logger } from "./logger.js";
import { resolveAgentDispatchSession } from "./session-resolve.js";
import { agentContext } from "./state.js";

export { resolveAgentDispatchSession } from "./session-resolve.js";

export async function dispatchAgentTurn(params) {
  const {
    config,
    group,
    groupId,
    agentId,
    senderType,
    senderId,
    content,
    messageId,
    sessionKey,
    contextText,
    onFinalText,
    onError,
    onResult,
  } = params;
  const { core, ctxPayload } = buildDispatchContext({
    config,
    agentId,
    group,
    groupId,
    senderType,
    senderId,
    content,
    messageId,
    sessionKey,
    contextText,
  });
  const resolvedAgentId = normalizeAgentId(agentId);

  await agentContext.run(
    {
      agentId: resolvedAgentId,
      groupId,
      senderId,
    },
    async () => {
      const result = await core.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        replyOptions: {
          disableBlockStreaming: true,
        },
        dispatcherOptions: {
          deliver: createFinalReplyDeliverer({ onFinalText }),
          onError: async (err) => {
            if (onError) {
              await onError(err);
            }
            logger.error("Agents Conversation dispatch failed", {
              groupId,
              agentId: resolvedAgentId,
              error: err.message,
            });
          },
        },
      });
      if (onResult) {
        await onResult(result);
      }
    },
  );
}
