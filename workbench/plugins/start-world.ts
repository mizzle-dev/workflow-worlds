import { defineNitroPlugin } from 'nitro/~internal/runtime/plugin';

/**
 * Debug logger that writes to stderr when WORKFLOW_DEBUG is enabled.
 */
function debug(...args: unknown[]) {
  const debugEnv = process.env.WORKFLOW_DEBUG;
  if (!debugEnv) return;

  const enabled =
    debugEnv === '1' ||
    debugEnv === 'true' ||
    debugEnv === '*' ||
    debugEnv.split(',').some((ns) => ns.trim() === 'workbench');

  if (!enabled) return;

  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    )
    .join(' ');

  process.stderr.write(`[${timestamp}] [workbench] ${message}\n`);
}

// Start the World on server initialization
// This ensures the world is ready before handling requests
export default defineNitroPlugin(async () => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  if (targetWorld) {
    debug(`Starting World: ${targetWorld}...`);
    try {
      const { getWorld } = await import('workflow/runtime');
      const world = getWorld();
      if (world.start) {
        await world.start();
        debug(`World ${targetWorld} started successfully`);
      }
    } catch (error) {
      // Log to stderr to avoid interfering with CLI JSON output
      console.error(`Failed to start world ${targetWorld}:`, error);
    }
  } else {
    debug('No WORKFLOW_TARGET_WORLD set, using default world');
  }
});
