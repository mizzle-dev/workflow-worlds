# Building Custom Worlds

This guide provides comprehensive documentation for building custom World implementations for the Workflow DevKit.

## What is a World?

A **World** is the abstraction layer that defines how workflows communicate with the outside world. It handles:

- **Storage**: Persisting workflow runs, steps, events, and hooks
- **Queue**: Message queueing for workflow and step invocations
- **Streaming**: Real-time I/O for workflow output

By implementing the World interface, you can run workflows on any infrastructure: PostgreSQL, MongoDB, Redis, cloud-specific services, or custom backends.

## Prerequisites

Before building a custom World, you should understand:

- TypeScript and async/await patterns
- The target infrastructure you're building for (database, queue system, etc.)
- Basic concepts of durable execution and event sourcing

## Documentation

| Document | Description |
|----------|-------------|
| [01 - Introduction](./01-introduction.md) | Architecture overview, core concepts, and how existing implementations compare |
| [02 - Interface Reference](./02-interface-reference.md) | Complete API documentation for Queue, Storage, and Streamer interfaces |
| [03 - Implementation Guide](./03-implementation-guide.md) | Step-by-step tutorial for building each component |
| [04 - Patterns & Practices](./04-patterns-and-practices.md) | Key patterns from production implementations |
| [05 - Testing](./05-testing.md) | Using `@workflow/world-testing` to validate your implementation |
| [06 - Production Checklist](./06-production-checklist.md) | Considerations for production-ready worlds |
| [07 - Workflow 4.1 Migration Guide](./07-workflow-4.1-migration.md) | Migrating adapters to the 4.1 event-sourced contract safely |

> Note: If you are upgrading an existing world implementation, start with [07 - Workflow 4.1 Migration Guide](./07-workflow-4.1-migration.md).

## Quick Start with the Starter

The [`packages/starter/`](../packages/starter/) directory contains a complete in-memory World implementation that:

1. **Passes all tests** - Run `pnpm test` immediately to verify
2. **Is well-documented** - Every method has comments explaining what it does
3. **Has TODO markers** - Shows where to swap in your real backend

To get started:

```bash
# Copy the starter to a new package
cp -r packages/starter packages/{your-backend}

# Update package.json name
cd packages/{your-backend}
# Edit package.json to change name to @workflow-worlds/{your-backend}

# Install dependencies
pnpm install

# Run the test suite
pnpm test
```

Then incrementally replace each in-memory implementation with your actual backend (MongoDB, Redis, etc.) while keeping tests green.

## Reference Implementations

Study these existing implementations (available as npm packages):

| Package | Description | Best For |
|---------|-------------|----------|
| `@workflow/world-local` | Filesystem-based storage, in-process queue | Local development, single-process |
| `@workflow/world-postgres` | PostgreSQL + pgboss | Multi-process, database-backed |
| `@workflow/world-vercel` | Vercel platform integration | Serverless on Vercel |

## Related Resources

- [Workflow DevKit](https://github.com/vercel/workflow) - Main framework repository
- [AI/LLM Resources](../llm/) - Instructions for AI-assisted development
