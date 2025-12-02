/**
 * Starter World Utility Functions
 */

// =============================================================================
// Debug Logging
// =============================================================================

/**
 * Creates a debug logger that writes to stderr when enabled.
 *
 * Enable with WORKFLOW_DEBUG environment variable:
 * - WORKFLOW_DEBUG=1 or WORKFLOW_DEBUG=true - enables all debug output
 * - WORKFLOW_DEBUG=starter - enables only starter namespace
 * - WORKFLOW_DEBUG=redis,starter - enables multiple namespaces
 *
 * Writes to stderr to avoid interfering with CLI stdout JSON parsing.
 */
function createDebugLogger(namespace: string) {
  return (...args: unknown[]) => {
    const debug = process.env.WORKFLOW_DEBUG;
    if (!debug) return;

    // Check if debugging is enabled for this namespace
    const enabled =
      debug === '1' ||
      debug === 'true' ||
      debug === '*' ||
      debug.split(',').some((ns) => ns.trim() === namespace);

    if (!enabled) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${namespace}]`;

    // Format message parts
    const message = args
      .map((arg) =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(' ');

    // Write to stderr to avoid interfering with stdout JSON parsing
    process.stderr.write(`${prefix} ${message}\n`);
  };
}

/**
 * Debug logger for starter-world.
 * Enable with WORKFLOW_DEBUG=starter or WORKFLOW_DEBUG=1
 */
export const debug = createDebugLogger('starter-world');
