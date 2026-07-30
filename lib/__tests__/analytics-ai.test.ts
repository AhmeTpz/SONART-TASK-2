import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  aiReportSchema,
  analyzeRequestSchema,
  buildAiContext,
  parseAiReport,
  validateAiReportForContext,
} from "@/lib/ai-contract";
import { readCachedAiSuccess } from "@/lib/ai-cache";
import { buildDashboardAnalytics } from "@/lib/analytics";
import { ingestCsv } from "@/lib/data-pipeline";
import {
  callWithModelFallback,
  FALLBACK_MODEL,
  PRIMARY_MODEL,
  resolveGeminiApiKey,
} from "@/lib/model-fallback";
import { erpProfile } from "@/lib/profiles/erp-profile";

const SYNTHETIC_HEADER =
  "stok_kodu,urun_adi,kategori,depo,donem,giris_miktar,cikis_miktar,donem_sonu_stok,birim_maliyet_tl,birim_satis_tl";

function syntheticCsv(lines: string[]): Buffer {
  return Buffer.from([SYNTHETIC_HEADER, ...lines].join("\n"));
}

function syntheticRow(
  sku: string,
  period: string,
  values: { sales?: number; stock?: number; input?: number; cost?: number; price?: number } = {},
): string {
  return [
    sku,
    `${sku} Ürün`,
    "Kategori",
    "Ana Depo",
    period,
    values.input ?? 10,
    values.sales ?? 10,
    values.stock ?? 100,
    values.cost ?? 10,
    values.price ?? 20,
  ].join(",");
}

function regressionData() {
  return ingestCsv(
    fs.readFileSync(path.join(process.cwd(), "public/data/sonart_erp_cok_donemli_2.csv")),
    erpProfile,
  );
}

describe("ERP analitiği", () => {
  it("altı aylık regresyon KPI'larını doğru hesaplar ve stoku son snapshot'tan alır", () => {
    const ingestion = regressionData();
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, "ALL");
    expect(analytics.totals.revenue).toBe(1_039_388);
    expect(analytics.totals.grossProfit).toBe(411_198);
    expect(analytics.totals.weightedMargin * 100).toBeCloseTo(39.56, 2);
    expect(analytics.totals.stock).toBe(
      ingestion.rows
        .filter((row) => row.donem === ingestion.periods.at(-1))
        .reduce((sum, row) => sum + (row.donem_sonu_stok ?? 0), 0),
    );
  });

  it("U007 Mart sinyallerini SKU'ya özel kod olmadan genel eşiklerden çıkarır", () => {
    const analytics = buildDashboardAnalytics(regressionData(), erpProfile, "2026-03");
    const signals = analytics.risks
      .filter((risk) => risk.stockCode === "U007")
      .map((risk) => risk.type);
    expect(signals).toEqual(
      expect.arrayContaining(["CRITICAL_STOCK", "MARGIN_DROP", "COST_SPIKE"]),
    );
    expect(signals).not.toContain("LOW_STOCK");
  });

  it("tekil kapsamda yalnız seçili dönemin akışlarını toplar", () => {
    const ingestion = regressionData();
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, "2026-04");
    const scopedRows = ingestion.rows.filter((row) => row.donem === "2026-04");
    const expectedRevenue = scopedRows.reduce(
      (sum, row) => sum + (row.cikis_miktar ?? 0) * (row.birim_satis_tl ?? 0),
      0,
    );
    expect(analytics.totals.revenue).toBe(expectedRevenue);
    expect(analytics.risks.every((risk) => risk.period === "2026-04")).toBe(true);
    expect(analytics.risks.every((risk) => risk.basis === "SINGLE_PERIOD")).toBe(true);
  });

  it("veride bulunmayan dönemi kabul etmez", () => {
    expect(() => buildDashboardAnalytics(regressionData(), erpProfile, "2099-01")).toThrow(
      "Geçersiz dönem",
    );
  });

  it("kısmi son dönemde eski stoku taşımadan yalnız gerçek snapshot'ı kullanır", () => {
    const ingestion = ingestCsv(syntheticCsv([
      syntheticRow("SKU-A", "2025-01", { stock: 100 }),
      syntheticRow("SKU-B", "2025-01", { stock: 200 }),
      syntheticRow("SKU-A", "2025-02", { stock: 80 }),
    ]), erpProfile);
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, "ALL");
    const missingLatestProduct = analytics.products.find((product) => product.stockCode === "SKU-B");

    expect(analytics.totals.stock).toBe(80);
    expect(missingLatestProduct?.latest).toMatchObject({ period: "2025-01", stock: null, inventoryStatus: "UNKNOWN" });
    expect(ingestion.audit.issues.some((issue) => issue.code === "INCOMPLETE_LATEST_PERIOD")).toBe(true);
  });

  it("tekil ay stok kapsamını yalnız seçili ayın satışından hesaplar", () => {
    const ingestion = ingestCsv(syntheticCsv([
      syntheticRow("SKU-AY", "2025-01", { sales: 100, stock: 100 }),
      syntheticRow("SKU-AY", "2025-02", { sales: 10, stock: 100 }),
    ]), erpProfile);
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, "2025-02");
    const product = analytics.products.find((item) => item.stockCode === "SKU-AY");
    const risk = analytics.risks.find((item) => item.stockCode === "SKU-AY");

    expect(product?.latest).toMatchObject({
      coverageMonths: 10,
      coverageBasis: "SELECTED_PERIOD_SALES",
      coveragePeriodCount: 1,
    });
    expect(risk).toMatchObject({ basis: "SINGLE_PERIOD", observedPeriodCount: 1 });
    expect(risk?.detail).toContain("Seçili dönem satış hızına");
  });

  it("tüm dönem stok kapsamını geçerli dönemlerin ortalama satışı ve son stoktan hesaplar", () => {
    const ingestion = ingestCsv(syntheticCsv([
      syntheticRow("SKU-GAP", "2025-01", { sales: 10, stock: 30 }),
      syntheticRow("SKU-GAP", "2025-03", { sales: 30, stock: 300 }),
    ]), erpProfile);
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, "ALL");
    const product = analytics.products.find((item) => item.stockCode === "SKU-GAP");
    const currentRisk = analytics.risks.find(
      (risk) => risk.stockCode === "SKU-GAP" && risk.period === "2025-03",
    );

    expect(product?.latest).toMatchObject({
      coverageMonths: 15,
      coverageBasis: "RANGE_AVERAGE_MONTHLY_SALES",
      coveragePeriodCount: 2,
    });
    expect(currentRisk).toMatchObject({
      basis: "MULTI_PERIOD",
      startPeriod: "2025-01",
      period: "2025-03",
      observedPeriodCount: 2,
    });
    expect(currentRisk?.detail).toContain("Tüm dönemlerdeki geçerli aylık kayıtların ortalama satış hızına");
    expect(analytics.risks.filter((risk) => risk.stockCode === "SKU-GAP" && risk.type === "SLOW_MOVING")).toHaveLength(1);
  });

  it("tüm dönem maliyet ve marj değişimini ilk ve son dönem arasında ölçer", () => {
    const ingestion = ingestCsv(syntheticCsv([
      syntheticRow("SKU-DEGISIM", "2025-01", { cost: 10, price: 20 }),
      syntheticRow("SKU-DEGISIM", "2025-02", { cost: 11.5, price: 20 }),
      syntheticRow("SKU-DEGISIM", "2025-03", { cost: 12, price: 20 }),
    ]), erpProfile);
    const all = buildDashboardAnalytics(ingestion, erpProfile, "ALL");
    const march = buildDashboardAnalytics(ingestion, erpProfile, "2025-03");
    const allTypes = all.risks
      .filter((risk) => risk.stockCode === "SKU-DEGISIM")
      .map((risk) => risk.type);
    const marchTypes = march.risks
      .filter((risk) => risk.stockCode === "SKU-DEGISIM")
      .map((risk) => risk.type);

    expect(allTypes).toEqual(expect.arrayContaining(["COST_SPIKE", "MARGIN_DROP"]));
    expect(marchTypes).not.toContain("COST_SPIKE");
    expect(marchTypes).not.toContain("MARGIN_DROP");
    expect(all.risks.find((risk) => risk.type === "COST_SPIKE")?.detail).toContain("ilk dönemden son döneme");
  });

  it("raporun gerçek ilk döneminde bulunmayan ürün için ilk-son değişim sinyali üretmez", () => {
    const ingestion = ingestCsv(syntheticCsv([
      syntheticRow("SKU-TAM", "2025-01"),
      syntheticRow("SKU-TAM", "2025-02"),
      syntheticRow("SKU-TAM", "2025-03"),
      syntheticRow("SKU-GEC", "2025-02", { cost: 10, price: 20 }),
      syntheticRow("SKU-GEC", "2025-03", { cost: 15, price: 20 }),
    ]), erpProfile);
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, "ALL");
    const lateProduct = analytics.products.find((product) => product.stockCode === "SKU-GEC");
    const lateChangeTypes = analytics.risks
      .filter((risk) => risk.stockCode === "SKU-GEC")
      .map((risk) => risk.type);

    expect(lateProduct?.changes.costRatio).toBeNull();
    expect(lateProduct?.changes.marginPoints).toBeNull();
    expect(lateChangeTypes).not.toContain("COST_SPIKE");
    expect(lateChangeTypes).not.toContain("MARGIN_DROP");
  });

  it("tüm dönem akış toplamını son dönem stok fotoğrafından ayırır", () => {
    const ingestion = ingestCsv(syntheticCsv([
      syntheticRow("SKU-A", "2025-01", { sales: 10, stock: 100, price: 20 }),
      syntheticRow("SKU-A", "2025-02", { sales: 20, stock: 70, price: 20 }),
    ]), erpProfile);
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, "ALL");
    expect(analytics.totals.revenue).toBe(600);
    expect(analytics.totals.stock).toBe(70);
  });
});

describe("AI sözleşmesi", () => {
  const validReport = {
    yonetici_ozeti: "Altı aylık sonuçlar finansal ve operasyonel göstergelerle birlikte değerlendirilmiştir.",
    degerlendirme: {
      finansal_performans: "Ciro ile marjın dönem içindeki yönü birlikte izlenmelidir.",
      stok_ve_operasyon: "Portföyde düşük ve yüksek stok kapsamı birlikte bulunmaktadır.",
      urun_ve_portfoy: "Ürün katkıları farklılaştığı için ürün bazlı karar alınmalıdır.",
    },
    aksiyon_onerileri: [
      {
        baslik: "Tedarik planını ürün bazında ayır",
        aksiyon: "Kritik kapsama sahip ürünlerin tedarik planını önceliklendir.",
        hedef: "Kritik kapsama sahip ürün ve depolar",
        gerekce: "Stok kapsamı ile ürün cirosu birlikte tedarik ihtiyacı gösteriyor.",
        sorumlu_birim: "Satın Alma ve Planlama",
        zaman_ufku: "7 gün",
        beklenen_etki: "Stok tükenme olasılığının azalması",
        takip_metrigi: "Aylık stok kapsamı",
        kanitlar: ["Stok kapsamı 0,4 ay", "Dönem sonu stok 30 birim"],
        oncelik: 1,
      },
      {
        baslik: "Fiyat ve maliyet dengesini incele",
        aksiyon: "Maliyet artışı yaşayan ürünlerde fiyatlama kontrolü yap.",
        hedef: "Maliyet artışı ve marj düşüşü birlikte görülen ürünler",
        gerekce: "Maliyet yükselişi marj üzerinde baskı oluşturuyor.",
        sorumlu_birim: "Finans ve Satış",
        zaman_ufku: "7 gün",
        beklenen_etki: "Brüt marjın korunması",
        takip_metrigi: "Ürün bazlı birim brüt marj",
        kanitlar: ["Maliyet değişimi %12", "Marj değişimi -5,2 puan"],
        oncelik: 2,
      },
      {
        baslik: "Yavaş stokları satış planına bağla",
        aksiyon: "Yüksek stok kapsamına sahip ürünler için hedefli satış planı oluştur.",
        hedef: "Yavaş hareket eden ürün ve depolar",
        gerekce: "Düşük satış hızı ile yüksek stok kapsamı işletme sermayesini bağlıyor.",
        sorumlu_birim: "Satış ve Planlama",
        zaman_ufku: "30 gün",
        beklenen_etki: "Stok kapsamının kontrollü biçimde azalması",
        takip_metrigi: "Ürün bazlı stok kapsamı ve satış miktarı",
        kanitlar: ["Stok kapsamı 8,4 ay", "Son dönem satış miktarı 20 birim"],
        oncelik: 3,
      },
    ],
  } as const;

  it("yalnız scope alanını kabul eder", () => {
    expect(analyzeRequestSchema.safeParse({ scope: "ALL" }).success).toBe(true);
    expect(analyzeRequestSchema.safeParse({ scope: "2026-03", rawCsv: "secret" }).success).toBe(false);
    expect(analyzeRequestSchema.safeParse({}).success).toBe(false);
  });

  it("yapı dışı model cevabını reddeder", () => {
    expect(aiReportSchema.safeParse(validReport).success).toBe(true);
    expect(() => parseAiReport("plain text")).toThrow("geçerli JSON");
    expect(() => parseAiReport(JSON.stringify({ yonetici_ozeti: "eksik" }))).toThrow(
      "beklenen rapor şemasına",
    );
  });

  it("aksiyon hedefinde bulunmayan ürün koduna ait kanıtı reddeder", () => {
    const mismatchedEvidence = {
      ...validReport,
      aksiyon_onerileri: validReport.aksiyon_onerileri.map((action, index) =>
        index === 0
          ? { ...action, hedef: "SKU-A – Birinci Ürün", kanitlar: ["Stok (SKU-A): 24 birim", "Stok kapsamı (SKU-B): 1,2 ay"] }
          : action,
      ),
    };
    expect(aiReportSchema.safeParse(mismatchedEvidence).success).toBe(false);
  });

  it("zorunlu karar alanlarından daha az aksiyon üreten raporu reddeder", () => {
    const typedValidReport = aiReportSchema.parse(validReport);
    const twoActionReport = {
      ...typedValidReport,
      aksiyon_onerileri: typedValidReport.aksiyon_onerileri.slice(0, 2),
    };
    const threeDomains = JSON.stringify({
      requiredActionDomains: [{ id: "A" }, { id: "B" }, { id: "C" }],
    });
    expect(() => validateAiReportForContext(twoActionReport, threeDomains)).toThrow(
      "zorunlu karar alanlarının tamamı",
    );
    expect(validateAiReportForContext(typedValidReport, threeDomains)).toEqual(typedValidReport);
  });

  it("AI bağlamına yalnız deterministik özetleri koyar", () => {
    const ingestion = regressionData();
    const context = buildAiContext(
      buildDashboardAnalytics(ingestion, erpProfile, "ALL"),
      ingestion,
    );
    expect(context).toContain("dataQuality");
    expect(context).toContain("MULTI_PERIOD");
    expect(context).toContain("relevantProducts");
    expect(context).not.toContain("__sourceRow");
    expect(context).not.toContain('"row":');
    const parsedContext = JSON.parse(context) as {
      contextVersion: string;
      reportScope: { stockRiskDefinition: string; changeRiskDefinition: string };
      portfolio: { scopeRuleSignalCount: number; includedRuleSignalCount: number };
      requiredActionDomains: Array<{ id: string; signalCount: number }>;
      relevantProducts: Array<{
        latestSnapshot: { coverageBasis: string; coveragePeriodCount: number };
        scopeChanges: { comparisonBasis: string };
      }>;
      ruleSignals: Array<{ basis: string; observedPeriodCount: number }>;
      dataQuality: {
        inclusionRatePercent: number;
        estimatedRowCountInReportScope: number;
        estimatedFinancialImpact: { revenueTl: number; grossProfitTl: number };
      };
    };
    expect(parsedContext.dataQuality.estimatedRowCountInReportScope).toBe(1);
    expect(parsedContext.dataQuality.estimatedFinancialImpact).toEqual({
      revenueTl: 9_100,
      grossProfitTl: 3_500,
    });
    expect(parsedContext.contextVersion).toBe("3.0");
    expect(parsedContext.reportScope.stockRiskDefinition).toContain("ortalama aylık satış hızı");
    expect(parsedContext.reportScope.changeRiskDefinition).toContain("başlangıç dönemi");
    expect(parsedContext.portfolio.includedRuleSignalCount).toBe(parsedContext.ruleSignals.length);
    expect(parsedContext.portfolio.scopeRuleSignalCount).toBeGreaterThanOrEqual(parsedContext.ruleSignals.length);
    expect(parsedContext.requiredActionDomains.map((domain) => domain.id)).toEqual([
      "SUPPLY_CONTINUITY",
      "INVENTORY_EFFICIENCY",
      "PROFITABILITY_CONTROL",
    ]);
    expect(parsedContext.relevantProducts[0]?.latestSnapshot.coverageBasis).toBe("RANGE_AVERAGE_MONTHLY_SALES");
    expect(parsedContext.relevantProducts[0]?.scopeChanges.comparisonBasis).toBe("FIRST_TO_LAST");
    expect(parsedContext.ruleSignals.every((risk) => risk.basis === "MULTI_PERIOD")).toBe(true);
    expect(context).not.toContain("ruleSignalHistory");
    expect(parsedContext.dataQuality.inclusionRatePercent).toBe(98.9);
  });

  it("tekil dönem AI bağlamına gelecek dönem trendlerini sızdırmaz", () => {
    const ingestion = regressionData();
    const context = JSON.parse(
      buildAiContext(
        buildDashboardAnalytics(ingestion, erpProfile, "2026-01"),
        ingestion,
      ),
    ) as {
      monthlyTrend: Array<{ period: string }>;
      reportScope: { stockRiskDefinition: string; changeRiskDefinition: string };
      relevantProducts: Array<{
        latestSnapshot: { coverageBasis: string };
        scopeChanges: { comparisonBasis: string };
      }>;
    };
    expect(context.monthlyTrend.map((item) => item.period)).toEqual(["2026-01"]);
    expect(context.reportScope.stockRiskDefinition).toContain("yalnız seçili dönemin satış miktarı");
    expect(context.reportScope.changeRiskDefinition).toContain("bir önceki bitişik dönem");
    expect(context.relevantProducts[0]?.latestSnapshot.coverageBasis).toBe("SELECTED_PERIOD_SALES");
    expect(context.relevantProducts[0]?.scopeChanges.comparisonBasis).toBe("PREVIOUS_TO_SELECTED");
  });

  it("AI cache kaydını yalnız kapsam ve veri sürümü birlikte eşleşirse kabul eder", () => {
    const cached = JSON.stringify({
      status: "success",
      scope: "ALL",
      dataVersion: "profile:v1",
      report: validReport,
      model: "model",
      generatedAt: "2026-07-30T10:00:00.000Z",
    });
    expect(readCachedAiSuccess(cached, "ALL", "profile:v1")?.report).toEqual(validReport);
    expect(readCachedAiSuccess(cached, "ALL", "profile:v2")).toBeNull();
    expect(readCachedAiSuccess(cached, "2025-01", "profile:v1")).toBeNull();
    expect(readCachedAiSuccess("not-json", "ALL", "profile:v1")).toBeNull();
  });

  it("yalnız model-bulunamadı hatasında fallback kullanır", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === PRIMARY_MODEL) throw Object.assign(new Error("model not found"), { status: 404 });
      return validReport;
    });
    const result = await callWithModelFallback(call);
    expect(result.model).toBe(FALLBACK_MODEL);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("timeout hatasında farklı modele geçmez", async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error("request timeout"), { status: 408 });
    });
    await expect(callWithModelFallback(call)).rejects.toThrow("timeout");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("eksik veya boş API anahtarını çağrıdan önce reddeder", () => {
    expect(() => resolveGeminiApiKey(undefined)).toThrow("GEMINI_API_KEY");
    expect(() => resolveGeminiApiKey("   ")).toThrow("GEMINI_API_KEY");
    expect(resolveGeminiApiKey("server-key")).toBe("server-key");
  });
});
