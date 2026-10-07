import * as fs from "node:fs";
import { computeDominators, GraphInput, MAX_EDGES, MAX_NODES, queryDominance } from "./dominator";
import { graphInputOf, Store } from "./store";

function fail(code: string, message: string): never {
  console.error(`error [${code}] ${message}`);
  process.exit(1);
}

function readGraphArg(arg: string): GraphInput {
  const text = arg === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(arg, "utf8");
  return JSON.parse(text);
}

function printResultSummary(result: ReturnType<typeof computeDominators>): void {
  console.log(`entry: ${result.entry}`);
  console.log(`reachable: [${result.reachable.join(", ")}]`);
  if (result.unreachable.length) console.log(`unreachable: [${result.unreachable.join(", ")}]`);
  console.log(`rounds: ${result.rounds.map((r) => `round ${r.round} changed=${r.changed}`).join(" | ")}`);
  console.log("dominator sets:");
  for (const n of result.reachable) console.log(`  Dom(${n}) = {${result.dom[n].join(", ")}}`);
  console.log("immediate dominators:");
  for (const n of result.reachable) console.log(`  idom(${n}) = ${result.idom[n] ?? "(none, entry)"}`);
  console.log("dominance frontier:");
  for (const n of result.reachable) console.log(`  DF(${n}) = {${result.dominanceFrontier[n].join(", ")}}`);
}

const usage = `dominator-cli <command> [args]

commands:
  import <file.json|->          import a graph (new immutable version), analyze and print summary
  analyze <graphId>             re-run analysis for a stored graph
  query <graphId> <a> <b>       does a dominate b? prints counterexample path if not
  tree <graphId>                print immediate-dominator tree
  frontier <graphId> [node]     print dominance frontier (all nodes or one)
  export <graphId> [file]       export stored result as JSON (stdout or file)
  list                          list graph history
  limits                        print node/edge limits
  serve [port]                  start HTTP API (default: pick a free port)

graph json format: { "nodes": ["s","a"], "entry": "s", "edges": [{"from":"s","to":"a"}] }
`;

function main(argv: string[]): void {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(usage);
    return;
  }
  const store = new Store();
  try {
    switch (cmd) {
      case "limits": {
        console.log(`maxNodes=${MAX_NODES} maxEdges=${MAX_EDGES}`);
        return;
      }
      case "import": {
        if (!args[0]) fail("VALIDATION_ERROR", "import needs a json file path (or - for stdin)");
        const input = readGraphArg(args[0]);
        const result = computeDominators(input);
        const id = store.createGraph(input);
        store.saveResult(id, result);
        console.log(`imported graph id=${id}`);
        printResultSummary(result);
        return;
      }
      case "list": {
        for (const g of store.listGraphs()) {
          console.log(
            `#${g.id} entry=${g.entry} nodes=${g.nodeCount} edges=${g.edgeCount} analyzed=${g.hasResult} created=${g.createdAt}`
          );
        }
        return;
      }
      case "serve": {
        const port = args[0] ? Number(args[0]) : undefined;
        const { createServer } = require("./server");
        const server = createServer(store);
        server.listen(port ?? 0, () => {
          console.log(`dominator service listening on http://127.0.0.1:${server.address().port}`);
        });
        return;
      }
      default: {
        const id = Number(args[0]);
        if (!Number.isInteger(id)) fail("VALIDATION_ERROR", `${cmd} needs a numeric graph id`);
        const rec = store.getGraph(id);
        if (!rec) fail("NOT_FOUND", `graph ${id} not found`);
        const input = graphInputOf(rec);
        const result = rec.result ?? computeDominators(input);
        switch (cmd) {
          case "analyze": {
            const fresh = computeDominators(input);
            store.saveResult(id, fresh);
            printResultSummary(fresh);
            return;
          }
          case "query": {
            const [, a, b] = args;
            if (!a || !b) fail("VALIDATION_ERROR", "query needs <graphId> <a> <b>");
            const r = queryDominance(input, a, b);
            if (r.dominates === null) {
              console.log(`N/A: ${r.reason}`);
            } else if (r.dominates) {
              console.log(`yes: ${a} dominates ${b}`);
            } else {
              console.log(`no: ${a} does not dominate ${b}`);
              if (r.counterexample) console.log(`counterexample path avoiding ${a}: ${r.counterexample.join(" -> ")}`);
              if (r.reason) console.log(`note: ${r.reason}`);
            }
            return;
          }
          case "tree": {
            console.log(`idom tree (entry=${result.entry}):`);
            const walk = (n: string, depth: number): void => {
              console.log(`${"  ".repeat(depth)}${n}`);
              for (const c of result.domTree[n] || []) walk(c, depth + 1);
            };
            walk(result.entry, 0);
            if (result.unreachable.length) console.log(`unreachable (not in tree): ${result.unreachable.join(", ")}`);
            return;
          }
          case "frontier": {
            if (args[1]) {
              const f = result.dominanceFrontier[args[1]];
              if (!f) fail("NOT_FOUND", `node ${args[1]} is not a reachable block`);
              console.log(`DF(${args[1]}) = {${f.join(", ")}}`);
            } else {
              for (const n of result.reachable) console.log(`DF(${n}) = {${result.dominanceFrontier[n].join(", ")}}`);
            }
            return;
          }
          case "export": {
            const json = JSON.stringify({ graphId: id, algoVersion: rec.algoVersion, result }, null, 2);
            if (args[1]) {
              fs.writeFileSync(args[1], json);
              console.log(`exported to ${args[1]}`);
            } else {
              console.log(json);
            }
            return;
          }
          default:
            console.log(usage);
            fail("VALIDATION_ERROR", `unknown command: ${cmd}`);
        }
      }
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

try {
  main(process.argv.slice(2));
} catch (err: any) {
  if (err && err.code) fail(err.code, err.message);
  fail("INTERNAL_ERROR", String(err && err.message ? err.message : err));
}
