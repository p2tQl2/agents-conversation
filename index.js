import { logger } from "./src/logger.js";
import { localGroupChannelPlugin } from "./src/channel-plugin.js";
import { createLocalGroupHttpHandler } from "./src/http-server.js";
import { setRuntime, setOpenclawConfig } from "./src/state.js";

const plugin = {
  id: "agents-conversation",
  name: "Agents Conversation",
  description: "Local multi-agent hub channel for OpenClaw",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) {
    logger.info("Agents Conversation plugin registering...");

    setRuntime(api.runtime);
    setOpenclawConfig(api.config);

    api.registerChannel({ plugin: localGroupChannelPlugin });
    logger.info("Agents Conversation channel registered");

    // Register HTTP route for gateway access (UI + stream endpoints).
    api.registerHttpRoute({
      path: "/agents-conversation",
      handler: createLocalGroupHttpHandler("/agents-conversation"),
      auth: "plugin",
      match: "prefix",
    });
    logger.info("Agents Conversation HTTP route registered");

    api.registerService({
      id: "agents-conversation-local-server",
      start: async ({ config, logger: serviceLogger }) => {
        const channelCfg = config?.channels?.["agents-conversation"] ?? {};
        setOpenclawConfig(config);
        if (channelCfg.enabled === false) {
          serviceLogger.info("[agents-conversation] local server disabled by config");
          return;
        }

        const port = channelCfg.port ?? 29080;
        const bind = channelCfg.bind ?? "127.0.0.1";
        const isLoopback =
          bind === "127.0.0.1" ||
          bind === "::1" ||
          bind === "localhost" ||
          (typeof bind === "string" && bind.startsWith("127."));
        const unsafeAllowRemoteWrite = channelCfg.unsafeAllowRemoteWrite === true;
        const readOnly = !isLoopback && !unsafeAllowRemoteWrite;

        await import("./src/http-server.js").then(({ ensureLocalServer }) =>
          ensureLocalServer({
            config,
            port,
            bind,
            readOnly,
          }),
        );
        serviceLogger.info(
          `[agents-conversation] local API server listening on http://${bind}:${port}/agents-conversation/ui`,
        );
      },
      stop: async () => {
        await import("./src/http-server.js").then(({ shutdownLocalServer }) =>
          shutdownLocalServer(),
        );
      },
    });
    logger.info("Agents Conversation local service registered");
  },
};

export default plugin;
export const register = (api) => plugin.register(api);
