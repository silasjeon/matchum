// tab-groups — auto-group tabs by URL/title pattern.
//
// Usage: matchum.use("tab-groups", {
//   rules: [
//     { match: /github\.com/, group: "gh" },
//     { match: /docs\.google|notion\.so/, group: "docs" },
//   ],
// });
//
// On every tab.updated (page load, URL change), the first matching rule moves
// the tab into a Chrome tab group of that name (an existing group with the
// name is reused; otherwise one is created in the tab's window). Tabs already
// in the right group are left alone — no churn on reloads.

"use strict";

module.exports = function install(matchum, opts = {}) {
  const configuredRules = opts.rules ?? [{ match: /github\.com/, group: "gh" }];
  if (!Array.isArray(configuredRules)) {
    throw new Error("tab-groups: rules must be an array");
  }
  const rules = configuredRules.map((r) => {
    if (!(r?.match instanceof RegExp) || typeof r.group !== "string" || !r.group.trim()) {
      throw new Error("tab-groups: rules must be [{match: RegExp, group: non-empty string}]");
    }
    return r;
  });

  const grouped = new Map(); // tabId -> group name we last applied (avoid re-grouping)
  const pending = new Map(); // tabId -> {group, promise}; serialized per tab

  const matches = (pattern, ...values) => {
    const re = new RegExp(pattern.source, pattern.flags);
    return values.some((value) => {
      re.lastIndex = 0;
      return re.test(value || "");
    });
  };

  matchum.on("tab.updated", async (tab) => {
    const rule = rules.find((r) => matches(r.match, tab.url, tab.title));
    if (!rule) return;
    if (grouped.get(tab.id) === rule.group && tab.groupId >= 0) return;
    const previous = pending.get(tab.id);
    if (previous?.group === rule.group) return;
    const promise = previous
      ? previous.promise.catch(() => {}).then(() => tab.moveToGroup(rule.group))
      : Promise.resolve().then(() => tab.moveToGroup(rule.group));
    const operation = { group: rule.group, promise };
    pending.set(tab.id, operation);
    try {
      await promise;
      if (pending.get(tab.id) === operation) grouped.set(tab.id, rule.group);
    } catch (e) {
      matchum.log("tab-groups:", e.message); // e.g. tab closed mid-flight
    } finally {
      if (pending.get(tab.id) === operation) pending.delete(tab.id);
    }
  });

  matchum.on("tab.removed", (d) => {
    grouped.delete(d.tabId);
    pending.delete(d.tabId);
  });
};

module.exports.description = "Auto-file tabs into Chrome tab groups by URL pattern (default: github → gh)";
