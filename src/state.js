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
  const resolvedAgents = getAvailableAgents(config);
  return {
    maxMessages,
    contextWindow,
    resolvedAgents,
  };
}

function buildGroupState({
  groupId,
  name,
  agents,
  maxMessages,
  contextWindow,
  customAgents = false,
}) {
  return {
    id: groupId,
    name: name ?? groupId,
    agents: new Set(agents ?? []),
    messages: [],
    maxMessages,
    contextWindow,
    subscribers: new Set(),
    lastIngest: null,
    lastDispatch: null,
    lastReply: null,
    lastDispatchError: null,
    lastDispatchResult: null,
    duplicateMessages: [],
    duplicateStats: {
      total: 0,
      last: null,
    },
    duplicateTracker: new Map(),
    promptSentAgents: new Set(),
    replyProcessingFlags: new Map(),
    ended: false,
    customAgents,
    // Track last queried message index for incremental context queries
    lastQueriedMessageIndex: -1,
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
        customAgents: false,
      }),
    );
  } else {
    // Keep config in sync for hot reloads unless the group was user-created.
    const group = groups.get(groupId);
    if (group) {
      group.maxMessages = defaults.maxMessages;
      group.contextWindow = defaults.contextWindow;
      if (!group.customAgents && defaults.resolvedAgents.length > 0) {
        group.agents = new Set(defaults.resolvedAgents);
      }
    }
  }

  return groups.get(groupId);
}

export function createGroup({ groupId, name, agents, config, maxMessages, contextWindow }) {
  const defaults = resolveGroupDefaults(groupId, config);
  const resolvedAgents = normalizeAgentList(agents);
  const existing = groups.get(groupId);

  if (existing) {
    existing.name = name ?? existing.name ?? groupId;
    existing.maxMessages = maxMessages ?? existing.maxMessages ?? defaults.maxMessages;
    existing.contextWindow = contextWindow ?? existing.contextWindow ?? defaults.contextWindow;
    if (resolvedAgents.length > 0) {
      existing.agents = new Set(resolvedAgents);
      existing.customAgents = true;
    }
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
    customAgents: resolvedAgents.length > 0,
  });

  groups.set(groupId, group);
  return group;
}
