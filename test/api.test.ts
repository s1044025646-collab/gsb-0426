import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AddressInfo } from "node:net";
import { createServer } from "../src/server";
import { Store } from "../src/store";

let base: string;
let server: ReturnType<typeof createServer>;
let dbPath: string;

const diamond = {
  nodes: ["s", "a", "b", "j", "z"],
  entry: "s",
  edges: [
    { from: "s", to: "a" },
    { from: "s", to: "b" },
    { from: "a", to: "j" },
    { from: "b", to: "j" },
    { from: "j", to: "z" },
  ],
};

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dom-test-")), "test.db");
  server = createServer(new Store(dbPath));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test("import diamond, analyze, query, tree, frontier, export, history", async () => {
  const imp = await api("POST", "/graphs", diamond);
  assert.equal(imp.status, 201);
  const id = imp.json.graphId;
  assert.equal(imp.json.result.idom["j"], "s");
  assert.ok(imp.json.result.rounds.length >= 2);

  const dom = await api("GET", `/graphs/${id}/dominates?a=a&b=j`);
  assert.equal(dom.status, 200);
  assert.equal(dom.json.dominates, false);
  assert.deepEqual(dom.json.counterexample, ["s", "b", "j"]);

  const tree = await api("GET", `/graphs/${id}/idom-tree`);
  assert.equal(tree.json.idom["z"], "j");

  const fr = await api("GET", `/graphs/${id}/frontier?node=a`);
  assert.deepEqual(fr.json.frontier, ["j"]);

  const exp = await api("GET", `/graphs/${id}/result`);
  assert.equal(exp.status, 200);
  assert.equal(exp.json.result.entry, "s");

  const hist = await api("GET", "/graphs");
  assert.ok(hist.json.graphs.some((g: any) => g.id === id));
});

test("modifying the graph creates a new immutable version; old result unchanged", async () => {
  const v1 = await api("POST", "/graphs", diamond);
  const id1 = v1.json.graphId;
  const bypass = { ...diamond, edges: [...diamond.edges, { from: "s", to: "j" }] };
  const v2 = await api("POST", "/graphs", bypass);
  const id2 = v2.json.graphId;
  assert.notEqual(id1, id2);

  // in v2, s->j bypass means a no longer has j in frontier... check j's dom set
  assert.deepEqual(v2.json.result.dom["j"], ["j", "s"]);
  const q1 = await api("GET", `/graphs/${id1}/dominates?a=a&b=j`);
  const q2 = await api("GET", `/graphs/${id2}/dominates?a=a&b=j`);
  assert.equal(q1.json.dominates, false);
  assert.equal(q2.json.dominates, false);
  // old report unchanged
  const old = await api("GET", `/graphs/${id1}/result`);
  assert.deepEqual(old.json.result, v1.json.result);
});

test("error codes for invalid imports and missing resources", async () => {
  const cases: Array<[unknown, string]> = [
    [{ nodes: [], entry: "s", edges: [] }, "EMPTY_GRAPH"],
    [{ nodes: ["s", "s"], entry: "s", edges: [] }, "DUPLICATE_NODE"],
    [{ nodes: ["s"], entry: "x", edges: [] }, "INVALID_ENTRY"],
    [{ nodes: ["s"], entry: "s", edges: [{ from: "s", to: "ghost" }] }, "MISSING_ENDPOINT"],
  ];
  for (const [body, code] of cases) {
    const r = await api("POST", "/graphs", body);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, code);
  }
  const missing = await api("GET", "/graphs/99999");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "NOT_FOUND");
  const badQuery = await api("GET", "/graphs/1/dominates");
  assert.equal(badQuery.status, 400);
});

test("failed import leaves no residue in the database", async () => {
  const before = (await api("GET", "/graphs")).json.graphs.length;
  await api("POST", "/graphs", { nodes: ["s", "s"], entry: "s", edges: [] });
  await api("POST", "/graphs", { nodes: [], entry: "s", edges: [] });
  const afterN = (await api("GET", "/graphs")).json.graphs.length;
  assert.equal(before, afterN);
});

test("limits endpoint exposes caps", async () => {
  const r = await api("GET", "/limits");
  assert.equal(r.status, 200);
  assert.ok(r.json.maxNodes > 0);
  assert.ok(r.json.maxEdges > 0);
});

test("results survive a restart (new Store on same db file)", async () => {
  const imp = await api("POST", "/graphs", diamond);
  const id = imp.json.graphId;
  const reopened = new Store(dbPath);
  const rec = reopened.getGraph(id);
  reopened.close();
  assert.ok(rec);
  assert.deepEqual(rec!.result, imp.json.result);
  assert.equal(rec!.entry, "s");
});
