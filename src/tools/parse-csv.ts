import { resolve } from "node:path";
import type { ToolDefinition } from "../types.ts";

export const definition: ToolDefinition = {
  name: "parse-csv",
  description:
    "Parse CSV data into structured JSON and query it. Supports filtering rows, selecting columns, computed columns (e.g., 'quantity * price'), group-by aggregations, stats (sum, avg, min, max, count), sorting, and limiting. Provide CSV via file path or inline text.",
  input_schema: {
    type: "object",
    properties: {
      csv_file: {
        type: "string",
        description: "Path to a CSV file to parse. Either csv_file or csv_text must be provided.",
      },
      csv_text: {
        type: "string",
        description: "Raw CSV text to parse. Either csv_file or csv_text must be provided.",
      },
      filter: {
        type: "object",
        description: "Filter conditions as key-value pairs. Keys are column names, values are the values to match.",
      },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "List of column names to select/return. If omitted, all columns are returned.",
      },
      stats: {
        type: "object",
        description:
          "Compute statistics on columns. Keys are column names, values are arrays of stat operations: sum, avg, min, max, count.",
      },
      group_by: {
        type: "string",
        description: "Column name to group by before computing stats.",
      },
      add_computed: {
        type: "object",
        description:
          "Add computed columns. Keys are new column names, values are arithmetic expressions referencing existing columns (e.g., 'quantity * price').",
      },
      sort_by: {
        type: "string",
        description: "Column name to sort results by.",
      },
      sort_order: {
        type: "string",
        description: "Sort order: 'asc' (default) or 'desc'.",
      },
      limit: {
        type: "number",
        description: "Limit the number of rows returned.",
      },
    },
    required: [],
  },
};

/**
 * Create a handler bound to a default working directory.
 * Relative csv_file paths are resolved against workDir.
 */
export function createHandler(workDir: string) {
  return (input: Record<string, unknown>) => handler(input, workDir);
}

// ─── CSV Parsing ─────────────────────────────────────────────────

interface ParsedCsv {
  headers: string[];
  rows: Record<string, unknown>[];
}

function parseCsvText(csvText: string): ParsedCsv {
  const lines = csvText.trim().split("\n");
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows: Record<string, unknown>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    // Parse respecting quoted fields
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]!;
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    values.push(current.trim());

    const row: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      const val = values[idx] || "";
      const num = Number(val);
      row[h] = isNaN(num) || val === "" ? val : num;
    });
    rows.push(row);
  }

  return { headers, rows };
}

// ─── Expression Evaluator ────────────────────────────────────────

/**
 * Evaluate a simple arithmetic expression with column references.
 * Supports +, -, *, / with correct operator precedence.
 */
function evaluateSimpleExpr(
  expr: string,
  row: Record<string, unknown>,
  headers: string[],
): number | null {
  // Replace column references with their numeric values
  // Sort by length (longest first) to avoid partial replacement
  let resolved = expr;
  const sortedHeaders = [...headers].sort((a, b) => b.length - a.length);
  for (const h of sortedHeaders) {
    const val = row[h];
    if (typeof val === "number") {
      const regex = new RegExp(
        "\\b" + h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
        "g",
      );
      resolved = resolved.replace(regex, String(val));
    }
  }

  // Tokenize into numbers and operators
  const tokens: (number | string)[] = [];
  let buf = "";
  for (let i = 0; i < resolved.length; i++) {
    const c = resolved[i]!;
    if (c === " ") {
      if (buf) { tokens.push(Number(buf)); buf = ""; }
      continue;
    }
    if ("+-*/".includes(c)) {
      if (buf) { tokens.push(Number(buf)); buf = ""; }
      tokens.push(c);
    } else {
      buf += c;
    }
  }
  if (buf) tokens.push(Number(buf));

  // Validate all number tokens
  for (const t of tokens) {
    if (typeof t === "number" && isNaN(t)) return null;
  }

  // Evaluate with operator precedence: * / first, then + -
  const evalOps = (toks: (number | string)[], ops: string[]): (number | string)[] => {
    const result: (number | string)[] = [toks[0]!];
    for (let i = 1; i < toks.length; i += 2) {
      const op = toks[i] as string;
      const right = toks[i + 1] as number;
      if (ops.includes(op)) {
        const left = result.pop() as number;
        if (op === "*") result.push(left * right);
        else if (op === "/") result.push(right !== 0 ? left / right : 0);
        else if (op === "+") result.push(left + right);
        else if (op === "-") result.push(left - right);
      } else {
        result.push(op, right);
      }
    }
    return result;
  };

  let toks = evalOps(tokens, ["*", "/"]);
  toks = evalOps(toks, ["+", "-"]);
  return typeof toks[0] === "number" ? toks[0] : null;
}

// ─── Stats ───────────────────────────────────────────────────────

function computeStat(values: number[], op: string): number {
  if (values.length === 0) return 0;
  switch (op) {
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
    case "count": return values.length;
    default: return 0;
  }
}

// ─── Handler ─────────────────────────────────────────────────────

export async function handler(
  input: Record<string, unknown>,
  workDir?: string,
): Promise<string> {
  // Load CSV data
  let csvText = (input.csv_text as string) || "";
  if (input.csv_file) {
    let filePath = input.csv_file as string;
    if (workDir && !filePath.startsWith("/")) {
      filePath = resolve(workDir, filePath);
    }
    try {
      csvText = await Bun.file(filePath).text();
    } catch (err) {
      return JSON.stringify({
        error: `Failed to read file: ${filePath}. ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (!csvText.trim()) {
    return JSON.stringify({ error: "No CSV data provided. Use csv_file or csv_text." });
  }

  let { headers, rows } = parseCsvText(csvText);

  // Add computed columns
  const addComputed = input.add_computed as Record<string, string> | undefined;
  if (addComputed) {
    for (const row of rows) {
      for (const [newCol, expr] of Object.entries(addComputed)) {
        row[newCol] = evaluateSimpleExpr(expr, row, headers);
      }
    }
    for (const c of Object.keys(addComputed)) {
      if (!headers.includes(c)) headers.push(c);
    }
  }

  // Filter rows
  const filter = input.filter as Record<string, unknown> | undefined;
  if (filter) {
    rows = rows.filter((row) =>
      Object.entries(filter).every(([key, val]) => String(row[key]) === String(val)),
    );
  }

  const statsInput = input.stats as Record<string, string[]> | undefined;
  const groupBy = input.group_by as string | undefined;
  const sortBy = input.sort_by as string | undefined;
  const sortOrder = (input.sort_order as string) || "asc";
  const limit = input.limit as number | undefined;

  // Group by + stats
  if (groupBy && statsInput) {
    const groups: Record<string, Record<string, unknown>[]> = {};
    for (const row of rows) {
      const key = String(row[groupBy]);
      if (!groups[key]) groups[key] = [];
      groups[key]!.push(row);
    }

    const results: Record<string, unknown>[] = [];
    for (const [groupKey, groupRows] of Object.entries(groups)) {
      const result: Record<string, unknown> = { [groupBy]: groupKey };
      for (const [col, ops] of Object.entries(statsInput)) {
        const values = groupRows.map((r) => Number(r[col])).filter((v) => !isNaN(v));
        const opsArr = Array.isArray(ops) ? ops : [ops];
        for (const op of opsArr) {
          result[`${col}_${op}`] = computeStat(values, op);
        }
      }
      results.push(result);
    }

    if (sortBy) {
      const ord = sortOrder === "desc" ? -1 : 1;
      results.sort((a, b) => {
        const av = a[sortBy] as number;
        const bv = b[sortBy] as number;
        return av < bv ? -ord : av > bv ? ord : 0;
      });
    }

    const limited = limit ? results.slice(0, limit) : results;
    return JSON.stringify({
      headers: Object.keys(limited[0] || {}),
      rows: limited,
      total_groups: Object.keys(groups).length,
    });
  }

  // Stats without group_by
  if (statsInput && !groupBy) {
    const result: Record<string, number> = {};
    for (const [col, ops] of Object.entries(statsInput)) {
      const values = rows.map((r) => Number(r[col])).filter((v) => !isNaN(v));
      const opsArr = Array.isArray(ops) ? ops : [ops];
      for (const op of opsArr) {
        result[`${col}_${op}`] = computeStat(values, op);
      }
    }
    return JSON.stringify({ stats: result, row_count: rows.length });
  }

  // Select columns
  const columns = input.columns as string[] | undefined;
  if (columns) {
    rows = rows.map((row) => {
      const newRow: Record<string, unknown> = {};
      for (const c of columns) { newRow[c] = row[c]; }
      return newRow;
    });
  }

  // Sort
  if (sortBy) {
    const ord = sortOrder === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[sortBy] as number;
      const bv = b[sortBy] as number;
      return av < bv ? -ord : av > bv ? ord : 0;
    });
  }

  // Limit
  if (limit) {
    rows = rows.slice(0, limit);
  }

  return JSON.stringify({
    headers: columns || headers,
    rows,
    row_count: rows.length,
  });
}
