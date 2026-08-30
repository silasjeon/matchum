"use strict";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Single source of truth for the config-state shape. Add a registry here and it
// automatically participates in create/snapshot/restore/dispose — no four-place edit,
// so a new spec kind can't silently skip rollback. "map" holds keyed registries
// (handlers keeps arrays as values); "array" holds ordered ones.
const COLLECTIONS = {
  handlers: "map",
  rules: "array",
  timers: "array",
  watches: "array",
  styles: "array",
  overlays: "map",
  scripts: "array",
  recipes: "array",
  pages: "map",
};

function createConfigState() {
  const state = {};
  for (const [name, kind] of Object.entries(COLLECTIONS)) {
    state[name] = kind === "map" ? new Map() : [];
  }
  return state;
}

function snapshotRegistrations(state) {
  const snapshot = {};
  for (const [name, kind] of Object.entries(COLLECTIONS)) {
    if (kind === "map") {
      // Copy array-valued entries (handlers) so a later push can't mutate the snapshot;
      // object/function values (overlays, pages) are shared, matching a shallow copy.
      snapshot[name] = new Map(
        [...state[name]].map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
      );
    } else {
      snapshot[name] = [...state[name]];
    }
  }
  return snapshot;
}

function restoreRegistrations(state, snapshot, clearIntervalFn = clearInterval) {
  const retainedTimers = new Set(snapshot.timers);
  for (const timer of state.timers) {
    if (!retainedTimers.has(timer)) clearIntervalFn(timer);
  }
  Object.assign(state, snapshot);
}

function disposeConfigState(state, clearIntervalFn = clearInterval) {
  for (const timer of state.timers) clearIntervalFn(timer);
  for (const [name, kind] of Object.entries(COLLECTIONS)) {
    if (kind === "map") state[name].clear();
    else state[name].length = 0;
  }
}

function parseInterval(spec) {
  const match = /^([1-9]\d*)(s|m|h)$/.exec(String(spec));
  if (!match) throw new Error(`invalid interval: ${spec} (use e.g. "30s", "5m", "1h")`);
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
  const milliseconds = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_TIMER_DELAY_MS) {
    throw new Error(`interval is too large: ${spec}`);
  }
  return milliseconds;
}

function regexMatches(pattern, ...values) {
  const re = new RegExp(pattern.source, pattern.flags);
  return values.some((value) => {
    re.lastIndex = 0;
    return re.test(String(value ?? ""));
  });
}

function parseRecipeState(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Object.create(null);
  return Object.assign(Object.create(null), parsed);
}

module.exports = {
  MAX_TIMER_DELAY_MS,
  createConfigState,
  snapshotRegistrations,
  restoreRegistrations,
  disposeConfigState,
  parseInterval,
  regexMatches,
  parseRecipeState,
};
