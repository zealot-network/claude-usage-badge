// dev/package.mjs — builds the Chrome Web Store zip from the shipped files
// only (no dev/, tests/, package.json or node_modules).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED = [
  "manifest.json", "config.js", "background.js", "popup.html", "popup.js",
  "content-script.js", "page-inject.js", "lib", "icons", "LICENSE",
];
const { version } = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const config = fs.readFileSync(path.join(root, "config.js"), "utf8");
if (!config.includes('"https://claude.ai"') || !/DEBUG = false/.test(config)) {
  throw new Error("config.js is not the production config — refusing to package.");
}
const zip = path.resolve(root, "..", `claude-usage-badge-v${version}.zip`);
fs.rmSync(zip, { force: true });
execFileSync("zip", ["-r", "-q", zip, ...SHIPPED, "-x", "*.DS_Store"], { cwd: root });
console.log(`packaged → ${zip}`);
