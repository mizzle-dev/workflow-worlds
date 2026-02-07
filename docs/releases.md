# Release Guide

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.

## Stable releases (`latest`)

Stable releases are fully automated:

1. Open a PR with one or more changeset files (`pnpm changeset`).
2. Merge to `main`.
3. The `Test` workflow runs on `main`.
4. If tests pass, the `Release` workflow runs and `changesets/action` will:
   - create or update a release PR (`chore: release packages`), or
   - publish packages when that release PR is merged.

## Beta releases (`beta`)

Use the **Release Beta** GitHub Actions workflow for pre-releases.

From Actions:

1. Select **Release Beta**.
2. Set `ref` (branch, tag, or SHA), default is `main`.
3. Set `snapshot-tag`, default is `beta`.
4. Run workflow.

The workflow will:

1. Build and run tests.
2. Generate snapshot versions (`changeset version --snapshot <tag>`).
3. Publish to npm using `--tag <tag>` (for example `beta`).

Install beta versions with:

```bash
pnpm add @workflow-worlds/starter@beta
```

## Notes

- Beta releases do not affect the `latest` dist-tag.
- Stable releases should only come from `main`.
