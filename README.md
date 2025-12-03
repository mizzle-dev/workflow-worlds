# workflow-worlds

Custom World implementations for the [Workflow DevKit](https://github.com/vercel/workflow).

## What is a World?

A World provides the infrastructure layer for Workflow DevKit, handling:
- **Storage**: Persisting workflow runs, steps, events, and hooks
- **Queue**: Message passing for async execution
- **Streamer**: Real-time output streaming

## Quick Start

### Using the Starter Template

1. Copy the starter package:
   ```bash
   cp -r packages/starter my-world
   cd my-world
   ```

2. Update `package.json` with your package name

3. Install dependencies and verify tests pass:
   ```bash
   pnpm install
   pnpm build
   pnpm test
   ```

4. Replace the in-memory implementations with your backend

### Installation

```bash
# Install the starter as a template
npm create @workflow-worlds my-world
```

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| [@workflow-worlds/starter](./packages/starter) | In-memory World template for building custom implementations | ✅ Ready |
| [@workflow-worlds/mongodb](./packages/mongodb) | MongoDB World using native driver | ✅ Ready |
| [@workflow-worlds/redis](./packages/redis) | Redis World using BullMQ for queues, Redis Streams for output | ✅ Ready |
| [@workflow-worlds/turso](./packages/turso) | Turso/libSQL World for embedded or remote SQLite databases | ✅ Ready |

## Documentation

- [Introduction](./docs/01-introduction.md) - What is a World and why it exists
- [Interface Reference](./docs/02-interface-reference.md) - Complete API documentation
- [Implementation Guide](./docs/03-implementation-guide.md) - Step-by-step tutorial
- [Patterns & Practices](./docs/04-patterns-and-practices.md) - Key patterns and gotchas
- [Testing](./docs/05-testing.md) - Running the test suite
- [Production Checklist](./docs/06-production-checklist.md) - Production readiness

## AI/LLM Resources

This repository is optimized for AI-assisted development:

- [CLAUDE.md](./CLAUDE.md) - Quick reference for AI agents
- [llm/AGENTS.md](./llm/AGENTS.md) - Detailed agent instructions
- [llm/PROMPTS.md](./llm/PROMPTS.md) - Ready-to-use prompts
- [llm/world-builder-agent.md](./llm/world-builder-agent.md) - Comprehensive guide

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

## License

MIT
