import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { serverState } from "./src/state.js";

describe("agents-conversation plugin service", () => {
  afterEach(async () => {
    if (serverState.started && serverState.server) {
      await new Promise((resolve) => {
        serverState.server.close(() => resolve(undefined));
      });
    }
    serverState.server = null;
    serverState.started = false;
    serverState.bind = null;
    serverState.port = null;
    serverState.config = null;
    serverState.readOnly = null;
  });

  it("starts the local API server from the plugin service lifecycle", async () => {
    let registeredService = null;

    plugin.register({
      runtime: {},
      config: {
        channels: {
          "agents-conversation": {
            enabled: true,
            bind: "127.0.0.1",
            port: 0,
          },
        },
      },
      registerChannel: vi.fn(),
      registerHttpRoute: vi.fn(),
      registerService: (service) => {
        registeredService = service;
      },
    });

    expect(registeredService?.id).toBe("agents-conversation-local-server");

    await registeredService.start({
      config: {
        channels: {
          "agents-conversation": {
            enabled: true,
            bind: "127.0.0.1",
            port: 0,
          },
        },
      },
      stateDir: "/tmp",
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
    });

    expect(serverState.started).toBe(true);
    expect(serverState.bind).toBe("127.0.0.1");
    expect(serverState.port).toBe(0);
    expect(serverState.readOnly).toBe(false);

    await registeredService.stop({
      config: {},
      stateDir: "/tmp",
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
    });

    expect(serverState.started).toBe(false);
    expect(serverState.server).toBe(null);
  });
});
