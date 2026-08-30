// matchum config — intentionally inert on first install.
//
// Add only behavior you trust and want running in your signed-in browser. See
// examples/config.showcase.js in the matchum repository for opt-in examples.

"use strict";

// Example: uncomment to group matching tabs.
// matchum.use("tab-groups", {
//   rules: [{ match: /github\.com/, group: "dev" }],
// });

// Example: uncomment to react to a browser event.
// matchum.on("tab.updated", (tab) => {
//   matchum.log("visited", tab.url);
// });

// Example: uncomment to change matching pages.
// matchum.style(/example\.com/, `body { max-width: 72rem; margin-inline: auto; }`);
