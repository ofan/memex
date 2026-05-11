#!/usr/bin/env node
/**
 * Postinstall: verify better-sqlite3's native binding loads. If not (because
 * the prebuilt binary doesn't match the current Node ABI — common on
 * bleeding-edge Node versions like 26+ before upstream ships prebuilds),
 * rebuild from source.
 *
 * Cost: ~30s extra install time when the rebuild kicks in.
 * Benefit: memex installs cleanly under any Node ≥ 22 without manual steps.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

function tryRequire(mod) {
  try {
    require(mod);
    return null;
  } catch (err) {
    return err;
  }
}

const err = tryRequire("better-sqlite3");
if (!err) {
  // Prebuilt binding loads — nothing to do.
  process.exit(0);
}

console.warn(`[memex postinstall] better-sqlite3 prebuilt binding failed to load: ${err.message.split("\n")[0]}`);
console.warn(`[memex postinstall] Node version: ${process.version}. Rebuilding better-sqlite3 from source...`);

const cwd = path.join(__dirname, "..", "node_modules", "better-sqlite3");
const result = spawnSync("npm", ["run", "build-release"], { cwd, stdio: "inherit" });

if (result.status !== 0) {
  console.error(`[memex postinstall] Native rebuild failed (exit ${result.status}).`);
  console.error(`[memex postinstall] You can retry manually: cd node_modules/better-sqlite3 && npm run build-release`);
  // Don't fail the install — memex's CLI/MCP server might still work for
  // some commands; tests and gateway features that need sqlite will surface
  // a clearer error at runtime.
  process.exit(0);
}

const err2 = tryRequire("better-sqlite3");
if (err2) {
  console.error(`[memex postinstall] Rebuild completed but binding still doesn't load: ${err2.message.split("\n")[0]}`);
  process.exit(0);
}

console.log(`[memex postinstall] better-sqlite3 native binding rebuilt OK.`);
