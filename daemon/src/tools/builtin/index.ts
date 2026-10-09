import type { Logger } from 'pino';
import { ToolRegistry } from '../registry.js';
import { webFetchTool } from './web-fetch.js';
import { fileReadTool, fileWriteTool } from './file-ops.js';
import { shellExecTool } from './shell-exec.js';
import { browserFetchTool } from './browser-fetch.js';
import { browserOperatorTool } from './browser-operator.js';
import { inboxOtpWaitTool } from './inbox-otp.js';
import { createWebAuthFlowTool } from './web-auth.js';

export interface BuiltinToolOptions {
  resolveSecret?: (key: string) => string | null | Promise<string | null>;
  requestSecret?: (key: string, context?: string) => void | Promise<void>;
}

/**
 * Register all built-in tools with the registry.
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  logger: Logger,
  options: BuiltinToolOptions = {},
): void {
  registry.register(webFetchTool);
  registry.register(browserFetchTool);
  registry.register(browserOperatorTool);
  registry.register(inboxOtpWaitTool);
  registry.register(createWebAuthFlowTool({
    resolveSecret: options.resolveSecret,
    requestSecret: options.requestSecret,
  }));
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(shellExecTool);
  logger.info({ count: 8 }, 'Built-in tools registered');
}
