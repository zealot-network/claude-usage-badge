// config.js — the only place origins live.
// `npm run build:dev` rewrites this file inside dist-dev/ so a dev build talks
// to the local mock servers (dev/mock-server.mjs) instead of Anthropic.

export const CLAUDE_ORIGIN = "https://claude.ai";
export const CONSOLE_ORIGIN = "https://platform.claude.com";

// Verbose service-worker logging. Off in production.
export const DEBUG = false;
