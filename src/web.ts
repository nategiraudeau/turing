import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { simulate } from "./core/simulate.js";
import { validateMachine } from "./core/validate.js";
import { makeTransitionKey } from "./core/parser.js";
import type { Machine, MissingTransitionMode, Move } from "./types.js";

interface Prefs {
  tickMs: number;
  maxSteps: number;
  missingTransition: MissingTransitionMode;
}

interface TransitionPayload {
  from: string;
  read: string;
  nextState: string;
  writeSymbol: string;
  move: Move;
}

interface MachinePayload {
  sig: string[];
  gam: string[];
  q: string[];
  q0: string;
  qAcc: string;
  qRej: string;
  transitions: TransitionPayload[];
}

function parsePrefs(): Prefs {
  const source = readFileSync(join(process.cwd(), "pref.txt"), "utf8");
  const prefs: Prefs = {
    tickMs: 250,
    maxSteps: 10000,
    missingTransition: "reject",
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(" ").trim();
    if (key === "tick-ms") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        prefs.tickMs = parsed;
      }
    } else if (key === "max-steps") {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        prefs.maxSteps = parsed;
      }
    } else if (key === "missing-transition" && (value === "reject" || value === "stay")) {
      prefs.missingTransition = value;
    }
  }
  return prefs;
}

function parseBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function toMachine(payload: MachinePayload): Machine {
  const del = new Map<string, { nextState: string; writeSymbol: string; move: Move }>();
  for (const transition of payload.transitions) {
    const key = makeTransitionKey(transition.from, transition.read);
    del.set(key, {
      nextState: transition.nextState,
      writeSymbol: transition.writeSymbol,
      move: transition.move,
    });
  }
  return {
    sig: new Set(payload.sig),
    gam: new Set(payload.gam),
    q: new Set(payload.q),
    q0: payload.q0,
    qAcc: payload.qAcc,
    qRej: payload.qRej,
    del,
  };
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(
  res: import("node:http").ServerResponse<import("node:http").IncomingMessage>,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

const rootDir = fileURLToPath(new URL("../web/dist", import.meta.url));

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method === "GET" && url.pathname === "/api/pref") {
    sendJson(res, 200, parsePrefs());
    return;
  }

  if (method === "POST" && url.pathname === "/api/simulate") {
    try {
      const body = (await parseBody(req)) as {
        machine?: MachinePayload;
        input?: string;
        maxSteps?: number;
        missingTransitionMode?: MissingTransitionMode;
      };
      if (!body.machine || typeof body.input !== "string") {
        sendJson(res, 400, { error: "invalid payload" });
        return;
      }

      const mode = body.missingTransitionMode;
      if (mode !== undefined && mode !== "reject" && mode !== "stay") {
        sendJson(res, 400, { error: "missingTransitionMode must be reject or stay" });
        return;
      }

      const machine = toMachine(body.machine);
      const errors = validateMachine(machine);
      if (errors.length > 0) {
        sendJson(res, 400, { errors });
        return;
      }

      const prefs = parsePrefs();
      const maxSteps =
        typeof body.maxSteps === "number" && Number.isInteger(body.maxSteps) && body.maxSteps > 0
          ? body.maxSteps
          : prefs.maxSteps;
      const missingTransitionMode = mode ?? prefs.missingTransition;

      const result = simulate(machine, body.input, maxSteps, missingTransitionMode);
      sendJson(res, 200, { result, maxSteps, missingTransitionMode });
    } catch {
      sendJson(res, 400, { error: "invalid json" });
    }
    return;
  }

  const pathFromReq = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = normalize(join(rootDir, pathFromReq));
  if (!resolved.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  try {
    const file = readFileSync(resolved);
    const contentType = MIME_TYPES[extname(resolved)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

const port = Number(process.env.PORT ?? "5174");
server.listen(port, () => {
  process.stdout.write(`web api/static server listening on http://localhost:${port}\n`);
});
