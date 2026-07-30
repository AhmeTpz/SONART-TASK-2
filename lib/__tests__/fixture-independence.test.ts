import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ingestCsv } from "@/lib/data-pipeline";
import { erpProfile } from "@/lib/profiles/erp-profile";

const projectRoot = process.cwd();
const productionRoots = ["app", "components", "lib"];

function productionFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") visit(absolute);
      } else if (/\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) {
        files.push(absolute);
      }
    }
  };
  for (const root of productionRoots) visit(path.join(projectRoot, root));
  return files;
}

describe("demo fixture bağımsızlığı", () => {
  const fixture = ingestCsv(
    fs.readFileSync(path.join(projectRoot, "public/data/sonart_erp_cok_donemli_2.csv")),
    erpProfile,
  );
  const files = productionFiles();

  it("üretim kodunda demo SKU, ürün adı veya dönem sabiti bulundurmaz", () => {
    const demoTokens = new Set([
      ...fixture.rows.map((row) => row.stok_kodu),
      ...fixture.rows.map((row) => row.urun_adi),
    ]);
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const token of demoTokens) {
        expect(source, `${path.relative(projectRoot, file)} demo değeri içeriyor: ${token}`).not.toContain(token);
      }
      for (const period of fixture.periods) {
        expect(source, `${path.relative(projectRoot, file)} demo dönemi içeriyor: ${period}`).not.toContain(period);
      }
    }
  });

  it("üretim kararlarını demo satır numarası veya sonuç sabitlerine bağlamaz", () => {
    const rowCondition = /(?:__sourceRow|sourceRow)\s*(?:===|==|!==|!=|<=|>=|<|>)\s*(?:17|18|57)\b|\b(?:17|18|57)\s*(?:===|==|!==|!=|<=|>=|<|>)\s*(?:__sourceRow|sourceRow)/;
    const demoResultLiteral = /(?<![\d_])(?:700|5_?160|1_?039_?388|411_?198)(?![\d_])/;

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, `${path.relative(projectRoot, file)} kaynak satırına özel koşul içeriyor`).not.toMatch(rowCondition);
      expect(source, `${path.relative(projectRoot, file)} demo sonucuna özel sabit içeriyor`).not.toMatch(demoResultLiteral);
    }
  });

  it("demo CSV adını yalnız veri kaynağı seçiminde kullanır", () => {
    const references = files.filter((file) =>
      fs.readFileSync(file, "utf8").includes("sonart_erp_cok_donemli_2.csv"),
    );
    expect(references.map((file) => path.relative(projectRoot, file).replaceAll("\\", "/"))).toEqual([
      "lib/data-source.server.ts",
    ]);
  });
});
