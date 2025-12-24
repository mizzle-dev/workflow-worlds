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

## Considerations

### Backwards Compatibility

The PR notes: "New event logs that use this published version of `workflow` will be incompatible with previous workflow version event logs."

For World implementations:
- Existing data with `startedAt` field will need migration or aliasing
- Consider adding compatibility shim during transition

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
