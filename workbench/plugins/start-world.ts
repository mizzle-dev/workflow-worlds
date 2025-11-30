import { defineNitroPlugin } from 'nitro/~internal/runtime/plugin';

// Start the World on server initialization
// This ensures the world is ready before handling requests
export default defineNitroPlugin(async () => {
  const targetWorld = process.env.WORKFLOW_TARGET_WORLD;
  if (targetWorld) {
    console.log(`Starting World: ${targetWorld}...`);
    try {
      const { getWorld } = await import('workflow/runtime');
      const world = getWorld();
      if (world.start) {
        await world.start();
        console.log(`World ${targetWorld} started successfully`);
      }
    } catch (error) {
      console.error(`Failed to start world ${targetWorld}:`, error);
    }
  } else {
    console.log('No WORKFLOW_TARGET_WORLD set, using default world');
  }
});
