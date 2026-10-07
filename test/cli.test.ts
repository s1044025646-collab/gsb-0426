import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const CLI = path.join(__dirname, "..", "src", "cli.js");

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

function tmpEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dom-cli-"));
  return { env: { ...process.env, DOM_DB_PATH: path.join(dir, "cli.db") }, dir };
}

function run(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("node", [CLI, ...args], { env, encoding: "utf8" });
}

test("cli: import, query, tree, frontier, export, list", () => {
  const { env, dir } = tmpEnv();
  const graphFile = path.join(dir, "diamond.json");
  fs.writeFileSync(graphFile, JSON.stringify(diamond));

  const imp = run(["import", graphFile], env);
  assert.match(imp, /imported graph id=1/);
  assert.match(imp, /Dom\(j\) = \{j, s\}/);
  assert.match(imp, /round 1 changed=/);

  const q = run(["query", "1", "a", "j"], env);
  assert.match(q, /no: a does not dominate j/);
  assert.match(q, /counterexample path avoiding a: s -> b -> j/);

  const q2 = run(["query", "1", "s", "z"], env);
  assert.match(q2, /yes: s dominates z/);

  const tree = run(["tree", "1"], env);
  assert.match(tree, /idom tree/);
  assert.match(tree, /\n  j\n/);

  const fr = run(["frontier", "1", "a"], env);
  assert.match(fr, /DF\(a\) = \{j\}/);

  const outFile = path.join(dir, "out.json");
  run(["export", "1", outFile], env);
  const exported = JSON.parse(fs.readFileSync(outFile, "utf8"));
  assert.equal(exported.result.idom["j"], "s");

  const list = run(["list"], env);
  assert.match(list, /#1 entry=s nodes=5 edges=5 analyzed=true/);

  const limits = run(["limits"], env);
  assert.match(limits, /maxNodes=\d+ maxEdges=\d+/);
});

test("cli: invalid import exits non-zero and leaves no residue", async () => {
  const { env, dir } = tmpEnv();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ nodes: ["s", "s"], entry: "s", edges: [] }));
  await assert.rejects(execFileP("node", [CLI, "import", bad], { env }), (err: any) => {
    assert.match(String(err.stderr), /\[DUPLICATE_NODE\]/);
    return true;
  });
  const list = run(["list"], env);
  assert.equal(list.trim(), "");
});
