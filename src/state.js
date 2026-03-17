import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeAgentId } from "openclaw/plugin-sdk";

const runtimeState = {
  runtime: null,
  openclawConfig: null,
};

export const agentContext = new AsyncLocalStorage();

// groupId -> { agents: Set, messages: [], maxMessages, contextWindow, subscribers: Set }
export const groups = new Map();

// Singleton HTTP server instance (created by gateway.startAccount).
export const serverState = {
  server: null,
  started: false,
  config: null,
  bind: null,
  port: null,
  readOnly: null,
};

export function setRuntime(runtime) {
  runtimeState.runtime = runtime;
}

export function getRuntime() {
  if (!runtimeState.runtime) {
    throw new Error("[agents-conversation] Runtime not initialized");
  }
  return runtimeState.runtime;
}

export function setOpenclawConfig(config) {
  runtimeState.openclawConfig = config;
}

export function getOpenclawConfig() {
  return runtimeState.openclawConfig;
}

export function getChannelConfig(config) {
  return config?.channels?.["agents-conversation"] ?? {};
}

function normalizePositiveInteger(value, fallback, minimum = 1) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(minimum, Math.floor(raw));
}

function normalizeRatio(value, fallback) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.min(raw, 1);
}

function normalizeAgentList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const unique = new Set();
  const normalized = [];
  for (const entry of list) {
    const id = normalizeAgentId(entry);
    if (!id || unique.has(id)) {
      continue;
    }
    unique.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function getAvailableAgents(config) {
  const cfg = getChannelConfig(config);
  const available = normalizeAgentList(cfg.availableAgents);
  if (available.length > 0) {
    return available;
  }
  const fallback = Array.isArray(config?.agents?.list)
    ? normalizeAgentList(config.agents.list.map((agent) => agent?.id))
    : [];
  return fallback;
}

function resolveGroupDefaults(groupId, config) {
  const cfg = getChannelConfig(config);
  const maxMessages = cfg.maxMessages ?? 200;
  const contextWindow = cfg.contextWindow ?? 40;
  const totalDispatchBudget = normalizePositiveInteger(cfg.totalDispatchBudget, 100);
  const convergenceWarningRatio = normalizeRatio(cfg.convergenceWarningRatio, 0.1);
  const resolvedAgents = getAvailableAgents(config);
  return {
    maxMessages,
    contextWindow,
    totalDispatchBudget,
    convergenceWarningRatio,
    resolvedAgents,
  };
}

function recomputeGroupRelayBudget(group) {
  const relayFanout = Math.max(1, group.agents.size - 1);
  group.relayFanout = relayFanout;
  group.maxRelayRounds = Math.max(1, Math.floor(group.totalDispatchBudget / relayFanout));
}

function buildGroupState({
  groupId,
  name,
  agents,
  maxMessages,
  contextWindow,
  totalDispatchBudget,
  convergenceWarningRatio,
  customAgents = false,
  customRelayBudget = false,
}) {
  const group = {
    id: groupId,
    name: name ?? groupId,
    agents: new Set(agents ?? []),
    messages: [],
    maxMessages,
    contextWindow,
    totalDispatchBudget,
    convergenceWarningRatio,
    relayFanout: 1,
    maxRelayRounds: 1,
    relayRoundsUsed: 0,
    subscribers: new Set(),
    lastIngest: null,
    lastDeliveredTurn: null,
    lastReingestedFinal: null,
    lastDeliveryError: null,
    lastDeliveryResult: null,
    duplicateMessages: [],
    duplicateStats: {
      total: 0,
      last: null,
    },
    duplicateTracker: new Map(),
    ended: false,
    customAgents,
    customRelayBudget,
    // Track last queried message index for incremental context queries
    lastQueriedMessageIndex: -1,
    lastQueriedMessageIndexByClient: new Map(),
  };

  recomputeGroupRelayBudget(group);
  return group;
}

export function buildGroupDebugTelemetry(group) {
  const telemetry = {
    lastIngest: group.lastIngest,
    lastDeliveredTurn: group.lastDeliveredTurn,
    lastReingestedFinal: group.lastReingestedFinal,
    lastDeliveryError: group.lastDeliveryError,
    lastDeliveryResult: group.lastDeliveryResult,
  };

  return {
    ...telemetry,
    // Keep legacy debug aliases during the compatibility window.
    lastDispatch: telemetry.lastDeliveredTurn,
    lastReply: telemetry.lastReingestedFinal,
    lastDispatchError: telemetry.lastDeliveryError,
    lastDispatchResult: telemetry.lastDeliveryResult,
  };
}

export function ensureGroup(groupId, config) {
  const defaults = resolveGroupDefaults(groupId, config);

  if (!groups.has(groupId)) {
    groups.set(
      groupId,
      buildGroupState({
        groupId,
        name: groupId,
        agents: defaults.resolvedAgents,
        maxMessages: defaults.maxMessages,
        contextWindow: defaults.contextWindow,
        totalDispatchBudget: defaults.totalDispatchBudget,
        convergenceWarningRatio: defaults.convergenceWarningRatio,
        customAgents: false,
      }),
    );
  } else {
    // Keep config in sync for hot reloads unless the group was user-created.
    const group = groups.get(groupId);
    if (group) {
      group.maxMessages = defaults.maxMessages;
      group.contextWindow = defaults.contextWindow;
      if (!group.customRelayBudget) {
        group.totalDispatchBudget = defaults.totalDispatchBudget;
        group.convergenceWarningRatio = defaults.convergenceWarningRatio;
      }
      if (!group.customAgents && defaults.resolvedAgents.length > 0) {
        group.agents = new Set(defaults.resolvedAgents);
      }
      recomputeGroupRelayBudget(group);
    }
  }

  return groups.get(groupId);
}

export function createGroup({
  groupId,
  name,
  agents,
  config,
  maxMessages,
  contextWindow,
  totalDispatchBudget,
  convergenceWarningRatio,
}) {
  const defaults = resolveGroupDefaults(groupId, config);
  const resolvedAgents = normalizeAgentList(agents);
  const existing = groups.get(groupId);

  if (existing) {
    existing.name = name ?? existing.name ?? groupId;
    existing.maxMessages = maxMessages ?? existing.maxMessages ?? defaults.maxMessages;
    existing.contextWindow = contextWindow ?? existing.contextWindow ?? defaults.contextWindow;
    if (totalDispatchBudget != null || convergenceWarningRatio != null) {
      existing.customRelayBudget = true;
    }
    existing.totalDispatchBudget = existing.customRelayBudget
      ? totalDispatchBudget ?? existing.totalDispatchBudget ?? defaults.totalDispatchBudget
      : defaults.totalDispatchBudget;
    existing.convergenceWarningRatio = existing.customRelayBudget
      ? convergenceWarningRatio ??
        existing.convergenceWarningRatio ??
        defaults.convergenceWarningRatio
      : defaults.convergenceWarningRatio;
    if (resolvedAgents.length > 0) {
      existing.agents = new Set(resolvedAgents);
      existing.customAgents = true;
    }
    recomputeGroupRelayBudget(existing);
    return existing;
  }

  const nextAgents =
    resolvedAgents.length > 0 ? resolvedAgents : defaults.resolvedAgents;

  const group = buildGroupState({
    groupId,
    name: name ?? groupId,
    agents: nextAgents,
    maxMessages: maxMessages ?? defaults.maxMessages,
    contextWindow: contextWindow ?? defaults.contextWindow,
    totalDispatchBudget: totalDispatchBudget ?? defaults.totalDispatchBudget,
    convergenceWarningRatio:
      convergenceWarningRatio ?? defaults.convergenceWarningRatio,
    customAgents: resolvedAgents.length > 0,
    customRelayBudget: totalDispatchBudget != null || convergenceWarningRatio != null,
  });

  groups.set(groupId, group);
  return group;
}
