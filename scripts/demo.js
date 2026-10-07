// Demo: import diamond, show convergence + frontier, add a bypass edge as a
// new version, compare dominance, and confirm the old report is unchanged.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "dist", "src", "cli.js");
const run = (args) => {
  const out = execFileSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...args], { encoding: "utf8" });
  process.stdout.write(out);
  return out;
};

console.log("=== 1. import diamond graph (v1) ===");
run(["import", path.join(__dirname, "..", "examples", "diamond.json")]);

console.log("\n=== 2. dominance frontier of a and b ===");
run(["frontier", "1", "a"]);
run(["frontier", "1", "b"]);

console.log("\n=== 3. query: does a dominate j? ===");
run(["query", "1", "a", "j"]);

console.log("\n=== 4. add bypass edge s->j as a NEW version (v2) ===");
run(["import", path.join(__dirname, "..", "examples", "diamond-bypass.json")]);

console.log("\n=== 5. compare idom(j) between versions ===");
run(["tree", "1"]);
run(["tree", "2"]);

console.log("\n=== 6. old report (v1) is unchanged ===");
run(["query", "1", "a", "j"]);
run(["list"]);
