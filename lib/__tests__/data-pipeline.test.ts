import fs from "node:fs";
import path from "node:path";

import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";

import {
  IngestionError,
  ingestCsv,
  parseLocaleNumber,
} from "@/lib/data-pipeline";
import { erpProfile } from "@/lib/profiles/erp-profile";
import type { ErpRow, ReportProfile } from "@/lib/types";

const HEADER =
  "stok_kodu,urun_adi,kategori,depo,donem,giris_miktar,cikis_miktar,donem_sonu_stok,birim_maliyet_tl,birim_satis_tl";

function csv(lines: string[]): Buffer {
  return Buffer.from([HEADER, ...lines].join("\n"), "utf8");
}

function row(
  sku: string,
  period: string,
  overrides: Partial<Record<keyof ErpRow, string | number>> = {},
): string {
  const values = {
    stok_kodu: sku,
    urun_adi: `${sku} Ürün`,
    kategori: "Kategori",
    depo: "Ana Depo",
    donem: period,
    giris_miktar: 100,
    cikis_miktar: 80,
    donem_sonu_stok: 200,
    birim_maliyet_tl: 10,
    birim_satis_tl: 20,
    ...overrides,
  };
  return [
    values.stok_kodu,
    values.urun_adi,
    values.kategori,
    values.depo,
    values.donem,
    values.giris_miktar,
    values.cikis_miktar,
    values.donem_sonu_stok,
    values.birim_maliyet_tl,
    values.birim_satis_tl,
  ].join(",");
}

function month(offset: number): string {
  const date = new Date(Date.UTC(2024, offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

describe("genellenebilir ERP ingestion", () => {
  it.each([3, 6, 7, 12])("%i dönemlik veriyi kod değişmeden işler", (periodCount) => {
    const lines = Array.from({ length: periodCount }, (_, index) =>
      row("SKU-X", month(index)),
    );
    const result = ingestCsv(csv(lines), erpProfile);
    expect(result.periods).toHaveLength(periodCount);
    expect(result.rows).toHaveLength(periodCount);
    expect(result.periodRange).toEqual({ from: month(0), to: month(periodCount - 1) });
  });

  it("aynı SKU'nun farklı depolarını korur, birebir kopyayı siler", () => {
    const base = row("SKU-X", "2025-01");
    const secondWarehouse = row("SKU-X", "2025-01", { depo: "Yan Depo" });
    const result = ingestCsv(csv([base, base, secondWarehouse]), erpProfile);
    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map((item) => item.depo))).toEqual(
      new Set(["Ana Depo", "Yan Depo"]),
    );
    expect(result.audit.summary.exactDuplicatesRemoved).toBe(1);
  });

  it("çelişkili doğal anahtardaki tüm adayları karantinaya alır", () => {
    const result = ingestCsv(
      csv([
        row("SKU-X", "2025-01", { cikis_miktar: 80 }),
        row("SKU-X", "2025-01", { cikis_miktar: 81 }),
      ]),
      erpProfile,
    );
    expect(result.rows).toHaveLength(0);
    expect(result.quarantinedRows).toHaveLength(2);
    expect(result.audit.issues.some((item) => item.code === "CONFLICTING_NATURAL_KEY")).toBe(true);
  });

  it("tek iç boşluğu stok köprüsüyle uzlaştırır, uç ve uzun boşlukları doldurmaz", () => {
    const result = ingestCsv(
      csv([
        row("MID", "2025-03", { giris_miktar: 1, cikis_miktar: 11, donem_sonu_stok: 30 }),
        row("MID", "2025-04", { giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
        row("MID", "2025-05", { giris_miktar: 3, cikis_miktar: 13, donem_sonu_stok: 10 }),
        row("EDGE", "2025-01", { giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
        row("EDGE", "2025-02", { cikis_miktar: 20 }),
        row("LONG", "2025-01", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 }),
        row("LONG", "2025-02", { giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
        row("LONG", "2025-03", { giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
        row("LONG", "2025-04", { giris_miktar: 40, cikis_miktar: 40, donem_sonu_stok: 100 }),
      ]),
      erpProfile,
    );
    expect(result.rows.find((item) => item.stok_kodu === "MID" && item.donem === "2025-04")).toMatchObject({
      giris_miktar: 2,
      cikis_miktar: 12,
      donem_sonu_stok: 20,
      __estimatedFields: ["giris_miktar", "cikis_miktar", "donem_sonu_stok"],
    });
    expect(result.rows.find((item) => item.stok_kodu === "EDGE" && item.donem === "2025-01")?.cikis_miktar).toBeNull();
    expect(result.rows.filter((item) => item.stok_kodu === "LONG" && item.cikis_miktar === null)).toHaveLength(2);
    expect(result.audit.issues.some((item) => item.code === "INVENTORY_STOCK_DERIVED")).toBe(true);
  });

  it("tamamen eksik dönem satırı üretmez", () => {
    const result = ingestCsv(
      csv([row("SKU-X", "2025-01"), row("SKU-X", "2025-03")]),
      erpProfile,
    );
    expect(result.periods).toEqual(["2025-01", "2025-03"]);
    expect(result.rows).toHaveLength(2);
    expect(result.audit.issues.some((item) => item.code === "MISSING_PERIOD_ROW")).toBe(true);
  });

  it("yalnız stok eksikse giriş-çıkış denkliğinden roll-forward türetir", () => {
    const result = ingestCsv(
      csv([
        row("STOCK-ONLY", "2025-01", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 }),
        row("STOCK-ONLY", "2025-02", { giris_miktar: 20, cikis_miktar: 5, donem_sonu_stok: "" }),
        row("STOCK-ONLY", "2025-03", { giris_miktar: 0, cikis_miktar: 0, donem_sonu_stok: 115 }),
      ]),
      erpProfile,
    );
    expect(
      result.rows.find(
        (item) => item.stok_kodu === "STOCK-ONLY" && item.donem === "2025-02",
      ),
    ).toMatchObject({
      giris_miktar: 20,
      cikis_miktar: 5,
      donem_sonu_stok: 115,
      __estimatedFields: ["donem_sonu_stok"],
    });
  });

  it("stok mutabakatı olağan dışı ayar gerektiriyorsa otomatik doldurmaz", () => {
    const result = ingestCsv(
      csv([
        row("CONFLICT", "2025-01", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 }),
        row("CONFLICT", "2025-02", { giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
        row("CONFLICT", "2025-03", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 300 }),
      ]),
      erpProfile,
    );
    const unresolved = result.rows.find(
      (item) => item.stok_kodu === "CONFLICT" && item.donem === "2025-02",
    );
    expect(unresolved).toMatchObject({
      giris_miktar: null,
      cikis_miktar: null,
      donem_sonu_stok: null,
    });
    expect(
      result.audit.issues.some((item) => item.code === "INVENTORY_BRIDGE_CONFLICT"),
    ).toBe(true);
  });

  it("rastgele konumdaki birebir kopyayı içerik hash'iyle tekilleştirir", () => {
    const duplicate = row("SKU-DUP", "2025-01");
    const result = ingestCsv(
      csv([duplicate, row("SKU-MIDDLE", "2025-01"), row("SKU-END", "2025-02"), duplicate]),
      erpProfile,
    );
    expect(result.rows.filter((item) => item.stok_kodu === "SKU-DUP")).toHaveLength(1);
    expect(result.audit.summary.exactDuplicatesRemoved).toBe(1);
  });

  it("virgül içeren quoted alanı tek hücre olarak okur", () => {
    const result = ingestCsv(
      csv(['SKU-Q,"Deri, Çanta",Aksesuar,Ana Depo,2025-01,10,8,20,5,9']),
      erpProfile,
    );
    expect(result.rows[0].urun_adi).toBe("Deri, Çanta");
  });

  it("eksik zorunlu kolonu sessizce geçmez", () => {
    expect(() => ingestCsv(Buffer.from("stok_kodu,donem\nSKU-X,2025-01"), erpProfile)).toThrow(
      IngestionError,
    );
  });

  it.each([
    "giris_miktar",
    "cikis_miktar",
    "donem_sonu_stok",
    "birim_maliyet_tl",
    "birim_satis_tl",
  ] as const)("negatif %s değerini profil sınırıyla analiz dışına alır", (field) => {
    const result = ingestCsv(csv([row("SKU-NEG", "2025-01", { [field]: -1 })]), erpProfile);
    expect(result.rows).toHaveLength(0);
    expect(result.quarantinedRows).toHaveLength(1);
    expect(result.audit.issues.some((issue) => issue.code === "VALUE_OUT_OF_RANGE" && issue.field === field)).toBe(true);
  });

  it("sıfır sınır değerini geçerli kabul eder", () => {
    const result = ingestCsv(csv([row("SKU-ZERO", "2025-01", {
      giris_miktar: 0,
      cikis_miktar: 0,
      donem_sonu_stok: 0,
      birim_maliyet_tl: 0,
      birim_satis_tl: 0,
    })]), erpProfile);
    expect(result.rows).toHaveLength(1);
    expect(result.audit.issues.some((issue) => issue.code === "VALUE_OUT_OF_RANGE")).toBe(false);
  });

  it("ana veri değişimini uyarır fakat değeri otomatik değiştirmez", () => {
    const result = ingestCsv(csv([
      row("SKU-DRIFT", "2025-01", { urun_adi: "Eski Ad", kategori: "Kategori A" }),
      row("SKU-DRIFT", "2025-02", { urun_adi: "Yeni Ad", kategori: "Kategori B" }),
    ]), erpProfile);
    expect(result.rows.map((item) => item.urun_adi)).toEqual(["Eski Ad", "Yeni Ad"]);
    expect(result.audit.issues.filter((issue) => issue.code === "MASTER_DATA_DRIFT")).toHaveLength(2);
  });

  it("yalnız gerçek önceki takvim ayına göre eksik son dönem kaydını uyarır", () => {
    const result = ingestCsv(csv([
      row("SKU-A", "2025-01"),
      row("SKU-B", "2025-01"),
      row("SKU-A", "2025-02"),
    ]), erpProfile);
    const warning = result.audit.issues.find((issue) => issue.code === "INCOMPLETE_LATEST_PERIOD");
    expect(warning?.details).toMatchObject({
      latestPeriod: "2025-02",
      previousPeriod: "2025-01",
      missingGroupCount: 1,
    });

    const nonAdjacent = ingestCsv(csv([
      row("SKU-A", "2025-01"),
      row("SKU-A", "2025-03"),
    ]), erpProfile);
    expect(nonAdjacent.audit.issues.some((issue) => issue.code === "INCOMPLETE_LATEST_PERIOD")).toBe(false);
  });

  it("tüm satırlar karantinadaysa boş ve nesnel sonuç döndürür", () => {
    const result = ingestCsv(csv([row("SKU-NEG", "2025-01", { cikis_miktar: -5 })]), erpProfile);
    expect(result.rows).toEqual([]);
    expect(result.periods).toEqual([]);
    expect(result.inclusionRate).toBe(0);
    expect(result.counts).toEqual({ raw: 1, used: 0, quarantined: 1 });
  });

  it("veri sürümünü satır sırasından bağımsız, içerik ve profil değişimine duyarlı üretir", () => {
    const first = row("SKU-A", "2025-01", { cikis_miktar: 10 });
    const second = row("SKU-B", "2025-01", { cikis_miktar: 20 });
    const original = ingestCsv(csv([first, second]), erpProfile);
    const reordered = ingestCsv(csv([second, first]), erpProfile);
    const changed = ingestCsv(csv([first, row("SKU-B", "2025-01", { cikis_miktar: 21 })]), erpProfile);
    const revisedProfile = { ...erpProfile, version: "test-profile-version" };
    const profileChanged = ingestCsv(csv([first, second]), revisedProfile);

    expect(reordered.dataVersion).toBe(original.dataVersion);
    expect(changed.dataVersion).not.toBe(original.dataVersion);
    expect(profileChanged.dataVersion).not.toBe(original.dataVersion);
  });
});

describe("stok köprüsü genelleme özellikleri", () => {
  function bridgeResult(
    sku: string,
    warehouse: string,
    year: number,
    scale = 1,
  ) {
    return ingestCsv(csv([
      row(sku, `${year}-03`, { depo: warehouse, giris_miktar: 1 * scale, cikis_miktar: 11 * scale, donem_sonu_stok: 30 * scale }),
      row(sku, `${year}-04`, { depo: warehouse, giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
      row(sku, `${year}-05`, { depo: warehouse, giris_miktar: 3 * scale, cikis_miktar: 13 * scale, donem_sonu_stok: 10 * scale }),
    ]), erpProfile);
  }

  it("SKU, depo ve yıl yeniden adlandırıldığında aynı matematiği uygular", () => {
    const left = bridgeResult("SKU-ALPHA", "Batı Depo", 2023).rows[1];
    const right = bridgeResult("MALZEME-987", "Doğu Lokasyon", 2031).rows[1];
    expect([right.giris_miktar, right.cikis_miktar, right.donem_sonu_stok]).toEqual([
      left.giris_miktar,
      left.cikis_miktar,
      left.donem_sonu_stok,
    ]);
  });

  it("miktar ölçeği on kat arttığında türetilen değerleri de on kat ölçekler", () => {
    const base = bridgeResult("SKU-SCALE", "Depo", 2025, 1).rows[1];
    const scaled = bridgeResult("SKU-SCALE", "Depo", 2025, 10).rows[1];
    expect(scaled.giris_miktar).toBe((base.giris_miktar ?? 0) * 10);
    expect(scaled.cikis_miktar).toBe((base.cikis_miktar ?? 0) * 10);
    expect(scaled.donem_sonu_stok).toBe((base.donem_sonu_stok ?? 0) * 10);
  });

  it("istikrarlı seride profil medyanını kullanır", () => {
    const result = ingestCsv(csv([
      row("SKU-STABLE", "2025-01", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 }),
      row("SKU-STABLE", "2025-02", { giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
      row("SKU-STABLE", "2025-03", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 }),
      row("SKU-STABLE", "2025-04", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 }),
    ]), erpProfile);
    const estimated = result.audit.issues.find((issue) => issue.code === "INVENTORY_INPUT_ESTIMATED");
    expect(estimated?.method).toBe("stable-median");
    expect(result.rows[1]).toMatchObject({ giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 });
  });

  it("yüksek varyanslı seriyi medyana zorlamaz ve takvim komşularını kullanır", () => {
    const result = ingestCsv(csv([
      row("SKU-VARIABLE", "2025-01", { giris_miktar: 0, cikis_miktar: 0, donem_sonu_stok: 100 }),
      row("SKU-VARIABLE", "2025-02", { giris_miktar: "", cikis_miktar: "", donem_sonu_stok: "" }),
      row("SKU-VARIABLE", "2025-03", { giris_miktar: 20, cikis_miktar: 20, donem_sonu_stok: 100 }),
      row("SKU-VARIABLE", "2025-04", { giris_miktar: 40, cikis_miktar: 40, donem_sonu_stok: 100 }),
    ]), erpProfile);
    const estimated = result.audit.issues.find((issue) => issue.code === "INVENTORY_INPUT_ESTIMATED");
    expect(estimated?.method).toBe("linear-time-interpolation");
    expect(result.rows[1]).toMatchObject({ giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 });
  });

  it("mutabakat sınırında kabul eder, sınır aşıldığında değer üretmez", () => {
    const scenario = (nextStock: number) => ingestCsv(csv([
      row("SKU-BOUNDARY", "2025-01", { giris_miktar: 100, cikis_miktar: 100, donem_sonu_stok: 100 }),
      row("SKU-BOUNDARY", "2025-02", { giris_miktar: 100, cikis_miktar: "", donem_sonu_stok: "" }),
      row("SKU-BOUNDARY", "2025-03", { giris_miktar: 100, cikis_miktar: 100, donem_sonu_stok: nextStock }),
      row("SKU-BOUNDARY", "2025-04", { giris_miktar: 100, cikis_miktar: 100, donem_sonu_stok: nextStock }),
    ]), erpProfile);
    expect(scenario(75).rows[1]).toMatchObject({ cikis_miktar: 125, donem_sonu_stok: 75 });
    expect(scenario(74).rows[1]).toMatchObject({ cikis_miktar: null, donem_sonu_stok: null });
  });

  it("mutabakat negatif hareket üretecekse profil oranı izin verse bile reddeder", () => {
    const permissiveProfile: ReportProfile<ErpRow> = {
      ...erpProfile,
      inventoryBridge: {
        ...erpProfile.inventoryBridge!,
        maxReconciliationAdjustmentRatio: 5,
      },
    };
    const result = ingestCsv(csv([
      row("SKU-NEGATIVE-BRIDGE", "2025-01", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 100 }),
      row("SKU-NEGATIVE-BRIDGE", "2025-02", { giris_miktar: 10, cikis_miktar: "", donem_sonu_stok: "" }),
      row("SKU-NEGATIVE-BRIDGE", "2025-03", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 120 }),
      row("SKU-NEGATIVE-BRIDGE", "2025-04", { giris_miktar: 10, cikis_miktar: 10, donem_sonu_stok: 120 }),
    ]), permissiveProfile);
    expect(result.rows[1]).toMatchObject({ cikis_miktar: null, donem_sonu_stok: null });
    expect(result.audit.issues.some((issue) => issue.code === "INVENTORY_BRIDGE_CONFLICT")).toBe(true);
  });
});

describe("encoding ve metin kalitesi", () => {
  const turkish = "İ ı Ş ş Ğ ğ Ü ü Ö ö Ç ç";
  const source = `${HEADER}\nSKU-1,${turkish},Döşemelik,Ana Depo,2025-01,1,1,1,1,2`;

  it.each([
    ["UTF-8", Buffer.from(source, "utf8")],
    ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)])],
    ["Windows-1254", iconv.encode(source, "windows-1254")],
    ["ISO-8859-9", iconv.encode(source, "iso-8859-9")],
  ])("%s dosyada Türkçe karakterleri korur", (_name, buffer) => {
    const result = ingestCsv(buffer, erpProfile);
    expect(result.rows[0].urun_adi).toBe(turkish);
  });

  it("geri döndürülebilir mojibake'i onarır ve audit'e yazar", () => {
    const result = ingestCsv(
      csv([row("SKU-X", "2025-01", { urun_adi: "DÃ¶ÅŸemelik" })]),
      erpProfile,
    );
    expect(result.rows[0].urun_adi).toBe("Döşemelik");
    expect(result.audit.issues.some((item) => item.code === "MOJIBAKE_REPAIRED")).toBe(true);
  });

  it("profil başlığı olmayan belirsiz binary içeriği tahmin etmez", () => {
    expect(() => ingestCsv(Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x78, 0x2c, 0x91]), erpProfile)).toThrow(
      IngestionError,
    );
  });

  it("ASCII transliterasyonu sözlüksüz değiştirmez, sözlükle deterministik düzeltir", () => {
    const unchanged = ingestCsv(
      csv([row("SKU-X", "2025-01", { kategori: "Kadin" })]),
      erpProfile,
    );
    expect(unchanged.rows[0].kategori).toBe("Kadin");

    const profile: ReportProfile<ErpRow> = {
      ...erpProfile,
      masterData: { kategori: { kadin: "Kadın" } },
    };
    const corrected = ingestCsv(
      csv([row("SKU-X", "2025-01", { kategori: "Kadin" })]),
      profile,
    );
    expect(corrected.rows[0].kategori).toBe("Kadın");
    expect(corrected.audit.issues.some((item) => item.code === "MASTER_DATA_MATCH")).toBe(true);
  });

  it("NFD metni NFC yapar, görünmez ve control karakterlerini temizler", () => {
    const dirtyName = `Do\u0308s\u0327emelik\u200B\u0007  Deri`;
    const result = ingestCsv(
      csv([row("SKU-X", "2025-01", { urun_adi: dirtyName })]),
      erpProfile,
    );
    expect(result.rows[0].urun_adi).toBe("Döşemelik Deri");
    expect(result.audit.issues.some((item) => item.code === "TEXT_NORMALIZED")).toBe(true);
  });
});

describe("sayısal ve dönem doğrulama", () => {
  it.each([
    ["1.234,56 TL", false, 1234.56],
    ["1.234", true, 1234],
    ["-12,5", false, -12.5],
    ["(1.250,25)", false, -1250.25],
    ["", false, null],
    ["NaN", false, null],
    ["Infinity", false, null],
    ["12x", false, null],
  ])("%s değerini güvenli parse eder", (value, integer, expected) => {
    expect(parseLocaleNumber(value, integer)).toBe(expected);
  });

  it("bozuk dönemli satırı metriklerden çıkarıp karantinaya alır", () => {
    const result = ingestCsv(csv([row("SKU-X", "2025-13")]), erpProfile);
    expect(result.rows).toHaveLength(0);
    expect(result.quarantinedRows).toHaveLength(1);
  });
});

describe("regresyon ve performans", () => {
  it("mevcut fixture'da 91 ham satırdan 90 temiz satır ve üç stok-köprüsü çıkarımı üretir", () => {
    const fixture = fs.readFileSync(
      path.join(process.cwd(), "public/data/sonart_erp_cok_donemli_2.csv"),
    );
    const result = ingestCsv(fixture, erpProfile);
    expect(result.counts).toEqual({ raw: 91, used: 90, quarantined: 0 });
    expect(result.audit.summary.exactDuplicatesRemoved).toBe(1);
    expect(result.audit.summary.imputations).toBe(3);
    const completed = result.rows.find(
      (item) => item.stok_kodu === "U010" && item.donem === "2026-04",
    );
    expect(completed).toMatchObject({
      giris_miktar: 700,
      cikis_miktar: 700,
      donem_sonu_stok: 5160,
    });
  });

  it("50.000 satırı karesel tarama olmadan işler", { timeout: 20_000 }, () => {
    const lines: string[] = [];
    for (let sku = 0; sku < 5_000; sku += 1) {
      for (let period = 0; period < 10; period += 1) {
        lines.push(row(`SKU-${sku}`, month(period)));
      }
    }
    const started = performance.now();
    const result = ingestCsv(csv(lines), erpProfile);
    const duration = performance.now() - started;
    expect(result.rows).toHaveLength(50_000);
    expect(duration).toBeLessThan(15_000);
  });
});
