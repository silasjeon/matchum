// matchum showcase — copy only the pieces you explicitly want into
// ~/.config/matchum/config.js. This file is never installed or executed.

"use strict";

// Log every new tab.
matchum.on("tab.created", (tab) => {
  matchum.log(`new tab: ${tab.url || "(blank)"}`);
});

// Auto-group GitHub pages.
matchum.use("tab-groups", {
  rules: [{ match: /github\.com/, group: "dev" }],
});

// Warn when too many tabs are open.
matchum.every("10m", async () => {
  const tabs = await matchum.tabs.list();
  if (tabs.length > 40) matchum.notify(`${tabs.length} tabs open`, "matchum: tab hygiene");
});

// Keep a local navigation history. This intentionally records URLs and titles.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const stateDir = path.join(os.homedir(), ".local", "state", "matchum");
const historyFile = path.join(stateDir, "history.jsonl");
const lastUrl = new Map();

matchum.on("tab.updated", (tab) => {
  if (!tab.url || tab.url === lastUrl.get(tab.id)) return;
  lastUrl.set(tab.id, tab.url);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(
    historyFile,
    `${JSON.stringify({ ts: new Date().toISOString(), tabId: tab.id, url: tab.url, title: tab.title })}\n`
  );
});

matchum.on("tab.removed", ({ tabId }) => lastUrl.delete(tabId));

// Save Claude conversations locally whenever their DOM settles. This intentionally
// records conversation text; selectors may need updating when the site changes.
const claudeDir = path.join(stateDir, "claude");

matchum.watch(
  /claude\.ai\/chat\/[0-9a-f-]+/,
  "[data-test-render-count]",
  (hit) => {
    const conversationId = hit.url.match(/chat\/([0-9a-f-]+)/)?.[1];
    if (!conversationId) return;
    const messages = hit.items.map((raw) => {
      const role = raw.startsWith("You said:") ? "user" : "assistant";
      const text = raw
        .replace(/^You said:\s*/, "")
        .replace(/^Claude responded:\s*/, "")
        .split("\n")
        .filter((line) => !/^Thought for \d+[ms]?\s?\d*s?$/.test(line.trim()))
        .join("\n")
        .trim();
      return { role, text };
    });
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, `${conversationId}.json`),
      `${JSON.stringify({ url: hit.url, title: hit.title, savedAt: new Date().toISOString(), messages }, null, 2)}\n`
    );
  },
  { debounceMs: 1500 }
);

// Live site styling.
matchum.style(
  /claude\.ai/,
  `
  [data-test-render-count] {
    font-family: "Noto Serif KR", "AppleMyungjo", ui-serif, Georgia, serif;
    font-size: 1.02rem;
    line-height: 1.85;
  }
  [data-test-render-count] pre,
  [data-test-render-count] code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    line-height: 1.55;
  }
  `
);

// Other opt-in building blocks:
// matchum.overlay("tabcount", /./, {
//   html: `<button data-matchum-toggle>toggle</button><span>hello</span>`,
//   css: `.matchum-wrap { position: fixed; top: 12px; right: 12px; }`,
// });
//
// matchum.run(/youtube\.com/, `
//   setInterval(() => document.querySelector(".ytp-skip-ad-button")?.click(), 500);
// `);
