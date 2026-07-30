import { z } from "zod";

import type {
  AiReport,
  DashboardAnalytics,
  ErpRow,
  IngestionResult,
  ProductAnalysis,
  RiskItem,
} from "@/lib/types";

export const analyzeRequestSchema = z
  .object({ scope: z.string().min(1).max(20) })
  .strict();

const detailedActionSchema = z
  .object({
    baslik: z.string().min(1).max(120),
    aksiyon: z.string().min(1).max(500),
    hedef: z.string().min(1).max(220),
    gerekce: z.string().min(1).max(600),
    sorumlu_birim: z.string().min(1).max(100),
    zaman_ufku: z.string().min(1).max(80),
    beklenen_etki: z.string().min(1).max(300),
    takip_metrigi: z.string().min(1).max(220),
    kanitlar: z.array(z.string().min(1).max(220)).min(2).max(4),
    oncelik: z.number().int().min(1).max(4),
  })
  .strict()
  .superRefine((action, context) => {
    for (const [evidenceIndex, evidence] of action.kanitlar.entries()) {
      const referencedCodes = [...evidence.matchAll(/\(([^()]+)\)/g)]
        .map((match) => match[1]?.trim())
        .filter((code): code is string => Boolean(code));
      for (const code of referencedCodes) {
        if (!action.hedef.includes(code)) {
          context.addIssue({
            code: "custom",
            message: `Kanıttaki ${code} kodu aksiyon hedefinde bulunmuyor.`,
            path: ["kanitlar", evidenceIndex],
          });
        }
      }
    }
  });

export const aiReportSchema = z
  .object({
    yonetici_ozeti: z.string().min(1).max(1400),
    degerlendirme: z
      .object({
        finansal_performans: z.string().min(1).max(1000),
        stok_ve_operasyon: z.string().min(1).max(1000),
        urun_ve_portfoy: z.string().min(1).max(1000),
      })
      .strict(),
    aksiyon_onerileri: z.array(detailedActionSchema).min(2).max(4),
  })
  .strict();

export const aiReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["yonetici_ozeti", "degerlendirme", "aksiyon_onerileri"],
  propertyOrdering: ["yonetici_ozeti", "degerlendirme", "aksiyon_onerileri"],
  properties: {
    yonetici_ozeti: {
      type: "string",
      description:
        "Rapor kapsamını doğru adlandıran, sonuçları ilişkilendirerek yorumlayan ayrıntılı yönetici özeti",
    },
    degerlendirme: {
      type: "object",
      additionalProperties: false,
      required: ["finansal_performans", "stok_ve_operasyon", "urun_ve_portfoy"],
      propertyOrdering: ["finansal_performans", "stok_ve_operasyon", "urun_ve_portfoy"],
      properties: {
        finansal_performans: {
          type: "string",
          description: "Ciro, kâr, marj ve dönem eğilimlerini birlikte yorumlayan değerlendirme",
        },
        stok_ve_operasyon: {
          type: "string",
          description: "Stok kapsamı, satış hızı ve operasyon dengesini yorumlayan değerlendirme",
        },
        urun_ve_portfoy: {
          type: "string",
          description: "Ürün, kategori, yoğunlaşma, katkı ve ayrışmaları yorumlayan değerlendirme",
        },
      },
    },
    aksiyon_onerileri: {
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "baslik",
          "aksiyon",
          "hedef",
          "gerekce",
          "sorumlu_birim",
          "zaman_ufku",
          "beklenen_etki",
          "takip_metrigi",
          "kanitlar",
          "oncelik",
        ],
        propertyOrdering: [
          "baslik",
          "aksiyon",
          "hedef",
          "gerekce",
          "sorumlu_birim",
          "zaman_ufku",
          "beklenen_etki",
          "takip_metrigi",
          "kanitlar",
          "oncelik",
        ],
        properties: {
          baslik: { type: "string" },
          aksiyon: { type: "string", description: "Somut olarak ne yapılacağı" },
          hedef: {
            type: "string",
            description:
              "Ürün hedefliyse bağlamdaki stockCode değerini değiştirmeden ürün adıyla birlikte içeren hedef; örnek: M-42 – Örnek Ürün, Ana Depo",
          },
          gerekce: { type: "string", description: "En az iki veriyi ilişkilendiren karar gerekçesi" },
          sorumlu_birim: { type: "string" },
          zaman_ufku: { type: "string" },
          beklenen_etki: { type: "string" },
          takip_metrigi: { type: "string" },
          kanitlar: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "string",
              description:
                "JSON alan adı içermeyen, Türkçe iş etiketi ve birimiyle yazılmış kısa sayısal kanıt. Ürün bazlı kanıttaki ERP kodu hedef alanında da bulunmalı; hedefteki her ürün için en az bir kanıt verilmeli. Örnek: Stok (M-42): 24 birim",
            },
          },
          oncelik: { type: "integer", minimum: 1, maximum: 4 },
        },
      },
    },
  },
} as const;

function round(value: number, digits = 0): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function ratio(current: number, previous: number): number | null {
  return previous === 0 ? null : current / previous - 1;
}

function percent(value: number | null, digits = 2): number | null {
  return value === null ? null : round(value * 100, digits);
}

function selectRelevantProducts(
  analytics: DashboardAnalytics,
  scopeRisks: RiskItem[],
): ProductAnalysis[] {
  const selected = new Map<string, ProductAnalysis>();
  const add = (products: ProductAnalysis[]) => {
    for (const product of products) selected.set(product.id, product);
  };

  const scopeRiskKeys = new Set(
    scopeRisks.map((risk) => `${risk.stockCode}\u001f${risk.warehouse}`),
  );
  add(
    analytics.products.filter((product) =>
      scopeRiskKeys.has(`${product.stockCode}\u001f${product.warehouse}`),
    ),
  );
  add(analytics.products.slice(0, 8));
  add(
    analytics.products
      .filter((product) => product.latest.inventoryStatus !== "NORMAL")
      .sort((a, b) => b.totals.revenue - a.totals.revenue)
      .slice(0, 8),
  );
  add(
    analytics.products
      .slice()
      .sort((a, b) => {
        const score = (product: ProductAnalysis) =>
          Math.abs(product.changes.salesRatio ?? 0) +
          Math.abs(product.changes.costRatio ?? 0) +
          Math.abs((product.changes.marginPoints ?? 0) / 100);
        return score(b) - score(a);
      })
      .slice(0, 8),
  );

  return [...selected.values()].slice(0, 20);
}

function buildRequiredActionDomains(risks: RiskItem[]) {
  const definitions: Array<{
    id: "SUPPLY_CONTINUITY" | "INVENTORY_EFFICIENCY" | "PROFITABILITY_CONTROL";
    label: string;
    riskTypes: RiskItem["type"][];
  }> = [
    {
      id: "SUPPLY_CONTINUITY",
      label: "Arz sürekliliği ve kritik stok",
      riskTypes: ["CRITICAL_STOCK", "LOW_STOCK"],
    },
    {
      id: "INVENTORY_EFFICIENCY",
      label: "Fazla ve yavaş hareket eden stok",
      riskTypes: ["SLOW_MOVING"],
    },
    {
      id: "PROFITABILITY_CONTROL",
      label: "Maliyet, fiyat ve marj kontrolü",
      riskTypes: ["COST_SPIKE", "MARGIN_DROP", "LOW_MARGIN"],
    },
  ];

  return definitions.flatMap((definition) => {
    const domainRisks = risks.filter((risk) => definition.riskTypes.includes(risk.type));
    if (!domainRisks.length) return [];
    const affectedProducts = new Map<string, {
      stockCode: string;
      productName: string;
      warehouse: string;
    }>();
    for (const risk of domainRisks) {
      const key = `${risk.stockCode}\u001f${risk.warehouse}`;
      affectedProducts.set(key, {
        stockCode: risk.stockCode,
        productName: risk.productName,
        warehouse: risk.warehouse,
      });
    }
    return [{
      id: definition.id,
      label: definition.label,
      signalCount: domainRisks.length,
      criticalSignalCount: domainRisks.filter((risk) => risk.severity === "critical").length,
      riskTypes: [...new Set(domainRisks.map((risk) => risk.type))],
      affectedProducts: [...affectedProducts.values()],
    }];
  });
}

export function buildAiContext(
  analytics: DashboardAnalytics,
  ingestion: Pick<
    IngestionResult<ErpRow>,
    "inclusionRate" | "counts" | "audit" | "encoding" | "rows"
  >,
): string {
  const visibleTrend =
    analytics.selectedScope === "ALL"
      ? analytics.trend
      : analytics.trend.filter((item) => item.period <= analytics.activePeriod);
  const firstMetric = visibleTrend[0] ?? null;
  const latestMetric = visibleTrend.at(-1) ?? null;
  const previousMetric = visibleTrend.at(-2) ?? null;
  const bestRevenuePeriod = visibleTrend.reduce(
    (best, item) => (!best || item.revenue > best.revenue ? item : best),
    visibleTrend[0],
  );
  const weakestRevenuePeriod = visibleTrend.reduce(
    (weakest, item) => (!weakest || item.revenue < weakest.revenue ? item : weakest),
    visibleTrend[0],
  );
  const bestMarginPeriod = visibleTrend.reduce(
    (best, item) => (!best || item.margin > best.margin ? item : best),
    visibleTrend[0],
  );
  const weakestMarginPeriod = visibleTrend.reduce(
    (weakest, item) => (!weakest || item.margin < weakest.margin ? item : weakest),
    visibleTrend[0],
  );
  const averageRevenue = visibleTrend.length
    ? visibleTrend.reduce((sum, item) => sum + item.revenue, 0) / visibleTrend.length
    : 0;
  const revenueVariation =
    averageRevenue > 0
      ? Math.sqrt(
          visibleTrend.reduce(
            (sum, item) => sum + (item.revenue - averageRevenue) ** 2,
            0,
          ) / visibleTrend.length,
        ) / averageRevenue
      : 0;

  const scopeRisks = analytics.risks;
  const requiredActionDomains = buildRequiredActionDomains(scopeRisks);
  const relevantProducts = selectRelevantProducts(analytics, scopeRisks);
  const topThreeRevenue = analytics.products
    .slice(0, 3)
    .reduce((sum, product) => sum + product.totals.revenue, 0);
  const inventoryStatusCounts = analytics.products.reduce<Record<string, number>>(
    (counts, product) => {
      counts[product.latest.inventoryStatus] =
        (counts[product.latest.inventoryStatus] ?? 0) + 1;
      return counts;
    },
    {},
  );

  const estimatedRows = ingestion.rows.filter(
    (row) => row.__estimatedFields && row.__estimatedFields.length > 0,
  );
  const estimatedRowsInReportScope = estimatedRows.filter(
    (row) => analytics.selectedScope === "ALL" || row.donem === analytics.activePeriod,
  );
  const estimatedFinancialImpact = estimatedRowsInReportScope.reduce(
    (impact, row) => {
      if (
        !row.__estimatedFields?.some((field) =>
          ["cikis_miktar", "birim_maliyet_tl", "birim_satis_tl"].includes(field),
        ) ||
        row.cikis_miktar === null ||
        row.birim_maliyet_tl === null ||
        row.birim_satis_tl === null
      ) {
        return impact;
      }
      const revenue = row.cikis_miktar * row.birim_satis_tl;
      const cogs = row.cikis_miktar * row.birim_maliyet_tl;
      impact.revenue += revenue;
      impact.grossProfit += revenue - cogs;
      return impact;
    },
    { revenue: 0, grossProfit: 0 },
  );

  const safeContext = {
    contextVersion: "3.0",
    reportScope:
      analytics.selectedScope === "ALL"
        ? {
            type: "MULTI_PERIOD",
            startPeriod: analytics.periods[0],
            endPeriod: analytics.activePeriod,
            periodCount: analytics.periods.length,
            flowMetricsDefinition:
              "Ciro, satış, satış maliyeti ve brüt kâr başlangıç-bitiş aralığının kümülatif toplamıdır.",
            stockMetricDefinition:
              "Stok yalnız bitiş döneminin dönem sonu fotoğrafıdır; aylar boyunca toplanmamıştır.",
            stockRiskDefinition:
              "Stok kapsamı ve yavaş hareket, aralıktaki geçerli gözlemlerin ortalama aylık satış hızı ile bitiş dönemi stok fotoğrafından hesaplanır.",
            changeRiskDefinition:
              "Maliyet artışı ve marj daralması başlangıç dönemi ile bitiş dönemi karşılaştırmasıdır.",
          }
        : {
            type: "SINGLE_PERIOD",
            selectedPeriod: analytics.activePeriod,
            comparisonHistoryStart: visibleTrend[0]?.period,
            comparisonHistoryPeriodCount: visibleTrend.length,
            flowMetricsDefinition: "Akış metrikleri yalnız seçili döneme aittir.",
            stockMetricDefinition: "Stok seçili dönemin dönem sonu fotoğrafıdır.",
            stockRiskDefinition:
              "Stok kapsamı ve yavaş hareket yalnız seçili dönemin satış miktarı ile seçili dönem kapanış stokundan hesaplanır.",
            changeRiskDefinition:
              "Maliyet sıçraması ve marj daralması yalnız seçili dönem ile gerçek takvimdeki bir önceki bitişik dönem karşılaştırmasıdır.",
          },
    totals: {
      revenueTl: round(analytics.totals.revenue),
      costOfGoodsSoldTl: round(analytics.totals.cogs),
      grossProfitTl: round(analytics.totals.grossProfit),
      weightedMarginPercent: percent(analytics.totals.weightedMargin),
      stockUnitsAtSnapshot: analytics.totals.stock,
      salesQuantity: analytics.totals.salesQuantity,
    },
    performance: {
      rangeStartToEnd:
        firstMetric && latestMetric
          ? {
              startPeriod: firstMetric.period,
              endPeriod: latestMetric.period,
              revenueChangePercent: percent(ratio(latestMetric.revenue, firstMetric.revenue)),
              grossProfitChangePercent: percent(
                ratio(latestMetric.grossProfit, firstMetric.grossProfit),
              ),
              marginChangePoints: round((latestMetric.margin - firstMetric.margin) * 100, 2),
              stockChangePercent: percent(ratio(latestMetric.stock, firstMetric.stock)),
            }
          : null,
      latestVsPrevious:
        previousMetric && latestMetric
          ? {
              previousPeriod: previousMetric.period,
              latestPeriod: latestMetric.period,
              revenueChangePercent: percent(
                ratio(latestMetric.revenue, previousMetric.revenue),
              ),
              grossProfitChangePercent: percent(
                ratio(latestMetric.grossProfit, previousMetric.grossProfit),
              ),
              marginChangePoints: round(
                (latestMetric.margin - previousMetric.margin) * 100,
                2,
              ),
              stockChangePercent: percent(ratio(latestMetric.stock, previousMetric.stock)),
            }
          : null,
      bestRevenuePeriod: bestRevenuePeriod
        ? { period: bestRevenuePeriod.period, revenueTl: round(bestRevenuePeriod.revenue) }
        : null,
      weakestRevenuePeriod: weakestRevenuePeriod
        ? { period: weakestRevenuePeriod.period, revenueTl: round(weakestRevenuePeriod.revenue) }
        : null,
      bestMarginPeriod: bestMarginPeriod
        ? { period: bestMarginPeriod.period, marginPercent: percent(bestMarginPeriod.margin) }
        : null,
      weakestMarginPeriod: weakestMarginPeriod
        ? { period: weakestMarginPeriod.period, marginPercent: percent(weakestMarginPeriod.margin) }
        : null,
      revenueVariationPercent: percent(revenueVariation),
    },
    monthlyTrend: visibleTrend.map((item) => ({
      period: item.period,
      revenueTl: round(item.revenue),
      grossProfitTl: round(item.grossProfit),
      marginPercent: percent(item.margin),
      salesQuantity: item.salesQuantity,
      stockUnits: item.stock,
    })),
    categories: analytics.categories.slice(0, 10).map((item) => ({
      category: item.category,
      revenueTl: round(item.revenue),
      revenueSharePercent:
        analytics.totals.revenue > 0
          ? round((item.revenue / analytics.totals.revenue) * 100, 2)
          : 0,
      grossProfitTl: round(item.grossProfit),
      marginPercent: item.revenue > 0 ? round((item.grossProfit / item.revenue) * 100, 2) : 0,
    })),
    portfolio: {
      productWarehouseCount: analytics.products.length,
      topThreeRevenueSharePercent:
        analytics.totals.revenue > 0
          ? round((topThreeRevenue / analytics.totals.revenue) * 100, 2)
          : 0,
      inventoryStatusCounts,
      scopeRuleSignalCount: scopeRisks.length,
      includedRuleSignalCount: Math.min(scopeRisks.length, 30),
      scopeRuleSignalTypes: scopeRisks.reduce<Record<string, number>>((counts, risk) => {
        counts[risk.type] = (counts[risk.type] ?? 0) + 1;
        return counts;
      }, {}),
    },
    requiredActionDomains,
    relevantProducts: relevantProducts.map((product) => ({
      stockCode: product.stockCode,
      productName: product.productName,
      category: product.category,
      warehouse: product.warehouse,
      totals: {
        revenueTl: round(product.totals.revenue),
        grossProfitTl: round(product.totals.grossProfit),
        marginPercent: percent(product.totals.weightedMargin),
        inputQuantity: product.totals.inputQuantity,
        salesQuantity: product.totals.salesQuantity,
      },
      latestSnapshot: {
        period: product.latest.period,
        stockUnits: product.latest.stock,
        coverageMonths: product.latest.coverageMonths === null
          ? null
          : round(product.latest.coverageMonths, 2),
        coverageBasis: product.latest.coverageBasis,
        coveragePeriodCount: product.latest.coveragePeriodCount,
        inventoryStatus: product.latest.inventoryStatus,
        unitCostTl: product.latest.unitCost,
        unitPriceTl: product.latest.unitPrice,
        marginPercent: percent(product.latest.margin),
      },
      scopeChanges: {
        comparisonBasis: analytics.selectedScope === "ALL"
          ? "FIRST_TO_LAST"
          : "PREVIOUS_TO_SELECTED",
        salesPercent: percent(product.changes.salesRatio),
        costPercent: percent(product.changes.costRatio),
        marginPoints: product.changes.marginPoints === null
          ? null
          : round(product.changes.marginPoints, 2),
        stockPercent: percent(product.changes.stockRatio),
      },
      scopeRuleSignals: scopeRisks
        .filter(
          (risk) =>
            risk.stockCode === product.stockCode && risk.warehouse === product.warehouse,
        )
        .map((risk) => ({ type: risk.type, severity: risk.severity, metric: round(risk.metric, 3) })),
    })),
    ruleSignals: scopeRisks.slice(0, 30).map((risk) => ({
      stockCode: risk.stockCode,
      productName: risk.productName,
      warehouse: risk.warehouse,
      type: risk.type,
      title: risk.title,
      severity: risk.severity,
      basis: risk.basis,
      startPeriod: risk.startPeriod,
      endPeriod: risk.period,
      observedPeriodCount: risk.observedPeriodCount,
      metric: round(risk.metric, 3),
      evidence: risk.detail,
    })),
    dataQuality: {
      inclusionRatePercent: ingestion.inclusionRate,
      usedRows: ingestion.counts.used,
      quarantinedRows: ingestion.counts.quarantined,
      warningCount: ingestion.audit.summary.warnings,
      estimatedRowCountInReportScope: estimatedRowsInReportScope.length,
      estimatedFieldsInReportScope: [
        ...new Set(estimatedRowsInReportScope.flatMap((row) => row.__estimatedFields ?? [])),
      ],
      estimatedFinancialImpact: {
        revenueTl: round(estimatedFinancialImpact.revenue),
        grossProfitTl: round(estimatedFinancialImpact.grossProfit),
      },
      encoding: ingestion.encoding.encoding,
    },
  };

  return JSON.stringify(safeContext);
}

export function parseAiReport(value: string): AiReport {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new Error("Model geçerli JSON döndürmedi.");
  }
  const parsed = aiReportSchema.safeParse(json);
  if (!parsed.success) throw new Error("Model cevabı beklenen rapor şemasına uymuyor.");
  return parsed.data;
}

export function validateAiReportForContext(report: AiReport, contextValue: string): AiReport {
  let context: unknown;
  try {
    context = JSON.parse(contextValue);
  } catch {
    throw new Error("AI bağlamı geçerli JSON değil.");
  }
  const requiredDomains = typeof context === "object" && context !== null &&
    "requiredActionDomains" in context && Array.isArray(context.requiredActionDomains)
      ? context.requiredActionDomains.length
      : 0;
  const minimumActionCount = Math.max(2, Math.min(4, requiredDomains));
  if (report.aksiyon_onerileri.length < minimumActionCount) {
    throw new Error("Model zorunlu karar alanlarının tamamı için aksiyon üretmedi.");
  }
  return report;
}
