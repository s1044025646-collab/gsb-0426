import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AnalysisResult, GraphInput } from "./dominator";

export const ALGO_VERSION = "fixpoint-v1";

const DATA_DIR = process.env.DOM_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = process.env.DOM_DB_PATH || path.join(DATA_DIR, "dominator.db");

export interface GraphRecord {
  id: number;
  entry: string;
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  algoVersion: string;
  createdAt: string;
  result: AnalysisResult | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graphs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry TEXT NOT NULL,
        nodes TEXT NOT NULL,
        edges TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        graph_id INTEGER PRIMARY KEY REFERENCES graphs(id),
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Every import creates a new immutable graph version. */
  createGraph(input: GraphInput): number {
    const stmt = this.db.prepare(
      "INSERT INTO graphs (entry, nodes, edges, algo_version, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    const r = stmt.run(
      input.entry,
      JSON.stringify(input.nodes),
      JSON.stringify(input.edges),
      ALGO_VERSION,
      new Date().toISOString()
    );
    return Number(r.lastInsertRowid);
  }

  saveResult(graphId: number, result: AnalysisResult): void {
    this.db
      .prepare("INSERT OR REPLACE INTO results (graph_id, result, created_at) VALUES (?, ?, ?)")
      .run(graphId, JSON.stringify(result), new Date().toISOString());
  }

  getGraph(id: number): GraphRecord | null {
    const row = this.db.prepare("SELECT * FROM graphs WHERE id = ?").get(id) as any;
    if (!row) return null;
    const resRow = this.db.prepare("SELECT result FROM results WHERE graph_id = ?").get(id) as any;
    return {
      id: row.id,
      entry: row.entry,
      nodes: JSON.parse(row.nodes),
      edges: JSON.parse(row.edges),
      algoVersion: row.algo_version,
      createdAt: row.created_at,
      result: resRow ? JSON.parse(resRow.result) : null,
    };
  }

  listGraphs(): Array<{
    id: number;
    entry: string;
    algoVersion: string;
    createdAt: string;
    nodeCount: number;
    edgeCount: number;
    hasResult: boolean;
  }> {
    const rows = this.db
      .prepare(
        `SELECT g.id, g.entry, g.algo_version, g.created_at,
                json_array_length(g.nodes) AS node_count,
                json_array_length(g.edges) AS edge_count,
                (r.graph_id IS NOT NULL) AS has_result
         FROM graphs g LEFT JOIN results r ON r.graph_id = g.id
         ORDER BY g.id`
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      entry: r.entry,
      algoVersion: r.algo_version,
      createdAt: r.created_at,
      nodeCount: r.node_count,
      edgeCount: r.edge_count,
      hasResult: !!r.has_result,
    }));
  }
}

export function graphInputOf(rec: GraphRecord): GraphInput {
  return { nodes: rec.nodes, entry: rec.entry, edges: rec.edges };
}
