// lib/entitlements.js — single choke point for premium features.
//
// Nothing is paywalled in this build: every feature resolves to unlocked.
// When a one-time purchase is added, this is the only file that needs to
// learn about it (e.g. read a cached `paid` flag from chrome.storage.local).
// Callers must go through isUnlocked() and never check payment state directly.

export const FEATURES = Object.freeze({
  MULTI_ORG: "multi_org",   // track every org on the signed-in login, pin the badge
  TEAM: "team",             // Team / Enterprise seat spend-limit view
  CONSOLE: "console",       // API Console balance + spend
});

// eslint-disable-next-line no-unused-vars
export async function isUnlocked(feature) {
  return true;
}
