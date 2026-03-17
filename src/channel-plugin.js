import { normalizeAgentId } from "openclaw/plugin-sdk";
import { logger } from "./logger.js";
import { agentContext, getOpenclawConfig } from "./state.js";
import { listGroups } from "./group-manager.js";
import { ingestGroupMessage } from "./orchestrator.js";

const DEFAULT_GROUP_ID = "default";
const DEFAULT_ACCOUNT_ID = "default";
const TARGET_PREFIX = "agents-conversation:";

function parseTarget(to) {
  const raw = String(to ?? "");
  const cleaned = raw.replace(new RegExp(`^${TARGET_PREFIX}`), "");
  const normalized = cleaned.replace(/^group:/i, "");
  const [groupId, senderId] = normalized.split("@");
  return {
    groupId: groupId || DEFAULT_GROUP_ID,
    senderId: senderId ? senderId.trim() : null,
  };
}

function normalizeTarget(to) {
  return parseTarget(to).groupId;
}

function looksLikeGroupId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const cleaned = raw.replace(new RegExp(`^${TARGET_PREFIX}`), "");
  const normalized = cleaned.replace(/^group:/i, "");
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalized);
}

function formatPayloadText(payload) {
  const text = payload.text || "";
  const mediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
  if (mediaUrls.length === 0) {
    return text;
  }
  const mediaLines = mediaUrls.map((url) => `MEDIA: ${url}`);
  return text ? `${text}\n\n${mediaLines.join("\n")}` : mediaLines.join("\n");
}

export const localGroupChannelPlugin = {
  id: "agents-conversation",
  meta: {
    id: "agents-conversation",
    label: "Agents Conversation",
    selectionLabel: "Agents Conversation",
    docsPath: "/channels/agents-conversation",
    blurb: "Local multi-agent hub channel.",
  },
  capabilities: {
    chatTypes: ["group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.agents-conversation"] },
  configSchema: {
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
          description: "Enable Agents Conversation channel",
          default: true,
        },
        port: {
          type: "integer",
          description: "Dedicated local UI port",
          default: 29080,
          minimum: 1,
          maximum: 65535,
        },
        bind: {
          type: "string",
          description: "Bind address for the local UI server",
          default: "127.0.0.1",
        },
        unsafeAllowRemoteWrite: {
          type: "boolean",
          description:
            "Allow write operations when the local server is bound to a non-loopback address. Disabled by default.",
          default: false,
        },
        maxMessages: {
          type: "integer",
          description: "Max messages to keep per group",
          default: 200,
          minimum: 10,
        },
        contextWindow: {
          type: "integer",
          description: "How many recent messages to include in agent context",
          default: 40,
          minimum: 5,
        },
        totalDispatchBudget: {
          type: "integer",
          description:
            "Total dispatch budget per group before it is auto-ended. Actual relay rounds are budget / (agentCount - 1).",
          default: 100,
          minimum: 1,
        },
        convergenceWarningRatio: {
          type: "number",
          description:
            "Inject a convergence hint once remaining relay rounds drop below this fraction of the group budget.",
          default: 0.1,
          exclusiveMinimum: 0,
          maximum: 1,
        },
        includeContext: {
          type: "boolean",
          description: "Include recent context when dispatching to agents",
          default: false,
        },
        availableAgents: {
          type: "array",
          description: "Agents that can be invited into newly created groups",
          items: { type: "string" },
        },
        maxDepth: {
          type: "integer",
          description: "Maximum relay depth to prevent runaway loops",
          default: 4,
          minimum: 1,
        },
        relayAgentReplies: {
          type: "boolean",
          description:
            "When false, agent final replies are not re-dispatched to other agents in the group.",
          default: true,
        },
        maxConcurrentDispatchesPerGroup: {
          type: "integer",
          description:
            "Maximum number of agent dispatches allowed to run concurrently for the same group. Keep low to avoid provider bursts.",
          default: 1,
          minimum: 1,
        },
      },
    },
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (_cfg, accountId) => ({
      accountId: accountId ?? DEFAULT_ACCOUNT_ID,
      enabled: true,
      configured: true,
    }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: () => true,
  },
  messaging: {
    normalizeTarget,
    targetResolver: {
      looksLikeId: looksLikeGroupId,
      hint: "<groupId|agents-conversation:groupId[@agentId]>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => listGroups(getOpenclawConfig()),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text, senderId: explicitSenderId, metadata }) => {
      const ctx = agentContext.getStore();
      if (!ctx?.agentId) {
        throw new Error(
          "Agents Conversation outbound send is restricted to agent replies. Use the local HTTP API instead.",
        );
      }

      const { groupId, senderId: targetSenderId } = parseTarget(to);
      const senderId = explicitSenderId ?? metadata?.senderId ?? targetSenderId ?? ctx.agentId;
      if (!senderId) {
        throw new Error("Missing senderId for Agents Conversation outbound send.");
      }
      if (normalizeAgentId(senderId) !== normalizeAgentId(ctx.agentId)) {
        throw new Error("Agents Conversation outbound send senderId must match agent context.");
      }

      const content = String(text ?? "");
      if (!content) {
        throw new Error("Agents Conversation outbound send requires text.");
      }

      logger.info("Agents Conversation outbound send", {
        groupId,
        senderId,
        senderType: "agent",
      });

      await ingestGroupMessage({
        config: cfg,
        groupId,
        senderType: "agent",
        senderId,
        content,
        depth: 0,
        metadata,
      });

      return {
        channel: "agents-conversation",
        messageId: `msg_${Date.now()}`,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, senderId: explicitSenderId, metadata }) => {
      const ctx = agentContext.getStore();
      if (!ctx?.agentId) {
        throw new Error(
          "Agents Conversation outbound send is restricted to agent replies. Use the local HTTP API instead.",
        );
      }

      const { groupId, senderId: targetSenderId } = parseTarget(to);
      const senderId = explicitSenderId ?? metadata?.senderId ?? targetSenderId ?? ctx.agentId;
      if (!senderId) {
        throw new Error("Missing senderId for Agents Conversation outbound send.");
      }
      if (normalizeAgentId(senderId) !== normalizeAgentId(ctx.agentId)) {
        throw new Error("Agents Conversation outbound send senderId must match agent context.");
      }

      const content = formatPayloadText({
        text: String(text ?? ""),
        mediaUrls: mediaUrl ? [mediaUrl] : [],
      });
      if (!content) {
        throw new Error("Agents Conversation outbound send requires text or media.");
      }

      logger.info("Agents Conversation outbound send media", {
        groupId,
        senderId,
        senderType: "agent",
      });

      await ingestGroupMessage({
        config: cfg,
        groupId,
        senderType: "agent",
        senderId,
        content,
        depth: 0,
        metadata,
      });

      return {
        channel: "agents-conversation",
        messageId: `msg_${Date.now()}`,
      };
    },
  },
};

export { ingestGroupMessage };
