"use strict";

// Return every cached CommonJS module reachable from the supplied roots.
// The cache is injectable so dependency tracking is deterministic in tests.
function collectModuleGraph(roots, cache = require.cache) {
  const files = new Set();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const mod = cache[file];
    if (!mod) continue;
    files.add(file);
    for (const child of mod.children ?? []) {
      if (typeof child?.filename === "string") pending.push(child.filename);
    }
  }
  return files;
}

// Capture the module objects and surviving-parent child lists needed to put a
// generation back exactly as it was after a failed candidate load. Module
// objects are intentionally retained by reference: last-known-good handlers
// close over those same CommonJS modules.
function snapshotModules(files, cache = require.cache) {
  const owned = new Set(files);
  const modules = new Map();
  const parentChildren = new Map();

  for (const file of owned) {
    if (cache[file]) modules.set(file, cache[file]);
  }
  for (const mod of Object.values(cache)) {
    if (
      !owned.has(mod?.filename) &&
      Array.isArray(mod?.children) &&
      mod.children.some((child) => owned.has(child?.filename))
    ) {
      parentChildren.set(mod, [...mod.children]);
    }
  }
  return { modules, parentChildren };
}

// Remove a generation's modules and detach them from cached parents. Detaching
// avoids retaining old module objects across repeated config reloads. Owned
// modules keep their internal child lists so a failed candidate can restore the
// previous graph without reconstructing module objects.
function evictModules(files, cache = require.cache) {
  const doomed = new Set(files);
  for (const mod of Object.values(cache)) {
    if (!doomed.has(mod?.filename) && Array.isArray(mod?.children)) {
      mod.children = mod.children.filter((child) => !doomed.has(child?.filename));
    }
  }
  for (const file of doomed) delete cache[file];
}

function restoreModules(snapshot, cache = require.cache) {
  for (const [file, mod] of snapshot.modules) cache[file] = mod;
  for (const [parent, children] of snapshot.parentChildren) {
    parent.children = [...children];
  }
}

module.exports = { collectModuleGraph, snapshotModules, evictModules, restoreModules };
