/**
 * Guarded commits for the Redis World.
 *
 * Every `events.create()` ends in one call to `COMMIT_SCRIPT`: a Lua
 * script that checks a list of guards against the current entity state,
 * applies the entity writes, and appends the event, all inside one atomic
 * script execution. Redis runs a script to completion before any other
 * command, so nothing can interleave between the guards and the writes.
 *
 * The event's position is allocated by `INCR` on the run's sequence key in
 * the same script that stores the event, so a position is never handed out
 * without its event landing: the log stays dense, and a reader that has
 * passed position N can never see a new event appear below N.
 *
 * A failed guard writes nothing. The caller re-reads the state and decides
 * again, so a lost race surfaces as the right error (or succeeds) on the next
 * attempt rather than as a corrupted write.
 */

import type { Redis } from 'ioredis';

export type Guard =
  /** The hash's `status` field is one of the values (a missing hash fails). */
  | { t: 'status_in'; k: string; v: string[] }
  /** The hash exists and its `status` field is none of the values. */
  | { t: 'status_not_in'; k: string; v: string[] }
  | { t: 'exists'; k: string }
  | { t: 'absent'; k: string }
  /** A hash field holds exactly this value; `null` means the field is unset. */
  | { t: 'field_eq'; k: string; f: string; v: string | null }
  /** A hash field is unset or sorts at or before `v` (ISO timestamps). */
  | { t: 'field_le'; k: string; f: string; v: string };

export type Op =
  /** HSET of `fields`, a flat [field, value, ...] list. */
  | { o: 'hset'; k: string; fields: string[] }
  | { o: 'hdel'; k: string; fields: string[] }
  /** HSET only if the field is unset. */
  | { o: 'hsetnx'; k: string; f: string; v: string }
  | { o: 'hincrby'; k: string; f: string; by: number }
  | { o: 'del'; k: string }
  | { o: 'set'; k: string; v: string }
  | { o: 'zadd'; k: string; s: number; m: string }
  | { o: 'zrem'; k: string; m: string }
  | { o: 'sadd'; k: string; m: string }
  | { o: 'srem'; k: string; m: string }
  /**
   * Deletes every hook the run holds, with its token claim, then the index.
   * Done in the script rather than from a list read beforehand, so a hook
   * created concurrently cannot outlive its run.
   */
  | { o: 'drop_hooks'; idx: string; hookPrefix: string; tokenPrefix: string }
  /** Deletes every member key `${prefix}${member}` of a set, then the set. */
  | { o: 'drop_set'; idx: string; prefix: string };

export interface EventAppend {
  /** INCR'd to allocate the position. */
  seq: string;
  /** Hash: eventId -> encoded event body. */
  hash: string;
  /** Sorted set: eventId scored by position. */
  idx: string;
  /** Per-correlation sorted set, when the event has a correlation ID. */
  corr?: string;
  prefix: string;
  width: number;
  body: string;
}

export type CommitResult =
  /** `eventIds` lists the appended events' IDs, in append order. */
  | { ok: true; eventIds: string[]; eventId?: string }
  | { ok: false; failedGuard: number };

const COMMIT_SCRIPT = `
local plan = cjson.decode(ARGV[1])

local function contains(list, value)
  for _, item in ipairs(list) do
    if item == value then return true end
  end
  return false
end

for i, g in ipairs(plan.guards) do
  local ok = true
  if g.t == 'status_in' then
    local s = redis.call('HGET', g.k, 'status')
    ok = s and contains(g.v, s)
  elseif g.t == 'status_not_in' then
    local s = redis.call('HGET', g.k, 'status')
    ok = s and not contains(g.v, s)
  elseif g.t == 'exists' then
    ok = redis.call('EXISTS', g.k) == 1
  elseif g.t == 'absent' then
    ok = redis.call('EXISTS', g.k) == 0
  elseif g.t == 'field_eq' then
    local value = redis.call('HGET', g.k, g.f)
    if g.v == cjson.null then
      ok = value == false
    else
      ok = value == g.v
    end
  elseif g.t == 'field_le' then
    local value = redis.call('HGET', g.k, g.f)
    ok = (not value) or value == '' or value <= g.v
  end
  if not ok then
    return {0, i}
  end
end

for _, op in ipairs(plan.ops) do
  if op.o == 'hset' then
    if #op.fields > 0 then redis.call('HSET', op.k, unpack(op.fields)) end
  elseif op.o == 'hdel' then
    if #op.fields > 0 then redis.call('HDEL', op.k, unpack(op.fields)) end
  elseif op.o == 'hsetnx' then
    redis.call('HSETNX', op.k, op.f, op.v)
  elseif op.o == 'hincrby' then
    redis.call('HINCRBY', op.k, op.f, op.by)
  elseif op.o == 'del' then
    redis.call('DEL', op.k)
  elseif op.o == 'set' then
    redis.call('SET', op.k, op.v)
  elseif op.o == 'zadd' then
    redis.call('ZADD', op.k, op.s, op.m)
  elseif op.o == 'zrem' then
    redis.call('ZREM', op.k, op.m)
  elseif op.o == 'sadd' then
    redis.call('SADD', op.k, op.m)
  elseif op.o == 'srem' then
    redis.call('SREM', op.k, op.m)
  elseif op.o == 'drop_hooks' then
    for _, hookId in ipairs(redis.call('SMEMBERS', op.idx)) do
      local token = redis.call('HGET', op.hookPrefix .. hookId, 'token')
      if token then
        local owner = redis.call('GET', op.tokenPrefix .. token)
        if owner == hookId then redis.call('DEL', op.tokenPrefix .. token) end
      end
      redis.call('DEL', op.hookPrefix .. hookId)
    end
    redis.call('DEL', op.idx)
  elseif op.o == 'drop_set' then
    for _, member in ipairs(redis.call('SMEMBERS', op.idx)) do
      redis.call('DEL', op.prefix .. member)
    end
    redis.call('DEL', op.idx)
  end
end

local reply = {1}
for _, ev in ipairs(plan.events) do
  local slot = redis.call('INCR', ev.seq)
  local eventId = ev.prefix .. string.format('%0' .. ev.width .. 'd', slot)
  redis.call('HSET', ev.hash, eventId, ev.body)
  redis.call('ZADD', ev.idx, slot, eventId)
  if ev.corr and ev.corr ~= cjson.null then
    redis.call('ZADD', ev.corr, slot, eventId)
  end
  table.insert(reply, eventId)
end
return reply
`;

/**
 * Runs one guarded commit. `events` are appended in order, each at the next
 * position, so several events written by one create stay contiguous.
 * `failedGuard` is the 1-based index of the first guard that did not hold.
 */
export async function commit(
  redis: Redis,
  plan: { guards: Guard[]; ops: Op[]; event?: EventAppend; events?: EventAppend[] }
): Promise<CommitResult> {
  const events = [...(plan.events ?? []), ...(plan.event ? [plan.event] : [])];
  const reply = (await redis.eval(
    COMMIT_SCRIPT,
    0,
    JSON.stringify({ guards: plan.guards, ops: plan.ops, events })
  )) as (number | string)[];
  if (reply[0] === 1) {
    const eventIds = reply.slice(1) as string[];
    return { ok: true, eventIds, eventId: eventIds[eventIds.length - 1] };
  }
  return { ok: false, failedGuard: Number(reply[1] ?? 0) };
}
