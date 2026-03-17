import { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "openclaw/plugin-sdk";
import { getRuntime } from "./state.js";

function buildFallbackGroupSessionKey({ agentId, groupId }) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedGroupId = String(groupId ?? "").trim().toLowerCase() || "unknown";
  return `agent:${normalizedAgentId}:agents-conversation:group:${normalizedGroupId}`;
}

function retargetSessionKeyToAgent({ sessionKey, agentId, groupId }) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const match = /^agent:[^:]+:(.+)$/u.exec(String(sessionKey ?? "").trim());
  if (!match) {
    return buildFallbackGroupSessionKey({ agentId: normalizedAgentId, groupId });
  }
  return `agent:${normalizedAgentId}:${match[1]}`;
}

export function resolveAgentDispatchSession({ config, agentId, groupId }) {
  const resolvedAgentId = normalizeAgentId(agentId);
  const runtime = getRuntime();
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "agents-conversation",
    accountId: DEFAULT_ACCOUNT_ID,
    peer: {
      kind: "group",
      id: groupId,
    },
  });

  return {
    route,
    sessionKey: retargetSessionKeyToAgent({
      sessionKey:
        route?.sessionKey ??
        buildFallbackGroupSessionKey({
          agentId: resolvedAgentId,
          groupId,
        }),
      agentId: resolvedAgentId,
      groupId,
    }),
  };
}
