import { defineNitroPlugin } from 'nitro/~internal/runtime/plugin';

// Start the World on server initialization
// This ensures the world is ready before handling requests
export default defineNitroPlugin(async () => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  if (targetWorld) {
    try {
      const { getWorld } = await import('workflow/runtime');
      const world = getWorld();
      if (world.start) {
        await world.start();
      }
    } catch (error) {
      // Log to stderr to avoid interfering with CLI JSON output
      console.error(`Failed to start world ${targetWorld}:`, error);
    }
  }
});
