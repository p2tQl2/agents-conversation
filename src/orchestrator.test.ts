import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchAgentTurnMock = vi.hoisted(() => vi.fn());
const resolveAgentDispatchSessionMock = vi.hoisted(() =>
  vi.fn(({ agentId, groupId }) => ({
    sessionKey: `agent:${agentId}:agents-conversation:group:${groupId}`,
    route: {
      agentId,
      matchedBy: "default",
    },
  })),
);

vi.mock("./agent-dispatch.js", () => ({
  dispatchAgentTurn: dispatchAgentTurnMock,
  resolveAgentDispatchSession: resolveAgentDispatchSessionMock,
}));

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushQueue() {
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
}

describe("agents-conversation orchestrator", () => {
  beforeEach(async () => {
    vi.resetModules();
    dispatchAgentTurnMock.mockReset();
    resolveAgentDispatchSessionMock.mockClear();
    const { groups } = await import("./state.js");
    groups.clear();
  });

  it("serializes turns for the same agent and group", async () => {
    const blockers = [createDeferred(), createDeferred()];
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    dispatchAgentTurnMock.mockImplementation(async ({ messageId }) => {
      const currentIndex = started.length;
      started.push(messageId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await blockers[currentIndex].promise;
      active -= 1;
      return undefined;
    });

    const { ingestGroupMessage } = await import("./orchestrator.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a"],
          maxDepth: 4,
        },
      },
    };

    await ingestGroupMessage({
      config,
      groupId: "room-1",
      senderType: "user",
      senderId: "user-1",
      content: "first",
    });
    await ingestGroupMessage({
      config,
      groupId: "room-1",
      senderType: "user",
      senderId: "user-1",
      content: "second",
    });

    await flushQueue();
    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);

    blockers[0].resolve();
    await vi.waitFor(() => {
      expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(2);
      expect(started).toHaveLength(2);
    });
    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(started).toHaveLength(2);

    blockers[1].resolve();
    await flushQueue();

    expect(maxActive).toBe(1);
    expect(resolveAgentDispatchSessionMock).toHaveBeenCalledTimes(2);
  });

  it("serializes different agent dispatches within the same group by default", async () => {
    const blockers = [createDeferred(), createDeferred()];
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    dispatchAgentTurnMock.mockImplementation(async ({ agentId }) => {
      const currentIndex = started.length;
      started.push(agentId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await blockers[currentIndex].promise;
      active -= 1;
      return undefined;
    });

    const { ingestGroupMessage } = await import("./orchestrator.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b"],
          maxDepth: 4,
        },
      },
    };

    await ingestGroupMessage({
      config,
      groupId: "room-2",
      senderType: "user",
      senderId: "user-1",
      content: "hello team",
    });

    await flushQueue();

    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(started).toEqual(["bot-a"]);

    blockers[0].resolve();
    await vi.waitFor(() => {
      expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(2);
      expect(started).toEqual(["bot-a", "bot-b"]);
    });

    blockers[1].resolve();
    await flushMicrotasks();

    expect(maxActive).toBe(1);
  });

  it("reingests only final replies and preserves debug compatibility fields", async () => {
    dispatchAgentTurnMock.mockImplementationOnce(async ({ onFinalText, onResult }) => {
      await onFinalText("final reply");
      await onResult({
        queuedFinal: false,
        counts: { block: 3, final: 1 },
      });
      return undefined;
    });

    dispatchAgentTurnMock.mockImplementationOnce(async () => undefined);

    const { ingestGroupMessage } = await import("./orchestrator.js");
    const { buildGroupDebugTelemetry, groups } = await import("./state.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a"],
          maxDepth: 4,
        },
      },
    };

    const initialMessage = await ingestGroupMessage({
      config,
      groupId: "room-3",
      senderType: "user",
      senderId: "user-1",
      content: "start",
    });

    await flushQueue();

    const group = groups.get("room-3");
    expect(group).toBeTruthy();
    expect(group?.messages).toHaveLength(2);
    expect(group?.messages[0]?.id).toBe(initialMessage.id);
    expect(group?.messages[0]?.senderType).toBe("user");
    expect(group?.messages[1]?.senderType).toBe("agent");
    expect(group?.messages[1]?.senderId).toBe("bot-a");
    expect(group?.messages[1]?.content).toBe("final reply");
    expect(group?.messages[1]?.depth).toBe(1);
    expect(group?.messages[1]?.metadata).toMatchObject({
      source: "agent-dispatch",
      replyToMessageId: initialMessage.id,
    });

    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentTurnMock.mock.calls[0]?.[0]?.senderId).toBe("user-1");

    const debug = buildGroupDebugTelemetry(group);
    expect(debug.lastIngest).toMatchObject({
      senderType: "agent",
      senderId: "bot-a",
      depth: 1,
    });
    expect(debug.lastDeliveredTurn).toMatchObject({
      agentId: "bot-a",
      senderId: "user-1",
      depth: 0,
      messageId: initialMessage.id,
    });
    expect(debug.lastReingestedFinal).toMatchObject({
      agentId: "bot-a",
      senderId: "bot-a",
      depth: 1,
      messageId: initialMessage.id,
    });
    expect(debug.lastDeliveryResult).toMatchObject({
      queuedFinal: false,
      finalReplies: 1,
      blockReplies: 3,
      hadFinalText: true,
      finalTextLength: "final reply".length,
    });
    expect(debug.lastDispatch).toEqual(debug.lastDeliveredTurn);
    expect(debug.lastReply).toEqual(debug.lastReingestedFinal);
    expect(debug.lastDispatchError).toEqual(debug.lastDeliveryError);
    expect(debug.lastDispatchResult).toEqual(debug.lastDeliveryResult);
  });

  it("recursively fans out agent replies by default", async () => {
    dispatchAgentTurnMock.mockImplementationOnce(async ({ onFinalText, onResult }) => {
      await onFinalText("bot-a reply");
      await onResult({
        queuedFinal: false,
        counts: { block: 0, final: 1 },
      });
      return undefined;
    });

    dispatchAgentTurnMock.mockImplementation(async () => undefined);

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b"],
          maxDepth: 4,
        },
      },
    };

    const { ingestGroupMessage } = await import("./orchestrator.js");

    await ingestGroupMessage({
      config,
      groupId: "room-safe",
      senderType: "user",
      senderId: "user-1",
      content: "start",
    });

    await flushQueue();

    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(3);
    expect(dispatchAgentTurnMock.mock.calls[0]?.[0]?.agentId).toBe("bot-a");
    expect(dispatchAgentTurnMock.mock.calls[1]?.[0]?.agentId).toBe("bot-b");
    expect(dispatchAgentTurnMock.mock.calls[2]?.[0]).toMatchObject({
      agentId: "bot-b",
      senderType: "agent",
      senderId: "bot-a",
      content: "bot-a reply",
    });
  });

  it("derives relay rounds from total dispatch budget and agent fanout", async () => {
    const { createGroup, groups } = await import("./state.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b", "bot-c"],
          totalDispatchBudget: 100,
        },
      },
    };

    const twoAgentGroup = createGroup({
      groupId: "room-budget-2",
      name: "Two Agent Room",
      agents: ["bot-a", "bot-b"],
      config,
    });
    const threeAgentGroup = createGroup({
      groupId: "room-budget-3",
      name: "Three Agent Room",
      agents: ["bot-a", "bot-b", "bot-c"],
      config,
    });

    expect(twoAgentGroup.relayFanout).toBe(1);
    expect(twoAgentGroup.maxRelayRounds).toBe(100);
    expect(threeAgentGroup.relayFanout).toBe(2);
    expect(threeAgentGroup.maxRelayRounds).toBe(50);
    expect(groups.get("room-budget-3")?.relayRoundsUsed).toBe(0);
  });

  it("ends the group when the relay round budget is exhausted", async () => {
    dispatchAgentTurnMock
      .mockImplementationOnce(async ({ onFinalText, onResult }) => {
        await onFinalText("bot-a round 1");
        await onResult({
          queuedFinal: false,
          counts: { block: 0, final: 1 },
        });
      })
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async ({ onFinalText, onResult }) => {
        await onFinalText("bot-b round 2");
        await onResult({
          queuedFinal: false,
          counts: { block: 0, final: 1 },
        });
      });

    const { ingestGroupMessage } = await import("./orchestrator.js");
    const { groups } = await import("./state.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b"],
          maxDepth: 10,
          totalDispatchBudget: 2,
        },
      },
    };

    await ingestGroupMessage({
      config,
      groupId: "room-budget-stop",
      senderType: "user",
      senderId: "user-1",
      content: "start",
    });

    await flushQueue();

    const group = groups.get("room-budget-stop");
    expect(group?.relayRoundsUsed).toBe(2);
    expect(group?.maxRelayRounds).toBe(2);
    expect(group?.ended).toBe(true);
    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(3);
    expect(dispatchAgentTurnMock.mock.calls[2]?.[0]?.agentId).toBe("bot-b");
    expect(dispatchAgentTurnMock.mock.calls[2]?.[0]?.senderType).toBe("agent");
    expect(dispatchAgentTurnMock.mock.calls[2]?.[0]?.senderId).toBe("bot-a");
    expect(dispatchAgentTurnMock.mock.calls[2]?.[0]?.content).toContain("bot-a round 1");
    expect(dispatchAgentTurnMock.mock.calls[2]?.[0]?.content).toContain(
      "[Hint: Budget low (0/2). Converge and finish.]",
    );
    expect(group?.messages.at(-1)).toMatchObject({
      senderType: "agent",
      senderId: "bot-b",
      content: "bot-b round 2",
    });
  });

  it("injects a convergence hint when remaining relay rounds drop below the threshold", async () => {
    dispatchAgentTurnMock.mockImplementation(async () => undefined);

    const { ingestGroupMessage } = await import("./orchestrator.js");
    const { createGroup, groups } = await import("./state.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b"],
          totalDispatchBudget: 10,
          convergenceWarningRatio: 0.1,
        },
      },
    };

    const group = createGroup({
      groupId: "room-budget-hint",
      name: "Hint Room",
      agents: ["bot-a", "bot-b"],
      config,
    });
    group.relayRoundsUsed = 9;

    await ingestGroupMessage({
      config,
      groupId: "room-budget-hint",
      senderType: "agent",
      senderId: "bot-a",
      content: "finalize the plan",
      depth: 1,
    });

    await flushQueue();

    expect(groups.get("room-budget-hint")?.relayRoundsUsed).toBe(10);
    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentTurnMock.mock.calls[0]?.[0]?.content).toContain(
      "[Hint: Budget low (0/10). Converge and finish.]",
    );
  });

  it("can opt out of recursive agent relay explicitly", async () => {
    dispatchAgentTurnMock.mockImplementationOnce(async ({ onFinalText, onResult }) => {
      await onFinalText("bot-a reply");
      await onResult({
        queuedFinal: false,
        counts: { block: 0, final: 1 },
      });
      return undefined;
    });

    dispatchAgentTurnMock.mockImplementation(async () => undefined);

    const { ingestGroupMessage } = await import("./orchestrator.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b"],
          maxDepth: 4,
          relayAgentReplies: false,
        },
      },
    };

    await ingestGroupMessage({
      config,
      groupId: "room-relay",
      senderType: "user",
      senderId: "user-1",
      content: "start",
    });

    await flushQueue();

    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(dispatchAgentTurnMock.mock.calls[0]?.[0]?.agentId).toBe("bot-a");
    expect(dispatchAgentTurnMock.mock.calls[1]?.[0]?.agentId).toBe("bot-b");
  });

  it("can opt back into parallel dispatches within the same group", async () => {
    const blockers = [createDeferred(), createDeferred()];
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;

    dispatchAgentTurnMock.mockImplementation(async ({ agentId }) => {
      const currentIndex = started.length;
      started.push(agentId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await blockers[currentIndex].promise;
      active -= 1;
      return undefined;
    });

    const { ingestGroupMessage } = await import("./orchestrator.js");

    const config = {
      channels: {
        "agents-conversation": {
          availableAgents: ["bot-a", "bot-b"],
          maxDepth: 4,
          maxConcurrentDispatchesPerGroup: 2,
        },
      },
    };

    await ingestGroupMessage({
      config,
      groupId: "room-parallel",
      senderType: "user",
      senderId: "user-1",
      content: "hello team",
    });

    await flushQueue();

    expect(dispatchAgentTurnMock).toHaveBeenCalledTimes(2);
    expect(started).toEqual(["bot-a", "bot-b"]);
    expect(maxActive).toBe(2);

    blockers[0].resolve();
    blockers[1].resolve();
    await flushMicrotasks();
  });
});
