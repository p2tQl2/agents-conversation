import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "openclaw/plugin-sdk";
import { logger } from "./logger.js";
import { agentContext, ensureGroup, getRuntime, getOpenclawConfig } from "./state.js";
import { appendGroupMessage, buildContextText, listGroups } from "./group-manager.js";

const DEFAULT_GROUP_ID = "default";
const TARGET_PREFIX = "agents-conversation:";
const ACTION_LIST_GROUPS = "list_groups";
const DEFAULT_GROUP_PROMPT = [
  "You are participating in a multi-agent group chat.",
  "Respond as your agent persona.",
  "Do not reply to your own previous messages.",
  "Keep replies concise and relevant to the latest message.",
].join("\n");

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

function buildGroupSessionKey({ agentId, groupId }) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedGroupId = String(groupId ?? "").trim().toLowerCase() || "unknown";
  return `agent:${normalizedAgentId}:agents-conversation:group:${normalizedGroupId}`;
}

function getChannelConfig(config) {
  return config?.channels?.["agents-conversation"] ?? {};
}

function getMaxDepth(config) {
  const cfg = getChannelConfig(config);
  return cfg.maxDepth ?? 4;
}

function shouldIncludeContext(config) {
  const cfg = getChannelConfig(config);
  return cfg.includeContext === true;
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

function formatGroupContext({ config, groupId, messageId }) {
  return buildContextText({ config, groupId, excludeMessageId: messageId });
}

function buildAgentBody({ config, groupId, senderId, content, messageId, includePrompt }) {
  const base = [
    ...(includePrompt ? [DEFAULT_GROUP_PROMPT] : []),
    `Group: ${groupId}`,
    `Latest message from ${senderId}:\n${content}`,
  ];
  if (!shouldIncludeContext(config)) {
    return base.join("\n\n");
  }
  const contextText = formatGroupContext({ config, groupId, messageId });
  const groupLine = includePrompt ? base[1] : base[0];
  const latestLine = includePrompt ? base[2] : base[1];
  const parts = [];
  if (includePrompt) {
    parts.push(base[0]);
  }
  parts.push(groupLine);
  parts.push(`Recent context:\n${contextText}`);
  parts.push(latestLine);
  return parts.join("\n\n");
}


async function runAgentDispatch({
  config,
  groupId,
  agentId,
  senderId,
  content,
  sessionKey,
  onFinalText,
  onError,
  onResult,
  logLabel,
}) {
  const runtime = getRuntime();
  const core = runtime.channel;
  const resolvedAgentId = normalizeAgentId(agentId);

  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: resolvedAgentId,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey,
  });

  const body = core.reply.formatAgentEnvelope({
    channel: "Agents Conversion",
    from: senderId,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: content,
  });

  const ctxBase = {
    Body: body,
    RawBody: content,
    CommandBody: content,
    From: `agents-conversation:${senderId}`,
    To: `agents-conversation:group:${groupId}`,
    SessionKey: sessionKey,
    AccountId: DEFAULT_ACCOUNT_ID,
    ChatType: "group",
    ConversationLabel: `Agents Conversion ${groupId}`,
    SenderName: senderId,
    SenderId: senderId,
    GroupId: groupId,
    Provider: "agents-conversation",
    Surface: "agents-conversation",
    OriginatingChannel: "agents-conversation",
    OriginatingTo: `agents-conversation:group:${groupId}`,
    CommandAuthorized: true,
  };

  const ctxPayload = core.reply.finalizeInboundContext(ctxBase);

  void core.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? sessionKey,
    ctx: ctxPayload,
  });

  await agentContext.run(
    {
      agentId: resolvedAgentId,
      groupId,
      senderId,
    },
    async () => {
      let lastBlockText = "";
      let hadFinal = false;
      const result = await core.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        replyOptions: {
          disableBlockStreaming: false,
        },
        dispatcherOptions: {
          deliver: async (payload, info) => {
            if (info.kind !== "final" && info.kind !== "block") {
              return;
            }
            if (
              !payload.text &&
              !payload.mediaUrl &&
              !(payload.mediaUrls && payload.mediaUrls.length)
            ) {
              return;
            }

            const replyText = formatPayloadText(payload);
            if (info.kind === "block") {
              lastBlockText = replyText;
              return;
            }
            hadFinal = true;
            await onFinalText(replyText);
          },
          onIdle: async () => {
            if (!hadFinal && lastBlockText) {
              logger.info("Agents Conversion dispatch fallback to last block", {
                groupId,
                agentId: resolvedAgentId,
              });
              await onFinalText(lastBlockText);
            }
          },
          onError: async (err) => {
            if (onError) {
              await onError(err);
            }
            logger.error(logLabel ?? "Agents Conversion dispatch failed", {
              agentId: resolvedAgentId,
              groupId,
              error: err.message,
            });
          },
        },
      });
      if (onResult) {
        await onResult(result);
      }
      logger.info("Agents Conversion dispatch complete", {
        groupId,
        agentId: resolvedAgentId,
        queuedFinal: result?.queuedFinal,
        finalReplies: result?.counts?.final,
      });
    },
  );
}

async function dispatchToAgent({ config, groupId, agentId, senderId, content, depth, messageId }) {
  const group = ensureGroup(groupId, config);
  const shouldSendPrompt = !group.promptSentAgents.has(normalizeAgentId(agentId));
  const body = buildAgentBody({
    config,
    groupId,
    senderId,
    content,
    messageId,
    includePrompt: shouldSendPrompt,
  });
  if (shouldSendPrompt) {
    group.promptSentAgents.add(normalizeAgentId(agentId));
  }
  const sessionKey = buildGroupSessionKey({ agentId, groupId });
  group.lastDispatch = {
    at: Date.now(),
    agentId,
    senderId,
    depth,
    messageId,
  };
  group.lastDispatchError = null;

  logger.info("Agents Conversion dispatch start", {
    groupId,
    agentId,
    senderId,
    depth,
    messageId,
  });

  const processingKey = `${normalizeAgentId(agentId)}:${messageId}`;
  let replyProcessed = group.replyProcessingFlags.get(processingKey) ?? false;

  await runAgentDispatch({
    config,
    groupId,
    agentId,
    senderId,
    content: body,
    sessionKey,
    onFinalText: async (replyText) => {
      try {
        // Prevent duplicate processing of the same reply
        if (replyProcessed) {
          logger.warn("Agents Conversion duplicate reply processing prevented", {
            groupId,
            agentId,
            messageId,
          });
          return;
        }
        replyProcessed = true;
        group.replyProcessingFlags.set(processingKey, true);

        group.lastReply = {
          at: Date.now(),
          agentId,
          senderId: normalizeAgentId(agentId),
          depth: depth + 1,
          messageId,
        };
        group.lastDispatchResult = {
          ...group.lastDispatchResult,
          hadFinalText: true,
          finalTextLength: replyText.length,
        };
        logger.info("Agents Conversion reply received", {
          groupId,
          agentId,
          senderId: normalizeAgentId(agentId),
          depth: depth + 1,
        });
        await ingestGroupMessage({
          config,
          groupId,
          senderType: "agent",
          senderId: normalizeAgentId(agentId),
          content: replyText,
          depth: depth + 1,
        });
      } catch (err) {
        logger.error("Failed to ingest agent reply", {
          agentId,
          groupId,
          error: err.message,
        });
      }
    },
    onError: async (err) => {
      group.lastDispatchError = {
        at: Date.now(),
        agentId,
        error: err.message,
      };
    },
    onResult: async (result) => {
      group.lastDispatchResult = {
        at: Date.now(),
        agentId,
        queuedFinal: result?.queuedFinal ?? null,
        finalReplies: result?.counts?.final ?? null,
        blockReplies: result?.counts?.block ?? null,
        hadFinalText: false,
        finalTextLength: 0,
      };
    },
  });
}

async function selectRouteAgents({ config, groupId, senderType, senderId }) {
  const group = ensureGroup(groupId, config);
  const candidates = Array.from(group.agents);
  // Always exclude the sender, regardless of senderType, to prevent self-dispatch
  return candidates.filter((id) => normalizeAgentId(id) !== normalizeAgentId(senderId));
}

async function ingestGroupMessage({
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
  if (group.ended) {
    logger.info("Agents Conversion group ended; skipping dispatch", {
      groupId,
      senderId,
      senderType,
    });
  }
  logger.info("Agents Conversion ingest", {
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

  const agents = await selectRouteAgents({
    config,
    groupId,
    senderType,
    senderId,
  });

  logger.info("Agents Conversion routing", {
    groupId,
    senderId,
    senderType,
    agents,
  });

  for (const agentId of agents) {
    dispatchToAgent({
      config,
      groupId,
      agentId,
      senderId,
      content,
      depth,
      messageId: message.id,
    }).catch((err) => {
      logger.error("Failed to dispatch group message", {
        agentId,
        groupId,
        error: err.message,
      });
    });
  }

  return message;
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
          description: "Enable Agents Conversion channel",
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
      },
    },
  },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => null,
    defaultAccountId: () => null,
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
  actions: {
    listActions: () => [
      {
        action: ACTION_LIST_GROUPS,
        label: "List groups",
        description: "List Agents Conversion group ids.",
        params: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    ],
    extractToolSend: ({ args }) => {
      if (!args) return null;
      const action = args.action || args.name || args.tool;
      if (action === ACTION_LIST_GROUPS) return null;
      return null;
    },
    handleAction: async ({ action, params, cfg }) => {
      if (action === ACTION_LIST_GROUPS) {
        return { ok: true, result: { groups: listGroups(cfg) } };
      }
      return { ok: false, error: `Unknown action: ${action}` };
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ cfg, to, text, senderId: explicitSenderId, metadata }) => {
      const ctx = agentContext.getStore();
      if (!ctx?.agentId) {
        throw new Error(
          "Agents Conversion outbound send is restricted to agent replies. Use the local HTTP API instead.",
        );
      }

      const { groupId, senderId: targetSenderId } = parseTarget(to);
      const senderId = explicitSenderId ?? metadata?.senderId ?? targetSenderId ?? ctx.agentId;
      if (!senderId) {
        throw new Error("Missing senderId for Agents Conversion outbound send.");
      }
      if (normalizeAgentId(senderId) !== normalizeAgentId(ctx.agentId)) {
        throw new Error("Agents Conversion outbound send senderId must match agent context.");
      }

      const content = String(text ?? "");
      if (!content) {
        throw new Error("Agents Conversion outbound send requires text.");
      }

      logger.info("Agents Conversion outbound send", {
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
          "Agents Conversion outbound send is restricted to agent replies. Use the local HTTP API instead.",
        );
      }

      const { groupId, senderId: targetSenderId } = parseTarget(to);
      const senderId = explicitSenderId ?? metadata?.senderId ?? targetSenderId ?? ctx.agentId;
      if (!senderId) {
        throw new Error("Missing senderId for Agents Conversion outbound send.");
      }
      if (normalizeAgentId(senderId) !== normalizeAgentId(ctx.agentId)) {
        throw new Error("Agents Conversion outbound send senderId must match agent context.");
      }

      const content = formatPayloadText({
        text: String(text ?? ""),
        mediaUrls: mediaUrl ? [mediaUrl] : [],
      });
      if (!content) {
        throw new Error("Agents Conversion outbound send requires text or media.");
      }

      logger.info("Agents Conversion outbound send media", {
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
  gateway: {
    startAccount: async (ctx) => {
      const config = ctx.cfg;
      const channelCfg = config?.channels?.["agents-conversation"] ?? {};

      if (channelCfg.enabled === false) {
        logger.info("Agents Conversion channel disabled");
        return;
      }

      const { ensureLocalServer, shutdownLocalServer } = await import("./http-server.js");
      await ensureLocalServer({
        config,
        port: channelCfg.port ?? 29080,
        bind: channelCfg.bind ?? "127.0.0.1",
      });

      const shutdown = async () => {
        await shutdownLocalServer();
      };

      if (!ctx.abortSignal) {
        return { shutdown };
      }

      if (ctx.abortSignal.aborted) {
        await shutdown();
        return;
      }

      await new Promise((resolve) => {
        ctx.abortSignal.addEventListener("abort", resolve, { once: true });
      });

      await shutdown();
    },
  },
};

export { ingestGroupMessage };
