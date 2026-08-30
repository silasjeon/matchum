"use strict";

function normalizeIndex(index) {
  const value = Number(index);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`snapshot index must be a non-negative integer: ${index}`);
  }
  return value;
}

function snapshotScript({ viewport = false } = {}) {
  return `
  const VIEWPORT_ONLY = ${viewport ? "true" : "false"};
  const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=textbox],[contenteditable=true]';
  // Clear indices from a previous snapshot so click/type never resolve a stale element.
  for (const el of document.querySelectorAll('[data-matchum-i]')) el.removeAttribute('data-matchum-i');
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (VIEWPORT_ONLY && !inView(r)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').trim().replace(/[\\s\\ue000-\\uf8ff]+/g, ' ').trim().slice(0, 80);
    const role = el.getAttribute('role') || { A: 'link', BUTTON: 'button', INPUT: el.type || 'input', SELECT: 'select', TEXTAREA: 'textbox' }[el.tagName] || el.tagName.toLowerCase();
    el.setAttribute('data-matchum-i', out.length);
    const e = { i: out.length, role, name, tag: el.tagName.toLowerCase(), inView: inView(r) };
    if (el.href) e.href = el.href;
    out.push(e);
    if (out.length >= 300) break;
  }
  return { url: location.href, title: document.title, scrollY: Math.round(scrollY), viewportH: innerHeight, items: out };
`;
}

function visibleTextScript() {
  return `
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      const cs = getComputedStyle(p);
      if (cs.visibility === "hidden" || cs.display === "none") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts = [];
  const range = document.createRange();
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    const t = n.nodeValue.replace(/\\s+/g, " ").trim();
    parts.push(t);
    total += t.length;
    if (total > 20000) break;
  }
  return parts.join("\\n");
`;
}

function clickScript(index) {
  const value = normalizeIndex(index);
  return `
  const el = document.querySelector('[data-matchum-i="${value}"]');
  if (!el) throw new Error("no element ${value}; call snapshot() first");
  const info = { tag: el.tagName.toLowerCase(), name: (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().slice(0, 60), href: el.href || null };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { acted: info, urlBefore: location.href };
`;
}

function typeScript(index, text, { enter = false } = {}) {
  const value = normalizeIndex(index);
  const serialized = JSON.stringify(String(text));
  const enterScript = enter
    ? `
  let keydownCanceled = false;
  for (const type of ["keydown", "keypress", "keyup"]) {
    const event = new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true });
    const accepted = el.dispatchEvent(event);
    if (type === "keydown" && !accepted) keydownCanceled = true;
  }
  // requestSubmit models the browser's default Enter action only when the page
  // did not cancel keydown.
  if (!keydownCanceled) el.form?.requestSubmit?.();
`
    : "";
  return `
  const el = document.querySelector('[data-matchum-i="${value}"]');
  if (!el) throw new Error("no element ${value}; call snapshot() first");
  el.focus();
  if (el.isContentEditable) {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, ${serialized});
  } else {
    const setValue = Object.getOwnPropertyDescriptor(el.__proto__, "value")?.set;
    if (setValue) setValue.call(el, ${serialized});
    else el.value = ${serialized};
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  ${enterScript}
  const readBack = el.isContentEditable ? el.innerText : el.value;
  return { acted: { typed: readBack, matches: readBack === ${serialized} }, urlBefore: location.href };
`;
}

module.exports = { normalizeIndex, snapshotScript, visibleTextScript, clickScript, typeScript };
