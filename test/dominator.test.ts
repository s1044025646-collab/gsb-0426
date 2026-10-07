import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAdj,
  computeDominators,
  dedupeEdges,
  GraphError,
  GraphInput,
  queryDominance,
  reachableFrom,
} from "../src/dominator";

// ---------- independent oracles (do NOT call production dominator code) ----------

/** a dominates b iff removing a makes b unreachable from entry. */
function oracleDominates(input: GraphInput, a: string, b: string): boolean {
  const nodes = input.nodes.filter((n) => n !== a);
  const edges = input.edges.filter((e) => e.from !== a && e.to !== a);
  const { succ } = buildAdj(nodes, edges);
  if (!input.nodes.includes(a)) return false;
  if (a === b) return reachableFrom(input.entry, buildAdj(input.nodes, input.edges).succ).has(b);
  return !reachableFrom(input.entry, succ).has(b);
}

/** Enumerate DF by the textbook definition using the removal oracle. */
function oracleFrontier(input: GraphInput, x: string): string[] {
  const { succ, pred } = buildAdj(input.nodes, input.edges);
  const reachable = reachableFrom(input.entry, succ);
  const out: string[] = [];
  for (const y of input.nodes) {
    if (!reachable.has(y)) continue;
    const preds = (pred.get(y) || []).filter((p) => reachable.has(p));
    const domSomePred = preds.some((p) => oracleDominates(input, x, p));
    const strictlyDomY = x !== y && oracleDominates(input, x, y);
    if (domSomePred && !strictlyDomY) out.push(y);
  }
  return out.sort();
}

function crossCheck(input: GraphInput): void {
  const result = computeDominators(input);
  for (const b of result.reachable) {
    for (const a of input.nodes) {
      const expected = result.reachable.includes(a) ? oracleDominates(input, a, b) : false;
      assert.equal(
        result.dom[b].includes(a),
        expected,
        `dominance mismatch: does ${a} dominate ${b}?`
      );
    }
  }
  for (const x of result.reachable) {
    assert.deepEqual(result.dominanceFrontier[x], oracleFrontier(input, x), `DF(${x}) mismatch`);
  }
}

// ---------- fixtures ----------

const diamond: GraphInput = {
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

const loop: GraphInput = {
  nodes: ["s", "h", "body", "exit"],
  entry: "s",
  edges: [
    { from: "s", to: "h" },
    { from: "h", to: "body" },
    { from: "body", to: "h" }, // back edge
    { from: "h", to: "exit" },
  ],
};

const entryBackEdge: GraphInput = {
  nodes: ["s", "a"],
  entry: "s",
  edges: [
    { from: "s", to: "a" },
    { from: "a", to: "s" }, // back edge into entry
  ],
};

const singleBlock: GraphInput = { nodes: ["only"], entry: "only", edges: [] };

const withIsolated: GraphInput = {
  nodes: ["s", "a", "orphan1", "orphan2"],
  entry: "s",
  edges: [
    { from: "s", to: "a" },
    { from: "orphan1", to: "orphan2" },
  ],
};

// ---------- tests ----------

test("diamond: idom and frontier match spec", () => {
  const r = computeDominators(diamond);
  assert.equal(r.idom["j"], "s");
  assert.equal(r.idom["z"], "j");
  assert.ok(r.dominanceFrontier["a"].includes("j"));
  assert.ok(r.dominanceFrontier["b"].includes("j"));
  assert.deepEqual(r.dom["j"], ["j", "s"]);
  assert.ok(r.totalRounds >= 2);
  assert.equal(r.rounds[r.rounds.length - 1].changed, 0);
  crossCheck(diamond);
});

test("loop with back edge: node can be in its own frontier", () => {
  const r = computeDominators(loop);
  assert.equal(r.idom["h"], "s");
  assert.equal(r.idom["body"], "h");
  assert.ok(r.dominanceFrontier["body"].includes("h"));
  assert.ok(r.dominanceFrontier["h"].includes("h")); // self in own frontier via loop
  crossCheck(loop);
});

test("entry with back edge keeps Dom(entry) = {entry}", () => {
  const r = computeDominators(entryBackEdge);
  assert.deepEqual(r.dom["s"], ["s"]);
  assert.equal(r.idom["s"], null);
  assert.deepEqual(r.dom["a"], ["a", "s"]);
  crossCheck(entryBackEdge);
});

test("single block graph", () => {
  const r = computeDominators(singleBlock);
  assert.deepEqual(r.dom["only"], ["only"]);
  assert.equal(r.idom["only"], null);
  assert.deepEqual(r.dominanceFrontier["only"], []);
  crossCheck(singleBlock);
});

test("unreachable blocks are listed separately, excluded from dom sets", () => {
  const r = computeDominators(withIsolated);
  assert.deepEqual(r.unreachable, ["orphan1", "orphan2"]);
  assert.deepEqual(r.reachable, ["a", "s"]);
  for (const n of r.reachable) {
    assert.ok(!r.dom[n].includes("orphan1"));
    assert.ok(!r.dom[n].includes("orphan2"));
  }
  assert.equal(r.idom["orphan1"], undefined);
  crossCheck(withIsolated);
});

test("node id reordering does not change conclusions", () => {
  const shuffled: GraphInput = {
    nodes: ["z", "j", "b", "a", "s"],
    entry: "s",
    edges: [...diamond.edges].reverse(),
  };
  const a = computeDominators(diamond);
  const b = computeDominators(shuffled);
  assert.deepEqual(b.dom, a.dom);
  assert.deepEqual(b.idom, a.idom);
  assert.deepEqual(b.dominanceFrontier, a.dominanceFrontier);
});

test("duplicate edges are merged but kept as source input", () => {
  const dup: GraphInput = { ...diamond, edges: [...diamond.edges, { from: "s", to: "a" }, { from: "s", to: "a" }] };
  assert.equal(dedupeEdges(dup.edges).length, diamond.edges.length);
  assert.deepEqual(computeDominators(dup).dom, computeDominators(diamond).dom);
});

test("deep chain converges and cross-checks", () => {
  const n = 200;
  const nodes = Array.from({ length: n }, (_, i) => `b${i}`);
  const edges = nodes.slice(1).map((_, i) => ({ from: `b${i}`, to: `b${i + 1}` }));
  const g: GraphInput = { nodes, entry: "b0", edges };
  const r = computeDominators(g);
  assert.equal(r.idom["b199"], "b198");
  assert.equal(r.dom["b199"].length, 200);
  crossCheck(g);
});

test("disconnected branch and self loop", () => {
  const g: GraphInput = {
    nodes: ["s", "a", "selfy", "dead"],
    entry: "s",
    edges: [
      { from: "s", to: "a" },
      { from: "selfy", to: "selfy" },
      { from: "dead", to: "a" }, // pred of a that is unreachable: must be ignored
    ],
  };
  const r = computeDominators(g);
  assert.deepEqual(r.dom["a"], ["a", "s"]);
  assert.deepEqual(r.unreachable, ["dead", "selfy"]);
  crossCheck(g);
});

test("query: counterexample path is real and avoids candidate", () => {
  const q = queryDominance(diamond, "a", "j");
  assert.equal(q.dominates, false);
  assert.deepEqual(q.counterexample, ["s", "b", "j"]);
  assert.ok(!q.counterexample!.includes("a"));
  // verify edges of the path actually exist
  const edgeSet = new Set(diamond.edges.map((e) => `${e.from}->${e.to}`));
  for (let i = 0; i + 1 < q.counterexample!.length; i++) {
    assert.ok(edgeSet.has(`${q.counterexample![i]}->${q.counterexample![i + 1]}`));
  }
  const q2 = queryDominance(diamond, "s", "z");
  assert.equal(q2.dominates, true);
  const q3 = queryDominance(withIsolated, "s", "orphan2");
  assert.equal(q3.dominates, null); // unreachable target: N/A
  const q4 = queryDominance(loop, "body", "h");
  assert.equal(q4.dominates, false);
  assert.ok(q4.counterexample && !q4.counterexample.includes("body"));
});

test("validation rejects bad input before analysis", () => {
  const bad: Array<[GraphInput, string]> = [
    [{ nodes: [], entry: "s", edges: [] }, "EMPTY_GRAPH"],
    [{ nodes: ["s", "s"], entry: "s", edges: [] }, "DUPLICATE_NODE"],
    [{ nodes: ["s"], entry: "nope", edges: [] }, "INVALID_ENTRY"],
    [{ nodes: ["s"], entry: "s", edges: [{ from: "s", to: "ghost" }] }, "MISSING_ENDPOINT"],
    [{ nodes: ["s"], entry: "s", edges: [{ from: "ghost", to: "s" }] }, "MISSING_ENDPOINT"],
  ];
  for (const [g, code] of bad) {
    assert.throws(() => computeDominators(g), (e: GraphError) => e.code === code);
  }
});

test("size limits", () => {
  const tooManyNodes: GraphInput = {
    nodes: Array.from({ length: 10001 }, (_, i) => `n${i}`),
    entry: "n0",
    edges: [],
  };
  assert.throws(() => computeDominators(tooManyNodes), (e: GraphError) => e.code === "LIMIT_EXCEEDED");
});
