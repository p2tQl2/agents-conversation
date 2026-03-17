import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalGroupHttpHandler } from "./http-server.js";
import { createGroup, groups, serverState } from "./state.js";

function createRequest({ method = "GET", url, body } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  const req = Readable.from(chunks) as Readable & {
    method?: string;
    url?: string;
  };
  req.method = method;
  req.url = url;
  return req;
}

function createResponse() {
  const chunks: string[] = [];

  return {
    statusCode: 200,
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers ?? {};
      return this;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) {
        chunks.push(String(chunk));
      }
      this.body = chunks.join("");
      return this;
    },
    body: "",
  };
}

async function invokeHandler(handler, req) {
  const res = createResponse();
  const handled = await handler(req, res);
  return {
    handled,
    res,
    json: res.body ? JSON.parse(res.body) : null,
  };
}

describe("agents-conversation http server", () => {
  beforeEach(() => {
    groups.clear();
    serverState.config = null;
    serverState.server = null;
    serverState.started = false;
    serverState.bind = null;
    serverState.port = null;
    serverState.readOnly = null;
  });

  afterEach(() => {
    groups.clear();
    serverState.config = null;
    serverState.server = null;
    serverState.started = false;
    serverState.bind = null;
    serverState.port = null;
    serverState.readOnly = null;
  });

  it("exposes debug telemetry with compatibility aliases over HTTP", async () => {
    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b"],
        },
      },
    };
    serverState.config = config;

    const group = createGroup({
      groupId: "room-http",
      name: "HTTP Room",
      agents: ["bot-a", "bot-b"],
      config,
    });

    const firstMessage = {
      id: "msg-1",
      groupId: "room-http",
      senderType: "user",
      senderId: "user-1",
      content: "hello",
      depth: 0,
      timestamp: Date.now() - 1_000,
      metadata: {},
    };
    const secondMessage = {
      id: "msg-2",
      groupId: "room-http",
      senderType: "agent",
      senderId: "bot-a",
      content: "final reply",
      depth: 1,
      timestamp: Date.now(),
      metadata: {
        source: "agent-dispatch",
        replyToMessageId: "msg-1",
      },
    };

    group.messages.push(firstMessage, secondMessage);
    group.lastIngest = {
      at: Date.now(),
      senderType: "agent",
      senderId: "bot-a",
      depth: 1,
    };
    group.lastDeliveredTurn = {
      at: Date.now(),
      agentId: "bot-a",
      senderId: "user-1",
      depth: 0,
      messageId: "msg-1",
      sessionKey: "agent:bot-a:agents-conversation:group:room-http",
      routeMatchedBy: "default",
      routeAgentId: "main",
    };
    group.lastReingestedFinal = {
      at: Date.now(),
      agentId: "bot-a",
      senderId: "bot-a",
      depth: 1,
      messageId: "msg-1",
    };
    group.lastDeliveryResult = {
      at: Date.now(),
      agentId: "bot-a",
      queuedFinal: false,
      finalReplies: 1,
      blockReplies: 2,
      hadFinalText: true,
      finalTextLength: "final reply".length,
    };
    group.lastDeliveryError = {
      at: Date.now(),
      agentId: "bot-a",
      error: "none",
    };

    const handler = createLocalGroupHttpHandler("/agents-conversation");
    const { handled, res, json } = await invokeHandler(
      handler,
      createRequest({
        method: "GET",
        url: "/agents-conversation/groups/room-http/debug",
      }),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(json.id).toBe("room-http");
    expect(json.name).toBe("HTTP Room");
    expect(json.agents).toEqual(["bot-a", "bot-b"]);
    expect(json.totalDispatchBudget).toBe(100);
    expect(json.relayFanout).toBe(1);
    expect(json.maxRelayRounds).toBe(100);
    expect(json.relayRoundsUsed).toBe(0);
    expect(json.remainingRelayRounds).toBe(100);
    expect(json.messageCount).toBe(2);
    expect(json.subscribers).toBe(0);
    expect(json.lastEvent).toMatchObject({
      id: "msg-2",
      senderType: "agent",
      senderId: "bot-a",
      depth: 1,
      content: "final reply",
    });
    expect(json.lastIngest).toMatchObject({
      senderType: "agent",
      senderId: "bot-a",
      depth: 1,
    });
    expect(json.lastDeliveredTurn).toMatchObject({
      agentId: "bot-a",
      senderId: "user-1",
      routeAgentId: "main",
    });
    expect(json.lastReingestedFinal).toMatchObject({
      agentId: "bot-a",
      senderId: "bot-a",
      depth: 1,
    });
    expect(json.lastDeliveryResult).toMatchObject({
      queuedFinal: false,
      finalReplies: 1,
      blockReplies: 2,
      hadFinalText: true,
      finalTextLength: "final reply".length,
    });
    expect(json.lastDeliveryError).toMatchObject({
      agentId: "bot-a",
      error: "none",
    });
    expect(json.lastDispatch).toEqual(json.lastDeliveredTurn);
    expect(json.lastReply).toEqual(json.lastReingestedFinal);
    expect(json.lastDispatchError).toEqual(json.lastDeliveryError);
    expect(json.lastDispatchResult).toEqual(json.lastDeliveryResult);
  });

  it("blocks write endpoints when the local server is used in read-only mode", async () => {
    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a"],
        },
      },
    };
    serverState.config = config;

    const handler = createLocalGroupHttpHandler("/agents-conversation", {
      readOnly: true,
    });
    const { handled, res, json } = await invokeHandler(
      handler,
      createRequest({
        method: "POST",
        url: "/agents-conversation/groups/room-http/messages",
        body: JSON.stringify({
          groupName: "HTTP Room",
          members: ["bot-a"],
          initialMessage: "hello",
          senderId: "user-1",
        }),
      }),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(json).toEqual({ error: "read-only UI server" });
  });

  it("accepts write endpoints when the local server is used in read-write mode", async () => {
    const cfg = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a"],
        },
      },
    };
    serverState.config = cfg;

    const handler = createLocalGroupHttpHandler("/agents-conversation", {
      readOnly: false,
    });
    const { handled, res, json } = await invokeHandler(
      handler,
      createRequest({
        method: "POST",
        url: "/agents-conversation/groups/room-write/messages",
        body: JSON.stringify({
          groupName: "Writable Room",
          members: ["bot-a"],
          initialMessage: "hello",
          senderId: "user-1",
          totalDispatchBudget: 12,
          convergenceWarningRatio: 0.2,
        }),
      }),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(json.ok).toBe(true);
    expect(groups.has("room-write")).toBe(true);
    expect(groups.get("room-write")?.messages[0]?.senderType).toBe("user");
    expect(groups.get("room-write")?.totalDispatchBudget).toBe(12);
    expect(groups.get("room-write")?.convergenceWarningRatio).toBe(0.2);
    expect(groups.get("room-write")?.maxRelayRounds).toBe(12);
  });
});
