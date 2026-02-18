import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { definition, handler, createHandler } from "./parse-csv.ts";

const sampleCsv = `date,product,quantity,price,region
2024-01-05,Laptop,2,999.99,North
2024-01-08,Mouse,15,24.99,South
2024-01-10,Keyboard,8,79.99,East
2024-01-12,Monitor,3,349.99,West
2024-01-15,Mouse,10,24.99,North`;

describe("parse-csv definition", () => {
  test("has correct name and schema", () => {
    expect(definition.name).toBe("parse-csv");
    expect(definition.description).toBeTruthy();
    expect(definition.input_schema).toBeDefined();
  });
});

describe("parse-csv handler", () => {
  test("parses CSV text into rows", async () => {
    const result = JSON.parse(await handler({ csv_text: sampleCsv }));
    expect(result.row_count).toBe(5);
    expect(result.headers).toContain("product");
    expect(result.headers).toContain("quantity");
    expect(result.rows[0].product).toBe("Laptop");
    expect(result.rows[0].quantity).toBe(2);
    expect(result.rows[0].price).toBe(999.99);
  });

  test("filters rows by column value", async () => {
    const result = JSON.parse(
      await handler({ csv_text: sampleCsv, filter: { product: "Mouse" } }),
    );
    expect(result.row_count).toBe(2);
    expect(result.rows.every((r: Record<string, unknown>) => r.product === "Mouse")).toBe(true);
  });

  test("selects specific columns", async () => {
    const result = JSON.parse(
      await handler({ csv_text: sampleCsv, columns: ["product", "quantity"] }),
    );
    expect(result.headers).toEqual(["product", "quantity"]);
    expect(Object.keys(result.rows[0])).toEqual(["product", "quantity"]);
  });

  test("computes stats without group_by", async () => {
    const result = JSON.parse(
      await handler({
        csv_text: sampleCsv,
        stats: { quantity: ["sum", "avg", "min", "max", "count"] },
      }),
    );
    expect(result.stats.quantity_sum).toBe(38);
    expect(result.stats.quantity_avg).toBeCloseTo(7.6);
    expect(result.stats.quantity_min).toBe(2);
    expect(result.stats.quantity_max).toBe(15);
    expect(result.stats.quantity_count).toBe(5);
    expect(result.row_count).toBe(5);
  });

  test("computes group_by with stats", async () => {
    const result = JSON.parse(
      await handler({
        csv_text: sampleCsv,
        group_by: "product",
        stats: { quantity: ["sum"] },
      }),
    );
    expect(result.total_groups).toBe(4);
    const mouse = result.rows.find((r: Record<string, unknown>) => r.product === "Mouse");
    expect(mouse.quantity_sum).toBe(25);
    const laptop = result.rows.find((r: Record<string, unknown>) => r.product === "Laptop");
    expect(laptop.quantity_sum).toBe(2);
  });

  test("adds computed columns", async () => {
    const result = JSON.parse(
      await handler({
        csv_text: sampleCsv,
        add_computed: { revenue: "quantity * price" },
      }),
    );
    expect(result.headers).toContain("revenue");
    // Laptop: 2 * 999.99 = 1999.98
    expect(result.rows[0].revenue).toBeCloseTo(1999.98, 1);
    // Mouse: 15 * 24.99 = 374.85
    expect(result.rows[1].revenue).toBeCloseTo(374.85, 1);
  });

  test("sorts ascending", async () => {
    const result = JSON.parse(
      await handler({ csv_text: sampleCsv, sort_by: "quantity", sort_order: "asc" }),
    );
    expect(result.rows[0].quantity).toBe(2);
    expect(result.rows[result.rows.length - 1].quantity).toBe(15);
  });

  test("sorts descending", async () => {
    const result = JSON.parse(
      await handler({ csv_text: sampleCsv, sort_by: "quantity", sort_order: "desc" }),
    );
    expect(result.rows[0].quantity).toBe(15);
    expect(result.rows[result.rows.length - 1].quantity).toBe(2);
  });

  test("limits rows", async () => {
    const result = JSON.parse(
      await handler({ csv_text: sampleCsv, sort_by: "quantity", sort_order: "desc", limit: 2 }),
    );
    expect(result.row_count).toBe(2);
    expect(result.rows[0].quantity).toBe(15);
  });

  test("handles quoted CSV fields", async () => {
    const csv = `name,desc,value\n"Smith, John","A ""quoted"" value",42`;
    const result = JSON.parse(await handler({ csv_text: csv }));
    expect(result.rows[0].name).toBe("Smith, John");
    expect(result.rows[0].value).toBe(42);
  });

  test("returns error for empty input", async () => {
    const result = JSON.parse(await handler({}));
    expect(result.error).toContain("No CSV data");
  });

  test("returns error for missing file", async () => {
    const result = JSON.parse(await handler({ csv_file: "/nonexistent/file.csv" }));
    expect(result.error).toContain("Failed to read file");
  });
});

describe("parse-csv createHandler", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/sealteam-parse-csv-test-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${tmpDir}`.quiet();
  });

  afterEach(async () => {
    await Bun.$`rm -rf ${tmpDir}`.quiet();
  });

  test("resolves relative csv_file paths against workDir", async () => {
    await Bun.write(`${tmpDir}/data.csv`, sampleCsv);
    const boundHandler = createHandler(tmpDir);
    const result = JSON.parse(await boundHandler({ csv_file: "data.csv" }));
    expect(result.row_count).toBe(5);
    expect(result.rows[0].product).toBe("Laptop");
  });

  test("absolute csv_file paths are not affected by workDir", async () => {
    await Bun.write(`${tmpDir}/data.csv`, sampleCsv);
    const boundHandler = createHandler("/some/other/dir");
    const result = JSON.parse(await boundHandler({ csv_file: `${tmpDir}/data.csv` }));
    expect(result.row_count).toBe(5);
  });
});
