import crypto from "node:crypto";
import { logger } from "./logger.js";
import { ensureGroup, groups } from "./state.js";

const DUPLICATE_WINDOW_MS = 30_000;
const DUPLICATE_TRACK_LIMIT = 200;
const DUPLICATE_LOG_LIMIT = 50;

function createMessage({ groupId, senderType, senderId, content, depth, metadata }) {
  return {
    id: crypto.randomUUID(),
    groupId,
    senderType,
    senderId,
    content: String(content ?? ""),
    depth: depth ?? 0,
    timestamp: Date.now(),
    metadata: metadata ?? {},
  };
}

function buildDuplicateKey({ senderType, senderId, content }) {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  return `${senderType}:${senderId}:${normalized}`;
}

export function appendGroupMessage({ config, groupId, senderType, senderId, content, depth, metadata }) {
  const group = ensureGroup(groupId, config);
  const message = createMessage({ groupId, senderType, senderId, content, depth, metadata });
  const key = buildDuplicateKey({ senderType, senderId, content: message.content });
  const now = message.timestamp;
  const prev = group.duplicateTracker.get(key);
  if (prev && now - prev.timestamp <= DUPLICATE_WINDOW_MS) {
    const duplicateEntry = {
      messageId: message.id,
      duplicateOf: prev.messageId,
      senderId,
      senderType,
      timestamp: now,
      previousTimestamp: prev.timestamp,
      contentPreview: message.content.replace(/\s+/g, " ").slice(0, 200),
    };
    group.duplicateMessages.push(duplicateEntry);
    if (group.duplicateMessages.length > DUPLICATE_LOG_LIMIT) {
      group.duplicateMessages.splice(0, group.duplicateMessages.length - DUPLICATE_LOG_LIMIT);
    }
    group.duplicateStats.total += 1;
    group.duplicateStats.last = duplicateEntry;
    logger.debug("Agents Conversion duplicate message detected", {
      groupId,
      senderId,
      senderType,
      messageId: message.id,
      duplicateOf: prev.messageId,
      windowMs: DUPLICATE_WINDOW_MS,
    });
  }

  group.messages.push(message);
  if (group.messages.length > group.maxMessages) {
    group.messages.splice(0, group.messages.length - group.maxMessages);
  }

  group.duplicateTracker.set(key, { messageId: message.id, timestamp: now });
  if (group.duplicateTracker.size > DUPLICATE_TRACK_LIMIT) {
    const oldestKey = group.duplicateTracker.keys().next().value;
    if (oldestKey) {
      group.duplicateTracker.delete(oldestKey);
    }
  }

  logger.info("Agents Conversion message appended", {
    groupId,
    senderId,
    senderType,
    messageId: message.id,
    depth: message.depth,
    subscribers: group.subscribers.size,
  });
  logger.debug("Agents Conversion message debug", {
    groupId,
    messageId: message.id,
    contentLength: message.content.length,
    preview: message.content.replace(/\s+/g, " ").slice(0, 200),
  });

  for (const res of group.subscribers) {
    try {
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    } catch (err) {
      logger.warn("Failed to push SSE message", { error: err.message });
      // Remove dead connection from subscribers
      group.subscribers.delete(res);
      try {
        res.end();
      } catch {
        // Ignore close errors
      }
    }
  }

  return message;
}

export function getGroupSnapshot({ config, groupId }) {
  const group = ensureGroup(groupId, config);
  return {
    id: group.id,
    name: group.name ?? group.id,
    agents: Array.from(group.agents),
    contextWindow: group.contextWindow,
    maxMessages: group.maxMessages,
    messages: group.messages.slice(),
  };
}

export function addSubscriber({ config, groupId, res }) {
  const group = ensureGroup(groupId, config);
  group.subscribers.add(res);
  return () => {
    group.subscribers.delete(res);
  };
}

export function listGroups(config) {
  // Only expose groups created at runtime.
  return Array.from(groups.keys());
}

export function buildContextText({ config, groupId, excludeMessageId }) {
  const group = ensureGroup(groupId, config);
  const windowSize = group.contextWindow;
  const slice = group.messages
    .filter((msg) => msg.id !== excludeMessageId)
    .slice(-windowSize);

  if (slice.length === 0) {
    return "(no prior group messages)";
  }

  return slice
    .map((msg) => {
      const timestamp = new Date(msg.timestamp).toISOString();
      const sender = msg.senderId || msg.senderType;
      return `[${timestamp}] ${sender}: ${msg.content}`;
    })
    .join("\n");
}

export function getIncrementalConversation({ config, groupId }) {
  const group = ensureGroup(groupId, config);
  const lastIndex = group.lastQueriedMessageIndex;
  const currentIndex = group.messages.length - 1;

  // Get messages from lastIndex+1 to currentIndex (inclusive)
  const startIdx = Math.max(0, lastIndex + 1);
  const newMessages = group.messages.slice(startIdx);

  // Update the last queried index
  if (newMessages.length > 0) {
    group.lastQueriedMessageIndex = currentIndex;
  }

  // Format messages as text
  const lines = newMessages.map((message) => {
    const content = String(message.content ?? "").replace(/\s+/g, " ").trim();
    return `${message.id}: ${content}`;
  });

  return lines.join("\n");
}
