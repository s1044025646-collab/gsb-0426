export interface GraphInput {
  nodes: string[];
  entry: string;
  edges: Array<{ from: string; to: string }>;
}

export interface RoundSummary {
  round: number;
  changed: number;
}

export interface AnalysisResult {
  entry: string;
  reachable: string[];
  unreachable: string[];
  dom: Record<string, string[]>;
  idom: Record<string, string | null>;
  domTree: Record<string, string[]>;
  dominanceFrontier: Record<string, string[]>;
  rounds: RoundSummary[];
  totalRounds: number;
}

export const MAX_NODES = Number(process.env.DOM_MAX_NODES || 10000);
export const MAX_EDGES = Number(process.env.DOM_MAX_EDGES || 50000);

export class GraphError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function validateGraph(input: GraphInput): void {
  if (!input || typeof input !== "object") throw new GraphError("VALIDATION_ERROR", "request body must be an object");
  const { nodes, entry, edges } = input;
  if (!Array.isArray(nodes)) throw new GraphError("VALIDATION_ERROR", "nodes must be an array");
  if (typeof entry !== "string" || entry.length === 0)
    throw new GraphError("INVALID_ENTRY", "entry must be a non-empty string");
  if (!Array.isArray(edges)) throw new GraphError("VALIDATION_ERROR", "edges must be an array");
  if (nodes.length === 0) throw new GraphError("EMPTY_GRAPH", "graph is empty: nodes must not be empty");
  if (nodes.length > MAX_NODES)
    throw new GraphError("LIMIT_EXCEEDED", `node count ${nodes.length} exceeds limit ${MAX_NODES}`);
  if (edges.length > MAX_EDGES)
    throw new GraphError("LIMIT_EXCEEDED", `edge count ${edges.length} exceeds limit ${MAX_EDGES}`);
  const seen = new Set<string>();
  for (const n of nodes) {
    if (typeof n !== "string" || n.length === 0)
      throw new GraphError("VALIDATION_ERROR", "node ids must be non-empty strings");
    if (seen.has(n)) throw new GraphError("DUPLICATE_NODE", `duplicate node id: ${n}`);
    seen.add(n);
  }
  if (!seen.has(entry)) throw new GraphError("INVALID_ENTRY", `entry ${entry} is not in the node list`);
  for (const e of edges) {
    if (!e || typeof e.from !== "string" || typeof e.to !== "string")
      throw new GraphError("VALIDATION_ERROR", "each edge needs string from and to");
    if (!seen.has(e.from)) throw new GraphError("MISSING_ENDPOINT", `edge source does not exist: ${e.from}`);
    if (!seen.has(e.to)) throw new GraphError("MISSING_ENDPOINT", `edge target does not exist: ${e.to}`);
  }
}

/** Merge parallel edges, keeping first-seen source order. */
export function dedupeEdges(edges: Array<{ from: string; to: string }>): Array<{ from: string; to: string }> {
  const seen = new Set<string>();
  const out: Array<{ from: string; to: string }> = [];
  for (const e of edges) {
    const k = e.from + "->" + e.to;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  return out;
}

export function buildAdj(nodes: string[], edges: Array<{ from: string; to: string }>) {
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const n of nodes) {
    succ.set(n, []);
    pred.set(n, []);
  }
  for (const e of dedupeEdges(edges)) {
    succ.get(e.from)!.push(e.to);
    pred.get(e.to)!.push(e.from);
  }
  return { succ, pred };
}

export function reachableFrom(entry: string, succ: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([entry]);
  const stack = [entry];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const nx of succ.get(cur) || []) {
      if (!seen.has(nx)) {
        seen.add(nx);
        stack.push(nx);
      }
    }
  }
  return seen;
}

/**
 * Dominator-set fixpoint iteration.
 * Dom(entry) = {entry}; every other reachable block starts from all reachable
 * blocks, and each round intersects the dominator sets of reachable
 * predecessors then adds the block itself, iterating until stable.
 * Traversal order is fixed (lexicographic node ids); per-round change counts
 * are kept as a convergence summary.
 */
export function computeDominators(input: GraphInput): AnalysisResult {
  validateGraph(input);
  const nodes = [...input.nodes].sort();
  const { succ, pred } = buildAdj(input.nodes, input.edges);
  const reachableSet = reachableFrom(input.entry, succ);
  const reachable = nodes.filter((n) => reachableSet.has(n));
  const unreachable = nodes.filter((n) => !reachableSet.has(n));

  const dom = new Map<string, Set<string>>();
  for (const n of reachable) {
    dom.set(n, n === input.entry ? new Set([input.entry]) : new Set(reachable));
  }

  const rounds: RoundSummary[] = [];
  let changed = true;
  let round = 0;
  while (changed) {
    round++;
    changed = false;
    let changedCount = 0;
    for (const n of reachable) {
      if (n === input.entry) continue; // entry keeps {entry} even with back edges
      const reachablePreds = (pred.get(n) || []).filter((p) => reachableSet.has(p));
      let next: Set<string>;
      if (reachablePreds.length === 0) {
        next = new Set([n]);
      } else {
        next = new Set(dom.get(reachablePreds[0])!);
        for (let i = 1; i < reachablePreds.length; i++) {
          const pdom = dom.get(reachablePreds[i])!;
          for (const x of [...next]) if (!pdom.has(x)) next.delete(x);
        }
        next.add(n);
      }
      const cur = dom.get(n)!;
      if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) {
        dom.set(n, next);
        changed = true;
        changedCount++;
      }
    }
    rounds.push({ round, changed: changedCount });
  }

  const domObj: Record<string, string[]> = {};
  for (const n of reachable) domObj[n] = [...dom.get(n)!].sort();

  // Immediate dominator: the strict dominator dominated by all other strict
  // dominators (the one closest to the node itself).
  const idom: Record<string, string | null> = {};
  const domTree: Record<string, string[]> = {};
  for (const n of reachable) domTree[n] = [];
  idom[input.entry] = null;
  for (const n of reachable) {
    if (n === input.entry) continue;
    const strict = [...dom.get(n)!].filter((d) => d !== n);
    let immediate: string | null = null;
    for (const cand of strict) {
      const dominatedByAll = strict.every((other) => other === cand || dom.get(cand)!.has(other));
      if (dominatedByAll) {
        immediate = cand;
        break;
      }
    }
    idom[n] = immediate;
    if (immediate !== null) domTree[immediate].push(n);
  }
  for (const k of Object.keys(domTree)) domTree[k].sort();

  // Dominance frontier: y in DF(x) iff x dominates at least one reachable
  // predecessor of y, and x does not strictly dominate y. Strict domination
  // excludes the node itself, so loops can put a node in its own frontier.
  const dominanceFrontier: Record<string, string[]> = {};
  for (const n of reachable) dominanceFrontier[n] = [];
  for (const y of reachable) {
    const reachablePreds = (pred.get(y) || []).filter((p) => reachableSet.has(p));
    if (reachablePreds.length === 0) continue;
    for (const x of reachable) {
      const dominatesSomePred = reachablePreds.some((p) => dom.get(p)!.has(x));
      const strictlyDominatesY = x !== y && dom.get(y)!.has(x);
      if (dominatesSomePred && !strictlyDominatesY) dominanceFrontier[x].push(y);
    }
  }
  for (const k of Object.keys(dominanceFrontier)) dominanceFrontier[k].sort();

  return {
    entry: input.entry,
    reachable,
    unreachable,
    dom: domObj,
    idom,
    domTree,
    dominanceFrontier,
    rounds,
    totalRounds: rounds.length,
  };
}

/** Query whether a dominates b; if not, return a real path to b avoiding a. */
export function queryDominance(
  input: GraphInput,
  a: string,
  b: string
): { dominates: boolean | null; counterexample: string[] | null; reason?: string } {
  const result = computeDominators(input);
  if (!result.reachable.includes(b)) {
    return { dominates: null, counterexample: null, reason: `target ${b} is unreachable from entry; not applicable` };
  }
  if (!result.reachable.includes(a)) {
    return { dominates: false, counterexample: null, reason: `candidate ${a} is unreachable, dominates nothing reachable` };
  }
  const domSet = new Set(result.dom[b]);
  if (domSet.has(a)) return { dominates: true, counterexample: null };
  const path = findPathAvoiding(input, input.entry, b, a);
  return { dominates: false, counterexample: path };
}

/** BFS for a real path from `from` to `target` that avoids `avoid`. */
export function findPathAvoiding(input: GraphInput, from: string, target: string, avoid: string): string[] | null {
  const { succ } = buildAdj(input.nodes, input.edges);
  if (from === avoid || target === avoid) return null;
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === target) {
      const path: string[] = [];
      let n: string | null = cur;
      while (n !== null) {
        path.unshift(n);
        n = prev.get(n) ?? null;
      }
      return path;
    }
    for (const nx of succ.get(cur) || []) {
      if (nx === avoid || prev.has(nx)) continue;
      prev.set(nx, cur);
      queue.push(nx);
    }
  }
  return null;
}
