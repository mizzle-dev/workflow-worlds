import { defineConfig } from 'nitro';

export default defineConfig({
  modules: ['workflow/nitro'],
  serverDir: './',
  plugins: ['plugins/start-world.ts'],
  hooks: {
    'rollup:before': (_nitro: unknown, config: { treeshake?: unknown }) => {
      // Preserve side effects in workflow steps bundle
      // This prevents tree-shaking from removing step registrations
      config.treeshake = {
        ...(typeof config.treeshake === 'object' ? config.treeshake : {}),
        moduleSideEffects: (id: string, external: boolean) => {
          // Keep side effects for steps bundle and workflow runtime
          if (id.includes('.nitro/workflow/') || id.includes('workflow/internal/private')) {
            return true;
          }
          // Default behavior for other modules
          return !external;
        },
      };
    },
  },
});
