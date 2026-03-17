import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../test-utils/plugin-runtime-mock.ts";
import { dispatchAgentTurn, resolveAgentDispatchSession } from "./agent-dispatch.js";
import { buildDispatchContext } from "./dispatch-context.js";
import { createGroup, groups, setRuntime } from "./state.js";

describe("agents-conversation agent dispatch", () => {
  beforeEach(() => {
    groups.clear();
  });

  it("delivers only final payload text back to the orchestrator", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "draft" }, { kind: "block" });
      await dispatcherOptions.deliver(
        { text: "final answer", mediaUrls: ["https://example.com/file.png"] },
        { kind: "final" },
      );
      return { queuedFinal: false, counts: { block: 1, final: 1 } };
    });

    setRuntime(
      createPluginRuntimeMock({
        channel: {
          reply: {
            dispatchReplyWithBufferedBlockDispatcher,
          },
        },
      }),
    );

    const config = {
      channels: {
        "agents-conversation": {
          includeContext: true,
        },
      },
      session: {},
    };

    const group = createGroup({
      groupId: "room-1",
      name: "Room 1",
      agents: ["bot-a"],
      config,
    });

    const onFinalText = vi.fn(async () => {});
    const onResult = vi.fn(async () => {});

    await dispatchAgentTurn({
      config,
      group,
      groupId: "room-1",
      agentId: "bot-a",
      senderType: "user",
      senderId: "user-1",
      content: "hello world",
      messageId: "msg-1",
      sessionKey: "agent:bot-a:agents-conversation:group:room-1",
      contextText: "[2026-03-13T00:00:00.000Z] user-1: prior message",
      onFinalText,
      onResult,
    });

    expect(onFinalText).toHaveBeenCalledTimes(1);
    expect(onFinalText).toHaveBeenCalledWith(
      "final answer\n\nMEDIA: https://example.com/file.png",
    );
    expect(onResult).toHaveBeenCalledWith({
      queuedFinal: false,
      counts: { block: 1, final: 1 },
    });
  });

  it("keeps recent context in UntrustedContext and current text in BodyForAgent", async () => {
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async () => ({
      queuedFinal: false,
      counts: { block: 0, final: 0 },
    }));

    setRuntime(
      createPluginRuntimeMock({
        channel: {
          reply: {
            dispatchReplyWithBufferedBlockDispatcher,
          },
        },
      }),
    );

    const config = {
      channels: {
        "agents-conversation": {
          includeContext: true,
        },
      },
      session: {},
    };

    const group = createGroup({
      groupId: "room-2",
      name: "Room 2",
      agents: ["bot-b", "bot-c"],
      config,
    });

    await dispatchAgentTurn({
      config,
      group,
      groupId: "room-2",
      agentId: "bot-b",
      senderType: "agent",
      senderId: "user-2",
      content: "latest message",
      messageId: "msg-2",
      sessionKey: "agent:bot-b:agents-conversation:group:room-2",
      contextText: "[2026-03-13T00:00:00.000Z] bot-c: earlier reply",
      onFinalText: vi.fn(async () => {}),
      onResult: vi.fn(async () => {}),
    });

    const callArg = dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(callArg?.ctx?.From).toBe("agents-conversation:group:room-2");
    expect(callArg?.ctx?.To).toBe("agents-conversation:agent:bot-b");
    expect(callArg?.ctx?.Group).toBe("Room 2");
    expect(callArg?.ctx?.FromParticipant).toBe("user-2");
    expect(callArg?.ctx?.FromParticipantType).toBe("agent");
    expect(callArg?.ctx?.RecentGroupMessages).toBe(
      "[2026-03-13T00:00:00.000Z] bot-c: earlier reply",
    );
    expect(callArg?.ctx?.BodyForAgent).toBe("latest message");
    expect(callArg?.ctx?.RawBody).toBe("latest message");
    expect(callArg?.ctx?.UntrustedContext).toEqual(
      expect.arrayContaining([
        "Group: Room 2",
        "Members: bot-b, bot-c",
        "From: user-2 (agent)",
        "Rule: No self-reply. Be concise.",
        "Recent:\n[2026-03-13T00:00:00.000Z] bot-c: earlier reply",
      ]),
    );
  });

  it("reuses core route shape but pins the session to the dispatch target agent", () => {
    const resolveAgentRoute = vi.fn(() => ({
      agentId: "main",
      accountId: "default",
      channel: "agents-conversation",
      sessionKey: "agent:main:agents-conversation:group:room-3",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    }));

    setRuntime(
      createPluginRuntimeMock({
        channel: {
          routing: {
            resolveAgentRoute,
          },
        },
      }),
    );

    const config = {
      channels: {
        "agents-conversation": {},
      },
    };

    const resolved = resolveAgentDispatchSession({
      config,
      agentId: "bot-z",
      groupId: "room-3",
    });

    expect(resolveAgentRoute).toHaveBeenCalledWith({
      cfg: config,
      channel: "agents-conversation",
      accountId: "default",
      peer: {
        kind: "group",
        id: "room-3",
      },
    });
    expect(resolved.route.agentId).toBe("main");
    expect(resolved.sessionKey).toBe("agent:bot-z:agents-conversation:group:room-3");
  });

  it("builds dispatch context in a dedicated adapter layer", () => {
    const recordInboundSession = vi.fn(async () => {});
    const recordSessionMetaFromInbound = vi.fn(async () => {});
    setRuntime(
      createPluginRuntimeMock({
        channel: {
          session: {
            recordInboundSession,
            recordSessionMetaFromInbound,
          },
        },
      }),
    );
    const config = {
      channels: {
        "agents-conversation": {
          includeContext: true,
        },
      },
      session: {},
    };
    const group = createGroup({
      groupId: "room-4",
      name: "Room 4",
      agents: ["bot-a", "bot-b"],
      config,
    });

    const { ctxPayload, resolvedAgentId } = buildDispatchContext({
      config,
      agentId: "BOT-A",
      group,
      groupId: "room-4",
      senderType: "user",
      senderId: "user-4",
      content: "hello adapter",
      messageId: "msg-4",
      sessionKey: "agent:bot-a:agents-conversation:group:room-4",
      contextText: "earlier",
    });

    expect(resolvedAgentId).toBe("bot-a");
    expect(ctxPayload.From).toBe("agents-conversation:group:room-4");
    expect(ctxPayload.To).toBe("agents-conversation:agent:bot-a");
    expect(ctxPayload.BodyForAgent).toBe("hello adapter");
    expect(ctxPayload.RecentGroupMessages).toBe("earlier");
    expect(recordInboundSession).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:bot-a:agents-conversation:group:room-4",
      ctx: ctxPayload,
      onRecordError: expect.any(Function),
    });
    expect(recordSessionMetaFromInbound).not.toHaveBeenCalled();
  });
});
