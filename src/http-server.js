import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.js";
import { addSubscriber, getGroupSnapshot, listGroups, getIncrementalConversation } from "./group-manager.js";
import { ingestGroupMessage } from "./orchestrator.js";
import {
  buildGroupDebugTelemetry,
  createGroup,
  ensureGroup,
  getAvailableAgents,
  getChannelConfig,
  getOpenclawConfig,
  groups,
  serverState,
} from "./state.js";

const UI_PATH = join(new URL(".", import.meta.url).pathname, "ui", "index.html");

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, payload) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(payload);
}

async function sendUi(res) {
  const html = await readFile(UI_PATH, "utf-8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function parseGroupId(pathname, basePath, prefix) {
  const normalizedBase = basePath.replace(/\/$/, "");
  const normalized = pathname.replace(/\/$/, "");
  const target = normalized.replace(normalizedBase, "");
  const parts = target.split("/").filter(Boolean);

  const index = parts.indexOf(prefix);
  if (index === -1 || !parts[index + 1]) {
    return null;
  }
  return parts[index + 1];
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    return null;
  }
  return JSON.parse(raw);
}

function sendReadOnlyError(res) {
  sendJson(res, 405, { error: "read-only UI server" });
}

export function createLocalGroupHttpHandler(
  basePath = "/agents-conversation",
  options = {},
) {
  const readOnly = options.readOnly === true;

  return async (req, res) => {
    const url = new URL(req.url || "", "http://localhost");
    const pathname = url.pathname;

    if (pathname === "/" && basePath) {
      res.writeHead(302, { Location: `${basePath}/ui` });
      res.end();
      return true;
    }

    if (pathname === basePath) {
      res.writeHead(302, { Location: `${basePath}/ui` });
      res.end();
      return true;
    }

    if (pathname === `${basePath}/ui` || pathname === `${basePath}/ui/`) {
      await sendUi(res);
      return true;
    }

    if (pathname === `${basePath}/groups`) {
      if (req.method && req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const groups = listGroups(getConfig());
      sendJson(res, 200, { groups });
      return true;
    }

    if (pathname === `${basePath}/agents`) {
      if (req.method && req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const agents = getAvailableAgents(getConfig());
      sendJson(res, 200, { agents });
      return true;
    }

    if (pathname.includes("/groups/") && pathname.endsWith("/messages")) {
      const groupId = parseGroupId(pathname, basePath, "groups");
      if (!groupId) {
        sendJson(res, 400, { error: "missing group id" });
        return true;
      }

      if (req.method === "POST") {
        if (readOnly) {
          sendReadOnlyError(res);
          return true;
        }
        let body = null;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, { error: "invalid json body" });
          return true;
        }

        const senderId = body?.senderId ?? body?.from ?? null;
        const senderType = body?.senderType ?? "user";
        const content = body?.initialMessage ?? body?.text ?? body?.content ?? "";
        const groupName = body?.groupName ?? body?.name ?? null;
        const members = body?.members ?? body?.agents ?? null;
        const depth = Number.isFinite(body?.depth) ? body.depth : 0;
        const totalDispatchBudget = Number.isFinite(body?.totalDispatchBudget)
          ? body.totalDispatchBudget
          : undefined;
        const convergenceWarningRatio = Number.isFinite(body?.convergenceWarningRatio)
          ? body.convergenceWarningRatio
          : undefined;
        const metadata = body?.metadata ?? undefined;
        const availableAgents = getAvailableAgents(getConfig());

        if (!groupName) {
          sendJson(res, 400, { error: "missing groupName" });
          return true;
        }
        if (!Array.isArray(members) || members.length === 0) {
          sendJson(res, 400, { error: "missing group members" });
          return true;
        }
        if (!senderId) {
          sendJson(res, 400, { error: "missing senderId" });
          return true;
        }
        if (!content) {
          sendJson(res, 400, { error: "missing initialMessage" });
          return true;
        }

        if (
          availableAgents.length > 0 &&
          members.some((id) => !availableAgents.includes(id))
        ) {
          sendJson(res, 400, { error: "members not in availableAgents list" });
          return true;
        }

        createGroup({
          groupId,
          name: groupName,
          agents: members,
          config: getConfig(),
          totalDispatchBudget,
          convergenceWarningRatio,
        });

        const message = await ingestGroupMessage({
          config: getConfig(),
          groupId,
          senderType,
          senderId,
          content,
          depth,
          metadata,
        });

        logger.info("Agents Conversation HTTP message ingested", {
          groupId,
          senderId,
          senderType,
          messageId: message.id,
        });

        sendJson(res, 200, { ok: true, messageId: message.id });
        return true;
      }

      if (req.method === "GET" || !req.method) {
        const snapshot = getGroupSnapshot({ config: getConfig(), groupId });
        sendJson(res, 200, snapshot);
        return true;
      }

      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }

    if (pathname.includes("/groups/") && pathname.endsWith("/conversations")) {
      const groupId = parseGroupId(pathname, basePath, "groups");
      if (!groupId) {
        sendJson(res, 400, { error: "missing group id" });
        return true;
      }
      if (req.method && req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }

      const cursor = url.searchParams.get("cursor");
      const clientId = url.searchParams.get("clientId");
      const lines = getIncrementalConversation({ config: getConfig(), groupId, cursor, clientId });
      sendText(res, 200, lines);
      return true;
    }

    if (pathname.includes("/groups/") && pathname.endsWith("/end")) {
      const groupId = parseGroupId(pathname, basePath, "groups");
      if (!groupId) {
        sendJson(res, 400, { error: "missing group id" });
        return true;
      }
      if (readOnly) {
        sendReadOnlyError(res);
        return true;
      }
      if (req.method && req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const config = getConfig();
      const group = ensureGroup(groupId, config);
      group.ended = true;
      logger.info("Agents Conversation group ended", { groupId });
      sendJson(res, 200, { ok: true, groupId, ended: true });
      return true;
    }

    if (pathname.includes("/groups/") && pathname.endsWith("/delete")) {
      const groupId = parseGroupId(pathname, basePath, "groups");
      if (!groupId) {
        sendJson(res, 400, { error: "missing group id" });
        return true;
      }
      if (readOnly) {
        sendReadOnlyError(res);
        return true;
      }
      if (req.method && req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      const config = getConfig();
      const group = ensureGroup(groupId, config);
      for (const res of group.subscribers) {
        try {
          res.end();
        } catch {
          // Ignore close errors.
        }
      }
      groups.delete(groupId);
      logger.info("Agents Conversation group deleted", { groupId });
      sendJson(res, 200, { ok: true, groupId, deleted: true });
      return true;
    }

    if (pathname.includes("/groups/") && pathname.endsWith("/stream")) {
      const groupId = parseGroupId(pathname, basePath, "groups");
      if (!groupId) {
        sendJson(res, 400, { error: "missing group id" });
        return true;
      }

      // SSE stream for real-time updates.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const snapshot = getGroupSnapshot({ config: getConfig(), groupId });
      try {
        res.write(`event: snapshot\n`);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch (err) {
        logger.warn("Failed to send initial SSE snapshot", { groupId, error: err.message });
        res.end();
        return true;
      }

      const unsubscribe = addSubscriber({ config: getConfig(), groupId, res });

      const cleanup = () => {
        unsubscribe();
        try {
          res.end();
        } catch {
          // Ignore close errors
        }
      };

      req.on("close", cleanup);
      res.on("error", () => {
        cleanup();
      });

      return true;
    }

    if (pathname.includes("/groups/") && pathname.endsWith("/debug")) {
      const groupId = parseGroupId(pathname, basePath, "groups");
      if (!groupId) {
        sendJson(res, 400, { error: "missing group id" });
        return true;
      }
      if (req.method && req.method !== "GET") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }

      const config = getConfig();
      const group = ensureGroup(groupId, config);
      const snapshot = getGroupSnapshot({ config, groupId });
      const lastEvent = group.messages[group.messages.length - 1] ?? null;
      const telemetry = buildGroupDebugTelemetry(group);
      const channelConfig = getChannelConfig(config);
      const debug = {
        ...snapshot,
        channelConfig,
        subscribers: group.subscribers.size,
        messageCount: group.messages.length,
        lastEvent,
        ...telemetry,
        duplicateStats: group.duplicateStats,
        duplicateMessages: group.duplicateMessages,
        ended: group.ended,
      };

      logger.debug("Agents Conversation debug snapshot", {
        groupId,
        agents: snapshot.agents.length,
        messageCount: debug.messageCount,
        subscribers: debug.subscribers,
        lastEvent: debug.lastEvent
          ? {
              id: debug.lastEvent.id,
              senderId: debug.lastEvent.senderId,
              senderType: debug.lastEvent.senderType,
              depth: debug.lastEvent.depth,
            }
          : null,
        lastIngest: debug.lastIngest,
        lastDeliveredTurn: debug.lastDeliveredTurn,
        lastReingestedFinal: debug.lastReingestedFinal,
        lastDeliveryError: debug.lastDeliveryError,
        lastDeliveryResult: debug.lastDeliveryResult,
        ended: debug.ended,
      });

      sendJson(res, 200, debug);
      return true;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return true;
  };
}

function getConfig() {
  const config = serverState.config ?? getOpenclawConfig();
  return config ?? {};
}

export async function ensureLocalServer({ config, port, bind, readOnly = false }) {
  serverState.config = config;
  if (
    serverState.started &&
    serverState.port === port &&
    serverState.bind === bind &&
    serverState.readOnly === readOnly
  ) {
    return;
  }
  if (serverState.started) {
    await shutdownLocalServer();
    serverState.config = config;
  }

  const handler = createLocalGroupHttpHandler("/agents-conversation", {
    readOnly,
  });
  serverState.server = createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      logger.error("Local Hub server error", { error: err.message });
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  await new Promise((resolve, reject) => {
    serverState.server.once("error", reject);
    serverState.server.listen(port, bind, resolve);
  });

  serverState.started = true;
  serverState.bind = bind;
  serverState.port = port;
  serverState.readOnly = readOnly;
  logger.info("Agents Conversation UI server listening", { port, bind, readOnly });
}

export async function shutdownLocalServer() {
  if (!serverState.server || !serverState.started) {
    return;
  }

  await new Promise((resolve) => {
    serverState.server.close(() => resolve());
  });

  serverState.server = null;
  serverState.started = false;
  serverState.bind = null;
  serverState.port = null;
  serverState.readOnly = null;
  logger.info("Agents Conversation UI server stopped");
}
