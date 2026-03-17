import { KeyedAsyncQueue } from "openclaw/plugin-sdk";
import { normalizeAgentId } from "openclaw/plugin-sdk";
import { dispatchAgentTurn, resolveAgentDispatchSession } from "./agent-dispatch.js";
import { reingestFinalReply } from "./final-reingest.js";
import { appendGroupMessage, buildContextText } from "./group-manager.js";
import { logger } from "./logger.js";
import { ensureGroup, getChannelConfig } from "./state.js";

const dispatchQueue = new KeyedAsyncQueue();
const groupThrottleState = new Map();

const DEFAULT_GROUP_ID = "default";

function buildDispatchQueueKey({ agentId, groupId }) {
  return `${normalizeAgentId(agentId)}::${String(groupId ?? "").trim().toLowerCase() || DEFAULT_GROUP_ID}`;
}

function getMaxDepth(config) {
  const cfg = getChannelConfig(config);
  return cfg.maxDepth ?? 4;
}

function getMaxConcurrentDispatchesPerGroup(config) {
  const cfg = getChannelConfig(config);
  const raw = Number(cfg.maxConcurrentDispatchesPerGroup);
  if (!Number.isFinite(raw) || raw < 1) {
    return 1;
  }
  return Math.max(1, Math.floor(raw));
}

function shouldRelayAgentReplies(config) {
  const cfg = getChannelConfig(config);
  if (typeof cfg.relayAgentReplies === "boolean") {
    return cfg.relayAgentReplies;
  }
  return true;
}

function listRecipientAgents({ group, senderId }) {
  const sender = normalizeAgentId(senderId);
  return Array.from(group.agents).filter((id) => normalizeAgentId(id) !== sender);
}

function getRemainingRelayRounds(group) {
  return Math.max(0, group.maxRelayRounds - group.relayRoundsUsed);
}

function shouldInjectConvergenceHint(group) {
  if (group.maxRelayRounds <= 0) {
    return false;
  }
  const remainingRatio = getRemainingRelayRounds(group) / group.maxRelayRounds;
  return remainingRatio < group.convergenceWarningRatio;
}

function buildForwardContent({ content, group }) {
  if (!shouldInjectConvergenceHint(group)) {
    return content;
  }

  const remainingRounds = getRemainingRelayRounds(group);
  return [
    String(content ?? ""),
    "",
    `[Hint: Budget low (${remainingRounds}/${group.maxRelayRounds}). Converge and finish.]`,
  ].join("\n");
}

async function dispatchGroupEventToAgent({
  config,
  group,
  groupId,
  agentId,
  senderType,
  senderId,
  content,
  depth,
  messageId,
}) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const { route, sessionKey } = resolveAgentDispatchSession({
    config,
    agentId: normalizedAgentId,
    groupId,
  });
  const contextText = buildContextText({ config, groupId, excludeMessageId: messageId });

  group.lastDeliveredTurn = {
    at: Date.now(),
    agentId: normalizedAgentId,
    senderId,
    depth,
    messageId,
    sessionKey,
    routeMatchedBy: route?.matchedBy ?? null,
    routeAgentId: route?.agentId ?? null,
  };
  group.lastDeliveryError = null;
  group.lastDeliveryResult = {
    at: Date.now(),
    agentId: normalizedAgentId,
    queuedFinal: null,
    finalReplies: null,
    blockReplies: null,
    hadFinalText: false,
    finalTextLength: 0,
  };

  logger.info("Agents Conversation dispatch start", {
    groupId,
    agentId: normalizedAgentId,
    senderId,
    depth,
    messageId,
    sessionKey,
    routeMatchedBy: route?.matchedBy ?? null,
    routeAgentId: route?.agentId ?? null,
  });

  await dispatchAgentTurn({
    config,
    group,
    groupId,
    agentId: normalizedAgentId,
    senderType,
    senderId,
    content,
    messageId,
    sessionKey,
    contextText,
    onFinalText: async (replyText) => {
      await reingestFinalReply({
        config,
        group,
        groupId,
        agentId: normalizedAgentId,
        replyText,
        depth,
        messageId,
        reingestMessage: ingestGroupMessage,
      });
    },
    onError: async (err) => {
      group.lastDeliveryError = {
        at: Date.now(),
        agentId: normalizedAgentId,
        error: err.message,
      };
    },
    onResult: async (result) => {
      group.lastDeliveryResult = {
        at: Date.now(),
        agentId: normalizedAgentId,
        queuedFinal: result?.queuedFinal ?? null,
        finalReplies: result?.counts?.final ?? null,
        blockReplies: result?.counts?.block ?? null,
        hadFinalText: group.lastDeliveryResult?.hadFinalText ?? false,
        finalTextLength: group.lastDeliveryResult?.finalTextLength ?? 0,
      };
      logger.info("Agents Conversation dispatch complete", {
        groupId,
        agentId: normalizedAgentId,
        queuedFinal: result?.queuedFinal,
        finalReplies: result?.counts?.final,
      });
    },
  });
}

function normalizeGroupThrottleKey(groupId) {
  return String(groupId ?? "").trim().toLowerCase() || DEFAULT_GROUP_ID;
}

async function acquireGroupDispatchSlot({ config, groupId }) {
  const key = normalizeGroupThrottleKey(groupId);
  const limit = getMaxConcurrentDispatchesPerGroup(config);
  const state = groupThrottleState.get(key) ?? {
    active: 0,
    waiters: [],
  };
  groupThrottleState.set(key, state);

  while (state.active >= limit) {
    await new Promise((resolve) => {
      state.waiters.push(resolve);
    });
  }

  state.active += 1;
  return { key, state };
}

function releaseGroupDispatchSlot({ key, state }) {
  state.active = Math.max(0, state.active - 1);
  const next = state.waiters.shift();
  if (next) {
    next();
  }
  if (state.active === 0 && state.waiters.length === 0) {
    groupThrottleState.delete(key);
  }
}

function scheduleAgentTurn(params) {
  const queueKey = buildDispatchQueueKey({
    agentId: params.agentId,
    groupId: params.groupId,
  });

  // This queue is a session-safety boundary, not a reply policy layer.
  // The plugin forwards each group event to eligible participants, while the
  // agent runtime decides whether the turn should produce a reply.
  void dispatchQueue
    .enqueue(queueKey, async () => {
      const slot = await acquireGroupDispatchSlot({
        config: params.config,
        groupId: params.groupId,
      });

      const group = ensureGroup(params.groupId, params.config);
      try {
        if (group.ended) {
          logger.info("Agents Conversation group ended; skipping queued dispatch", {
            groupId: params.groupId,
            agentId: params.agentId,
          });
          return;
        }
        await dispatchGroupEventToAgent({ ...params, group });
      } finally {
        releaseGroupDispatchSlot(slot);
      }
    })
    .catch((err) => {
      logger.error("Agents Conversation queued dispatch failed", {
        groupId: params.groupId,
        agentId: params.agentId,
        error: err.message,
      });
    });
}

export async function ingestGroupMessage({
  config,
  groupId,
  senderType,
  senderId,
  content,
  depth = 0,
  metadata,
}) {
  const maxDepth = getMaxDepth(config);
  const group = ensureGroup(groupId, config);
  group.lastIngest = {
    at: Date.now(),
    senderType,
    senderId,
    depth,
  };

  logger.info("Agents Conversation ingest", {
    groupId,
    senderType,
    senderId,
    depth,
    maxDepth,
  });

  const message = appendGroupMessage({
    config,
    groupId,
    senderType,
    senderId,
    content,
    depth,
    metadata,
  });

  if (depth >= maxDepth) {
    logger.warn("Group message depth limit reached", {
      groupId,
      depth,
      maxDepth,
    });
    return message;
  }

  if (group.ended) {
    return message;
  }

  if (senderType === "agent" && !shouldRelayAgentReplies(config)) {
    logger.info("Agents Conversation skipping recursive agent relay", {
      groupId,
      senderId,
      depth,
    });
    return message;
  }

  // Delivery stays intentionally broad: every other participant receives the
  // group event as a normal inbound user turn with group metadata attached.
  // Whether to answer remains an agent-level decision.
  const agents = listRecipientAgents({
    group,
    senderId,
  });

  if (agents.length === 0) {
    return message;
  }

  if (group.relayRoundsUsed >= group.maxRelayRounds) {
    group.ended = true;
    logger.warn("Agents Conversation relay round budget exhausted", {
      groupId,
      senderId,
      senderType,
      relayRoundsUsed: group.relayRoundsUsed,
      maxRelayRounds: group.maxRelayRounds,
      totalDispatchBudget: group.totalDispatchBudget,
      relayFanout: group.relayFanout,
    });
    return message;
  }

  group.relayRoundsUsed += 1;

  logger.info("Agents Conversation routing", {
    groupId,
    senderId,
    senderType,
    agents,
    relayRoundsUsed: group.relayRoundsUsed,
    remainingRelayRounds: getRemainingRelayRounds(group),
    maxRelayRounds: group.maxRelayRounds,
  });

  for (const agentId of agents) {
    scheduleAgentTurn({
      config,
      groupId,
      agentId,
      senderType,
      senderId,
      content: buildForwardContent({ content, group }),
      depth,
      messageId: message.id,
    });
  }

  return message;
}
