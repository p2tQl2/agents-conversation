import { logger } from "./src/logger.js";
import { localGroupChannelPlugin } from "./src/channel-plugin.js";
import { createLocalGroupHttpHandler, ensureLocalServer } from "./src/http-server.js";
import { setRuntime, setOpenclawConfig } from "./src/state.js";

const plugin = {
  id: "agents-conversation",
  name: "Agents Conversation",
  description: "Local multi-agent hub channel for OpenClaw",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) {
    logger.info("Agents Conversion plugin registering...");

    setRuntime(api.runtime);
    setOpenclawConfig(api.config);

    api.registerChannel({ plugin: localGroupChannelPlugin });
    logger.info("Agents Conversion channel registered");

    const channelCfg = api.config?.channels?.["agents-conversation"] ?? {};
    if (channelCfg.enabled !== false) {
      ensureLocalServer({
        config: api.config,
        port: channelCfg.port ?? 29080,
        bind: channelCfg.bind ?? "127.0.0.1",
      }).catch((err) => {
        logger.error("Failed to start local UI server", { error: err.message });
      });
    }

    // Register HTTP route for gateway access (UI + stream endpoints).
    api.registerHttpRoute({
      path: "/agents-conversation",
      handler: createLocalGroupHttpHandler("/agents-conversation"),
      auth: "plugin",
      match: "prefix",
    });
    logger.info("Agents Conversion HTTP route registered");
  },
};

export default plugin;
export const register = (api) => plugin.register(api);
