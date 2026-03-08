import { Console } from "node:console";

// Simple prefixed logger so the plugin can be filtered in host logs.
const base = new Console({ stdout: process.stdout, stderr: process.stderr });

export const logger = {
  info: (...args) => base.log("[agents-conversation]", ...args),
  warn: (...args) => base.warn("[agents-conversation]", ...args),
  error: (...args) => base.error("[agents-conversation]", ...args),
  debug: (...args) => base.debug?.("[agents-conversation]", ...args) ?? base.log("[agents-conversation]", ...args),
};
