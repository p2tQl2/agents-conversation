import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "openclaw/plugin-sdk";
import { getChannelConfig, getRuntime } from "./state.js";

function buildGroupMembersLine(group) {
  const members = Array.from(group.agents);
  return members.length > 0 ? members.join(", ") : undefined;
}

function buildGroupAddress(groupId) {
  return `agents-conversation:group:${groupId}`;
}

function buildAgentAddress(agentId) {
  return `agents-conversation:agent:${agentId}`;
}

function buildStructuredContext({
  group,
  groupId,
  senderType,
  senderId,
  content,
  messageId,
  contextText,
}) {
  const groupLabel = group.name ?? groupId;
  const context = [
    `Group: ${groupLabel}`,
    `Members: ${buildGroupMembersLine(group) ?? "(unknown)"}`,
    `From: ${senderId} (${senderType})`,
    "Rule: No self-reply. Be concise.",
  ];

  if (contextText) {
    context.push(`Recent:\n${contextText}`);
  }

  return {
    bodyForAgent: content,
    untrustedContext: context,
  };
}

export function buildDispatchContext({
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
}) {
  const resolvedAgentId = normalizeAgentId(agentId);
  const runtime = getRuntime();
  const core = runtime.channel;
  const storePath = core.session.resolveStorePath(config.session?.store, {
    agentId: resolvedAgentId,
  });
  const previousTimestamp = core.session.readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const envelopeOptions = core.reply.resolveEnvelopeFormatOptions(config);
  const { bodyForAgent, untrustedContext } = buildStructuredContext({
    group,
    groupId,
    senderType,
    senderId,
    content,
    messageId,
    contextText:
      getChannelConfig(config).includeContext === true ? contextText : undefined,
  });
  const body = core.reply.formatAgentEnvelope({
    channel: "Agents Conversation",
    from: senderId,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent,
  });

  const ctxPayload = core.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: content,
    CommandBody: content,
    UntrustedContext: untrustedContext,
    From: buildGroupAddress(groupId),
    To: buildAgentAddress(resolvedAgentId),
    SessionKey: sessionKey,
    AccountId: DEFAULT_ACCOUNT_ID,
    ChatType: "group",
    Group: group.name ?? groupId,
    ConversationLabel: group.name ?? groupId,
    GroupSubject: group.name ?? groupId,
    GroupMembers: buildGroupMembersLine(group),
    SenderName: senderId,
    SenderId: senderId,
    SenderType: senderType,
    FromParticipant: senderId,
    FromParticipantType: senderType,
    GroupId: groupId,
    GroupChannel: groupId,
    RecentGroupMessages:
      getChannelConfig(config).includeContext === true ? contextText : undefined,
    Provider: "agents-conversation",
    Surface: "agents-conversation",
    OriginatingChannel: "agents-conversation",
    OriginatingTo: buildGroupAddress(groupId),
    CommandAuthorized: senderType === "agent",
  });

  const persistSession =
    typeof core.session.recordInboundSession === "function"
      ? core.session.recordInboundSession({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? sessionKey,
          ctx: ctxPayload,
          onRecordError: () => {
            // Dispatch continues even when session metadata persistence fails.
          },
        })
      : core.session.recordSessionMetaFromInbound?.({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? sessionKey,
          ctx: ctxPayload,
        });

  if (persistSession && typeof persistSession.catch === "function") {
    void persistSession.catch(() => {
      // Extensions should not fail turn delivery when only session bookkeeping fails.
    });
  }

  return { core, ctxPayload, resolvedAgentId };
}
