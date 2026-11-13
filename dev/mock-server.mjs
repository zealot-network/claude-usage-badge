// dev/mock-server.mjs — local stand-ins for claude.ai and the API Console.
//
//   node dev/mock-server.mjs            # claude.ai → http://localhost:8787
//                                       # Console   → http://127.0.0.1:8788
//
// (Different hostnames on purpose: cookies ignore ports, and the two real
// sites keep separate `lastActiveOrg` cookies.)
//
// Control endpoints (both servers):
//   GET /__scenario?name=multi-org   switch scenario
//   GET /__login?org=<uuid>          set the lastActiveOrg cookie
//   GET /__logout                    clear it
//   GET /__log                       requests seen since the last switch

import http from "node:http";
import { CLAUDE_SCENARIOS, CONSOLE_SCENARIOS, ORG } from "./scenarios.mjs";

export function createMock({ name, scenarios, initial, port, host }) {
  let current = initial;
  let log = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };

    if (url.pathname === "/__scenario") {
      const next = url.searchParams.get("name");
      if (!scenarios[next]) return send(404, { error: `unknown scenario ${next}`, known: Object.keys(scenarios) });
      current = next;
      log = [];
      return send(200, { scenario: current });
    }
    if (url.pathname === "/__login") {
      const org = url.searchParams.get("org") || ORG.personal;
      return send(200, { org }, { "set-cookie": `lastActiveOrg=${org}; Path=/; Max-Age=86400` });
    }
    if (url.pathname === "/__logout") {
      return send(200, {}, { "set-cookie": "lastActiveOrg=; Path=/; Max-Age=0" });
    }
    if (url.pathname === "/__log") return send(200, log);

    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/v1/")) {
      return send(200, `<!doctype html><title>mock ${name}</title><h1>mock ${name} — scenario: ${current}</h1>`, {
        "content-type": "text/html",
      });
    }

    log.push(url.pathname);
    const table = scenarios[current];
    let entry = Object.prototype.hasOwnProperty.call(table, url.pathname) ? table[url.pathname] : table["*"];
    if (entry === undefined) return send(404, { error: "not found" });
    if (typeof entry === "function") entry = entry();
    if (entry && typeof entry === "object" && "__status" in entry) return send(entry.__status, { error: "mock" });
    return send(200, entry);
  });

  return new Promise((resolve) => {
    server.listen(port, host, () =>
      resolve({
        server,
        origin: `http://${host}:${port}`,
        setScenario: (n) => { if (!scenarios[n]) throw new Error(`unknown scenario ${n}`); current = n; log = []; },
        getLog: () => [...log],
        close: () => new Promise((r) => server.close(r)),
      })
    );
  });
}

export const CLAUDE_MOCK = { host: "localhost", port: 8787 };
export const CONSOLE_MOCK = { host: "127.0.0.1", port: 8788 };

export async function startMocks({ claude = "max-fable", console: con = "ok" } = {}) {
  return {
    claude: await createMock({ name: "claude.ai", scenarios: CLAUDE_SCENARIOS, initial: claude, ...CLAUDE_MOCK }),
    console: await createMock({ name: "API Console", scenarios: CONSOLE_SCENARIOS, initial: con, ...CONSOLE_MOCK }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMocks();
  console.log(`mock claude.ai   ${m.claude.origin}   scenarios: ${Object.keys(CLAUDE_SCENARIOS).join(", ")}`);
  console.log(`mock API Console ${m.console.origin}  scenarios: ${Object.keys(CONSOLE_SCENARIOS).join(", ")}`);
  console.log(`sign in:  ${m.claude.origin}/__login?org=${ORG.personal}`);
  console.log(`          ${m.console.origin}/__login?org=${ORG.console}`);
}
