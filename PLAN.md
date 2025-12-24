# Breaking Changes Migration Plan

## PR #621 Summary: Event-Sourced Architecture

This plan addresses the breaking changes from [vercel/workflow#621](https://github.com/vercel/workflow/pull/621) which introduces an event-sourced architecture.

---

## Breaking Changes Overview

### 1. Step Field Rename: `startedAt` → `firstStartedAt`

**Impact:** All 4 world implementations + documentation
**Reason:** Better semantics - "first" clarifies this is set once on initial start

**Files to update:**
- `packages/starter/src/storage.ts` - Step type and logic
- `packages/mongodb/src/storage.ts` - Step document and logic
- `packages/redis/src/storage.ts` - Step serialization and logic
- `packages/turso/src/storage.ts` - Step row conversion and logic
- `packages/turso/src/drizzle/schema.ts` - Column rename: `started_at` → `first_started_at`
- `docs/02-interface-reference.md` - Step type documentation
- `docs/04-patterns-and-practices.md` - Timestamp management section

### 2. Removal of Pause/Resume Functionality

**Impact:** All 4 world implementations + documentation
**Reason:** Feature was unused, simplifies state machine

**Status to remove:**
- `paused` from `WorkflowRunStatus` type

**Methods to remove from `runs` namespace:**
- `runs.pause(id, params)`
- `runs.resume(id, params)`

**Events removed:**
- `run_paused`
- `run_resumed`

**Files to update:**
- `packages/starter/src/storage.ts` - Remove pause/resume methods
- `packages/mongodb/src/storage.ts` - Remove pause/resume methods
- `packages/redis/src/storage.ts` - Remove pause/resume methods
- `packages/turso/src/storage.ts` - Remove pause/resume methods
- `docs/02-interface-reference.md` - Remove from runs interface, update status types
- `docs/04-patterns-and-practices.md` - Remove paused state from state machine diagram

### 3. New Run Lifecycle Events

**Impact:** Documentation only (implementations don't need changes)
**Reason:** Better observability and event sourcing support

**New event types:**
- `run_created` - When run is first created
- `run_started` - When run transitions to running
- `run_completed` - When run completes successfully
- `run_failed` - When run fails
- `run_cancelled` - When run is cancelled

**Files to update:**
- `docs/02-interface-reference.md` - Add new event types to EventType union

### 4. Step Event Changes

**Impact:** Documentation only
**Reason:** Cleaner separation of retry vs terminal failure

**Changes:**
- New `step_retrying` event type for non-fatal failures with retry
- `step_failed` event no longer includes `fatal` field (failure = terminal)

**Files to update:**
- `docs/02-interface-reference.md` - Update CreateEventRequest types, add step_retrying

### 5. Hook Token Conflict Error (Already Implemented ✓)

**Status:** No changes needed
All implementations already use `WorkflowAPIError` with status 409 for duplicate tokens.

---

## Implementation Tasks

### Phase 1: Schema Changes

1. **Turso Schema Migration**
   - Rename `started_at` → `first_started_at` in `steps` table
   - Create migration script or document manual migration steps

### Phase 2: Storage Implementation Updates

2. **Starter World** (`packages/starter/src/storage.ts`)
   - Rename `startedAt` → `firstStartedAt` in Step interface usage
   - Update timestamp logic for `firstStartedAt`
   - Remove `pause()` and `resume()` methods from runs

3. **MongoDB World** (`packages/mongodb/src/storage.ts`)
   - Rename `startedAt` → `firstStartedAt` in StepDocument interface
   - Update timestamp logic
   - Remove `pause()` and `resume()` methods

4. **Redis World** (`packages/redis/src/storage.ts`)
   - Rename `startedAt` → `firstStartedAt` in Step handling
   - Update timestamp logic
   - Remove `pause()` and `resume()` methods

5. **Turso World** (`packages/turso/src/storage.ts`)
   - Update `toStep()` conversion function
   - Update timestamp logic
   - Remove `pause()` and `resume()` methods

### Phase 3: Documentation Updates

6. **Interface Reference** (`docs/02-interface-reference.md`)
   - Update Step type: `startedAt` → `firstStartedAt`
   - Remove `pause()` and `resume()` from runs interface
   - Remove `paused` from WorkflowRunStatus
   - Add new run lifecycle events to EventType
   - Add `step_retrying` to CreateEventRequest
   - Remove `fatal` field from `step_failed` event data

7. **Patterns & Practices** (`docs/04-patterns-and-practices.md`)
   - Update timestamp management section
   - Update state machine diagram (remove paused state)
   - Update valid transitions table

8. **CLAUDE.md** - Review and update any affected guidance

### Phase 4: Testing & Validation

9. **Build and Test**
   - Run `pnpm build` to verify no type errors
   - Run `pnpm test` to verify all tests pass
   - Note: Tests may need to be updated if they test pause/resume

---

## Backwards Compatibility Strategy

### Recommended Approach: Phased Rollout

We recommend a **3-phase rollout** to ensure zero-downtime migrations for users with existing data.

---

### Phase A: Add Compatibility Layer (Pre-PR merge)

Deploy world updates that **read both old and new field names** while **writing to new names only**.

#### Step Field: `startedAt` → `firstStartedAt`

```typescript
// In toStep() or equivalent conversion function:
function toStep(row: StepRow): Step {
  return {
    // ... other fields
    // Read new field, fall back to old field for existing data
    firstStartedAt: row.firstStartedAt ?? row.startedAt ?? undefined,
    // Keep startedAt for backwards compat during transition
    startedAt: row.firstStartedAt ?? row.startedAt ?? undefined,
  };
}

// In steps.update():
async update(runId, stepId, data) {
  // Write to new field name
  if (data.status === 'running' && !existing.firstStartedAt) {
    updated.firstStartedAt = now;
  }
}
```

#### Pause/Resume: Deprecation Warnings

```typescript
// Keep methods but mark deprecated and log warnings
async pause(id, params): Promise<WorkflowRun> {
  console.warn('[DEPRECATED] runs.pause() will be removed in next major version');
  const run = await this.update(id, { status: 'paused' });
  return filterRunData(run, params?.resolveData);
},

async resume(id, params): Promise<WorkflowRun> {
  console.warn('[DEPRECATED] runs.resume() will be removed in next major version');
  const run = await this.update(id, { status: 'running' });
  return filterRunData(run, params?.resolveData);
},
```

---

### Phase B: Data Migration (Post-PR merge)

Once `@workflow/world` is updated with new types, run migrations to update existing data.

#### MongoDB Migration Script

```javascript
// Rename startedAt → firstStartedAt in steps collection
db.steps.updateMany(
  { startedAt: { $exists: true }, firstStartedAt: { $exists: false } },
  [{ $set: { firstStartedAt: "$startedAt" } }, { $unset: "startedAt" }]
);

// Update any paused runs to cancelled (or running, depending on preference)
db.runs.updateMany(
  { status: "paused" },
  { $set: { status: "cancelled", updatedAt: new Date() } }
);
```

#### Redis Migration Script

```typescript
// Scan for step keys and rename field
const stepKeys = await redis.keys('workflow:steps:*');
for (const key of stepKeys) {
  const startedAt = await redis.hget(key, 'startedAt');
  if (startedAt) {
    await redis.hset(key, 'firstStartedAt', startedAt);
    await redis.hdel(key, 'startedAt');
  }
}
```

#### Turso/SQLite Migration

```sql
-- Add new column
ALTER TABLE workflow_steps ADD COLUMN first_started_at TEXT;

-- Copy data
UPDATE workflow_steps SET first_started_at = started_at WHERE started_at IS NOT NULL;

-- Note: SQLite doesn't support DROP COLUMN easily
-- Option 1: Leave old column (harmless, just unused)
-- Option 2: Recreate table without old column

-- Handle paused runs
UPDATE workflow_runs SET status = 'cancelled', updated_at = datetime('now')
WHERE status = 'paused';
```

---

### Phase C: Remove Compatibility Code

After sufficient time (e.g., 2-4 weeks) or after confirming all users have migrated:

1. Remove `startedAt` fallback reads
2. Remove deprecated `pause()`/`resume()` methods
3. Remove old column from schema (optional for Turso)

---

## Alternative: Big Bang Migration

If backwards compatibility isn't critical (e.g., new deployments, test environments):

1. Update `@workflow/world` dependency
2. Apply all changes at once
3. Run data migration scripts
4. Deploy

**Pros:** Simpler, no dual-field logic
**Cons:** Requires downtime or careful coordination

---

## Rollout Checklist

### Phase A (Compatibility Layer)
- [ ] Add `firstStartedAt` field alongside `startedAt` in all worlds
- [ ] Add deprecation warnings to `pause()`/`resume()`
- [ ] Test with existing data
- [ ] Deploy to production

### Phase B (Migration)
- [ ] Wait for PR #621 to merge
- [ ] Update `@workflow/world` dependency
- [ ] Run migration scripts per backend
- [ ] Verify data integrity

### Phase C (Cleanup)
- [ ] Remove `startedAt` fallback logic
- [ ] Remove `pause()`/`resume()` methods
- [ ] Update types to match new `@workflow/world`
- [ ] Final testing and deployment

---

## Considerations

### Event Sourcing Architecture

The PR introduces event sourcing where entities are "materializations of the event log." However, this is primarily an internal core change. World implementations:
- Continue to provide storage for runs, steps, events, hooks
- The core runtime handles the event-to-entity materialization
- No fundamental changes to World interface expected

### Timing

These changes should be implemented **after** PR #621 is merged and a new `@workflow/world` package version is published. Until then, the type definitions from `@workflow/world` won't reflect these changes.

---

## Checklist

- [ ] Turso schema migration prepared
- [ ] Starter world updated
- [ ] MongoDB world updated
- [ ] Redis world updated
- [ ] Turso world updated
- [ ] Interface reference docs updated
- [ ] Patterns & practices docs updated
- [ ] CLAUDE.md reviewed/updated
- [ ] All packages build successfully
- [ ] All tests pass
