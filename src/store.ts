import type { ConsultCallTurn, TestCall } from './types.js';

/**
 * Every placed call, in memory.
 *
 * Replaces the Mongoose repository. A test call lives for a couple of minutes
 * and is read by nothing after it ends, so a Map is the honest data store for
 * it - the alternative was a database dependency for a rig whose whole point is
 * being quick to start.
 *
 * The cost, and it is a real one: a restart loses in-flight calls. Running under
 * `npm run dev` (watch mode) and saving a file mid-conversation will drop the
 * call - the next webhook 404s, and Twilio hangs up. Use `npm start` for calls
 * you actually care about.
 */

const byId = new Map<string, TestCall>();
const tokenToId = new Map<string, string>();

/** How long a finished call is kept before the sweep drops it. */
const RETENTION_MS = 60 * 60_000;

export function insert(call: TestCall): TestCall {
  byId.set(call.id, call);
  tokenToId.set(call.webhookToken, call.id);
  return call;
}

export function findById(id: string): TestCall | null {
  return byId.get(id) ?? null;
}

export function findByToken(token: string): TestCall | null {
  const id = tokenToId.get(token);
  return id ? (byId.get(id) ?? null) : null;
}

/** Newest first. Only used by the page, to show what has been placed this session. */
export function list(limit = 20): TestCall[] {
  return [...byId.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

export interface UpdateInput {
  /** Mongo's `$set`. */
  set?: Partial<TestCall>;
  /** Mongo's `$push: { turns: ... }`. */
  pushTurn?: ConsultCallTurn;
}

/**
 * Applies one update, in place.
 *
 * MUTATES the stored object rather than replacing it with a spread of the
 * caller's copy, and that is load-bearing rather than a shortcut. A handler can
 * hold its `call` for eight seconds while the model thinks; meanwhile the async
 * AMD callback may have settled the same call as voicemail. Spreading a stale
 * snapshot back over the store would silently revert that. With one canonical
 * mutable object per call, the later write wins, which is what it should do.
 */
export function update(id: string, input: UpdateInput): TestCall | null {
  const call = byId.get(id);
  if (!call) return null;
  if (input.set) Object.assign(call, input.set);
  if (input.pushTurn) call.turns.push(input.pushTurn);
  return call;
}

/**
 * Drops calls that ended over an hour ago, so a long-running process does not
 * accumulate them. Started by the server; harmless if it never runs.
 */
export function startSweep(intervalMs = 10 * 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, call] of byId) {
      if (call.createdAt.getTime() < cutoff) {
        byId.delete(id);
        tokenToId.delete(call.webhookToken);
      }
    }
  }, intervalMs);
  // Never hold the process open for a housekeeping timer.
  timer.unref();
  return timer;
}
