import * as http from "node:http";
import { AddressInfo } from "node:net";
import { computeDominators, GraphError, GraphInput, MAX_EDGES, MAX_NODES, queryDominance } from "./dominator";
import { graphInputOf, Store } from "./store";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 10 * 1024 * 1024) reject(new GraphError("LIMIT_EXCEEDED", "request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // GET /limits
      if (req.method === "GET" && url.pathname === "/limits") {
        return sendJson(res, 200, { maxNodes: MAX_NODES, maxEdges: MAX_EDGES });
      }
      // GET /graphs
      if (req.method === "GET" && parts.length === 1 && parts[0] === "graphs") {
        return sendJson(res, 200, { graphs: store.listGraphs() });
      }
      // POST /graphs  (import a new immutable version)
      if (req.method === "POST" && parts.length === 1 && parts[0] === "graphs") {
        const body = JSON.parse(await readBody(req)) as GraphInput;
        const result = computeDominators(body); // validates + analyzes before any write
        const id = store.createGraph(body);
        store.saveResult(id, result);
        return sendJson(res, 201, { graphId: id, result });
      }
      if (parts.length >= 2 && parts[0] === "graphs") {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) return sendError(res, 400, "VALIDATION_ERROR", "graph id must be an integer");
        const rec = store.getGraph(id);
        if (!rec) return sendJson(res, 404, { error: { code: "NOT_FOUND", message: `graph ${id} not found` } });
        const input = graphInputOf(rec);

        // GET /graphs/:id
        if (req.method === "GET" && parts.length === 2) {
          return sendJson(res, 200, rec);
        }
        // POST /graphs/:id/analyze
        if (req.method === "POST" && parts.length === 3 && parts[2] === "analyze") {
          const result = computeDominators(input);
          store.saveResult(id, result);
          return sendJson(res, 200, { graphId: id, result });
        }
        // GET /graphs/:id/result
        if (req.method === "GET" && parts.length === 3 && parts[2] === "result") {
          if (!rec.result) return sendError(res, 404, "NOT_FOUND", `graph ${id} has no analysis result yet`);
          return sendJson(res, 200, { graphId: id, algoVersion: rec.algoVersion, result: rec.result });
        }
        // GET /graphs/:id/dominates?a=&b=
        if (req.method === "GET" && parts.length === 3 && parts[2] === "dominates") {
          const a = url.searchParams.get("a");
          const b = url.searchParams.get("b");
          if (!a || !b) return sendError(res, 400, "VALIDATION_ERROR", "query params a and b are required");
          return sendJson(res, 200, { graphId: id, a, b, ...queryDominance(input, a, b) });
        }
        // GET /graphs/:id/idom-tree
        if (req.method === "GET" && parts.length === 3 && parts[2] === "idom-tree") {
          const result = rec.result ?? computeDominators(input);
          return sendJson(res, 200, { graphId: id, idom: result.idom, domTree: result.domTree });
        }
        // GET /graphs/:id/frontier?node=
        if (req.method === "GET" && parts.length === 3 && parts[2] === "frontier") {
          const node = url.searchParams.get("node");
          const result = rec.result ?? computeDominators(input);
          if (node) {
            if (!(node in result.dominanceFrontier))
              return sendError(res, 404, "NOT_FOUND", `node ${node} is not a reachable block`);
            return sendJson(res, 200, { graphId: id, node, frontier: result.dominanceFrontier[node] });
          }
          return sendJson(res, 200, { graphId: id, dominanceFrontier: result.dominanceFrontier });
        }
      }
      sendError(res, 404, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof GraphError) {
        const status = err.code === "LIMIT_EXCEEDED" ? 413 : 400;
        return sendError(res, status, err.code, err.message);
      }
      if (err instanceof SyntaxError) {
        return sendError(res, 400, "VALIDATION_ERROR", "request body is not valid JSON");
      }
      sendError(res, 500, "INTERNAL_ERROR", String(err));
    }
  });
}

export function startServer(port?: number): Promise<{ server: http.Server; port: number }> {
  const store = new Store();
  const server = createServer(store);
  const requested = port ?? (process.env.PORT ? Number(process.env.PORT) : 0); // 0 = pick a free port
  return new Promise((resolve) => {
    server.listen(requested, () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ server, port: actual });
    });
  });
}

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`dominator service listening on http://127.0.0.1:${port}`);
  });
}
