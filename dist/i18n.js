/**
 * Language: French (source language of the UI) or English. Detected from the device (navigator.languages),
 * with a manual override stored under "lang". English is applied by translating the DOM (static text, attributes
 * and every later change) with the dictionary in i18n-en.js; strings with a dynamic part use `§` placeholders.
 */
import dictionary from "./i18n-en.js";

const STORAGE_KEY = "lang";

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "fr" || saved === "en") return saved;
  } catch { /* storage unavailable */ }
  const preferred = String(navigator.languages?.[0] ?? navigator.language ?? "en").toLowerCase();
  return preferred.startsWith("fr") ? "fr" : "en";
}

export const lang = detect();
export const locale = lang === "fr" ? "fr-FR" : "en-US";
document.documentElement.lang = lang;

export function setLang(next) {
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
  window.location.reload();
}

const exact = new Map();
const patterns = [];
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const [french, english] of Object.entries(dictionary)) {
  if (!french.includes("§")) { exact.set(french, english); continue; }
  const literals = french.split("§");
  const anchor = literals.reduce((longest, part) => (part.length > longest.length ? part : longest), "");
  // Short patterns ("§ min") would swallow any sentence ending the same way: restrict what they may capture.
  const capture = french.startsWith("§") && literals.join("").replace(/[^A-Za-zÀ-ÿ]/g, "").length < 8 ? "([^\\s·]+)" : "(.*?)";
  patterns.push({ regex: new RegExp(`^${literals.map(escapeRegex).join(capture)}$`, "s"), english, anchor });
}
patterns.sort((a, b) => b.anchor.length - a.anchor.length);

const cache = new Map();

function fill(template, captures) {
  let next = 0;
  return template.replace(/§(\d)?/g, (_, index) => {
    const value = captures[index ? Number(index) - 1 : next++] ?? "";
    return translate(value);
  });
}

/** Prices and percentages are written the French way in the source ("20 $", "12 %"). */
function localizeNumbers(text) {
  return text
    .replace(/(\d) %/g, "$1%")
    .replace(/([+−-]?)(\d[\d.,]*)([KMB]) \$/g, "$1$$$2$3")
    .replace(/([+−-]?)(\d[\d.,]*) ?k\$/g, "$1$$$2K")
    .replace(/([+−-]?)(\d[\d.,]*) ?M\$/g, "$1$$$2M")
    .replace(/([+−-]?)(\d[\d   ]*(?:[.,]\d+)?) \$(?![\w§])/g, (_, sign, amount) => `${sign}$${amount.replace(/[   ]/g, ",")}`);
}

function translateCore(text) {
  const hit = exact.get(text);
  if (hit !== undefined) return hit;
  for (const pattern of patterns) {
    if (!text.includes(pattern.anchor)) continue;
    const match = pattern.regex.exec(text);
    if (match) return fill(pattern.english, match.slice(1));
  }
  for (const separator of [" — ", " · "]) { // "a — b" and "a · b · c": translate every part
    if (!text.includes(separator)) continue;
    const parts = text.split(separator);
    const translated = parts.map(part => translateCore(part));
    if (translated.some((part, index) => part !== parts[index])) return translated.join(separator);
  }
  return text;
}

/** Translates one string (identity in French). Keeps the surrounding whitespace. */
export function translate(text) {
  if (lang === "fr" || typeof text !== "string" || !text.trim()) return text;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const result = lead + localizeNumbers(translateCore(core.replace(/\s+/g, " "))) + trail;
  if (cache.size > 6000) cache.clear();
  cache.set(text, result);
  return result;
}
export const t = translate;

const ATTRIBUTES = ["title", "placeholder", "aria-label", "alt"];
const NEEDS_TRANSLATION = /[A-Za-zÀ-ÿ$%]|\d,\d/;

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue;
    if (!NEEDS_TRANSLATION.test(value)) return;
    const next = translate(value);
    if (next !== value) node.nodeValue = next;
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.tagName === "SCRIPT" || node.tagName === "STYLE" || node.tagName === "TEXTAREA") return;
    for (const name of ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value) { const next = translate(value); if (next !== value) node.setAttribute(name, next); }
    }
    for (const child of node.childNodes) translateNode(child);
  }
}

if (lang === "en") {
  const run = () => {
    document.title = translate(document.title);
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute("content", translate(description.getAttribute("content")));
    translateNode(document.body);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "characterData") translateNode(record.target);
        else if (record.type === "attributes") translateNode(record.target);
        else for (const added of record.addedNodes) translateNode(added);
      }
      observer.takeRecords();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  };
  if (document.body) run(); else document.addEventListener("DOMContentLoaded", run);
}
