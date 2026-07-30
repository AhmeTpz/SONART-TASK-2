import { periodIndex } from "@/lib/data-pipeline";
import type {
  CategoryMetric,
  DashboardAnalytics,
  ErpRow,
  IngestionResult,
  PeriodMetric,
  ProductAnalysis,
  ReportProfile,
  RiskItem,
} from "@/lib/types";

function finite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rowFinancials(row: ErpRow): {
  revenue: number;
  cogs: number;
  grossProfit: number;
  salesQuantity: number;
} | null {
  if (
    !finite(row.cikis_miktar) ||
    !finite(row.birim_satis_tl) ||
    !finite(row.birim_maliyet_tl)
  ) {
    return null;
  }
  const revenue = row.cikis_miktar * row.birim_satis_tl;
  const cogs = row.cikis_miktar * row.birim_maliyet_tl;
  return {
    revenue,
    cogs,
    grossProfit: revenue - cogs,
    salesQuantity: row.cikis_miktar,
  };
}

function aggregate(rows: ErpRow[]): DashboardAnalytics["totals"] {
  let revenue = 0;
  let cogs = 0;
  let grossProfit = 0;
  let salesQuantity = 0;
  let stock = 0;
  for (const row of rows) {
    const financials = rowFinancials(row);
    if (financials) {
      revenue += financials.revenue;
      cogs += financials.cogs;
      grossProfit += financials.grossProfit;
      salesQuantity += financials.salesQuantity;
    }
    if (finite(row.donem_sonu_stok)) stock += row.donem_sonu_stok;
  }
  return {
    revenue,
    cogs,
    grossProfit,
    weightedMargin: revenue > 0 ? grossProfit / revenue : 0,
    stock,
    salesQuantity,
  };
}

function buildTrend(rows: ErpRow[], periods: string[]): PeriodMetric[] {
  return periods.map((period) => {
    const total = aggregate(rows.filter((row) => row.donem === period));
    return {
      period,
      revenue: total.revenue,
      grossProfit: total.grossProfit,
      margin: total.weightedMargin,
      stock: total.stock,
      salesQuantity: total.salesQuantity,
    };
  });
}

function buildCategories(rows: ErpRow[]): CategoryMetric[] {
  const grouped = new Map<string, CategoryMetric>();
  for (const row of rows) {
    const values = rowFinancials(row);
    if (!values) continue;
    const current = grouped.get(row.kategori) ?? {
      category: row.kategori,
      revenue: 0,
      grossProfit: 0,
    };
    current.revenue += values.revenue;
    current.grossProfit += values.grossProfit;
    grouped.set(row.kategori, current);
  }
  return [...grouped.values()].sort((a, b) => b.revenue - a.revenue);
}

function rowMargin(row: ErpRow): number | null {
  if (!finite(row.birim_satis_tl) || row.birim_satis_tl <= 0 || !finite(row.birim_maliyet_tl)) {
    return null;
  }
  return (row.birim_satis_tl - row.birim_maliyet_tl) / row.birim_satis_tl;
}

function changeRatio(current: number | null, previous: number | null): number | null {
  if (!finite(current) || !finite(previous) || previous === 0) return null;
  return current / previous - 1;
}

function averageSales(rows: ErpRow[]): { value: number; periodCount: number } {
  const values = rows.map((row) => row.cikis_miktar).filter(finite);
  return {
    value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
    periodCount: values.length,
  };
}

function buildProducts(
  rows: ErpRow[],
  periods: string[],
  activePeriod: string,
  scope: "ALL" | string,
  profile: ReportProfile<ErpRow>,
): ProductAnalysis[] {
  if (!activePeriod) return [];

  const grouped = new Map<string, ErpRow[]>();
  for (const row of rows) {
    const key = `${row.stok_kodu}\u001f${row.depo}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const products: ProductAnalysis[] = [];
  for (const [id, rawGroup] of grouped) {
    const group = rawGroup
      .filter((row) => periodIndex(row.donem) <= periodIndex(activePeriod))
      .sort((a, b) => periodIndex(a.donem) - periodIndex(b.donem));
    if (!group.length) continue;

    const scopeRows = scope === "ALL" ? group : group.filter((row) => row.donem === scope);
    if (!scopeRows.length) continue;

    const latestObserved = group.at(-1)!;
    const currentSnapshot = latestObserved.donem === activePeriod ? latestObserved : null;
    const latest = currentSnapshot ?? latestObserved;
    const previous = currentSnapshot ? group.at(-2) ?? null : null;
    const previousIsAdjacent = currentSnapshot && previous
      ? periodIndex(currentSnapshot.donem) - periodIndex(previous.donem) === 1
      : false;
    const comparisonRow = scope === "ALL"
      ? scopeRows.find((row) => row.donem === periods[0]) ?? null
      : previousIsAdjacent
        ? previous
        : null;
    const hasComparison = Boolean(
      currentSnapshot &&
      comparisonRow &&
      comparisonRow !== currentSnapshot,
    );
    const totals = aggregate(scopeRows);
    const inputQuantity = scopeRows.reduce(
      (sum, row) => sum + (finite(row.giris_miktar) ? row.giris_miktar : 0),
      0,
    );
    const salesVelocity = averageSales(scopeRows);
    const coverageMonths = currentSnapshot &&
      finite(currentSnapshot.donem_sonu_stok) && salesVelocity.value > 0
        ? currentSnapshot.donem_sonu_stok / salesVelocity.value
        : currentSnapshot?.donem_sonu_stok === 0
          ? 0
          : null;
    const inventoryStatus =
      currentSnapshot?.donem_sonu_stok === 0 ||
      (coverageMonths !== null && coverageMonths < profile.riskThresholds.criticalCoverageMonths)
        ? "CRITICAL"
        : coverageMonths !== null && coverageMonths > profile.riskThresholds.slowCoverageMonths
          ? "SLOW"
          : currentSnapshot && finite(currentSnapshot.donem_sonu_stok) && currentSnapshot.donem_sonu_stok > 0 && salesVelocity.value === 0
            ? "NO_SALES"
            : coverageMonths !== null
              ? "NORMAL"
              : "UNKNOWN";
    const latestMargin = currentSnapshot ? rowMargin(currentSnapshot) : null;
    const comparisonMargin = comparisonRow ? rowMargin(comparisonRow) : null;

    products.push({
      id,
      stockCode: latest.stok_kodu,
      productName: latest.urun_adi,
      category: latest.kategori,
      warehouse: latest.depo,
      trend: group.map((row) => {
        const financials = rowFinancials(row);
        return {
          period: row.donem,
          inputQuantity: row.giris_miktar,
          salesQuantity: row.cikis_miktar,
          stock: row.donem_sonu_stok,
          unitCost: row.birim_maliyet_tl,
          unitPrice: row.birim_satis_tl,
          revenue: financials?.revenue ?? 0,
          grossProfit: financials?.grossProfit ?? 0,
          margin: rowMargin(row),
        };
      }),
      totals: {
        revenue: totals.revenue,
        cogs: totals.cogs,
        grossProfit: totals.grossProfit,
        weightedMargin: totals.weightedMargin,
        inputQuantity,
        salesQuantity: totals.salesQuantity,
      },
      latest: {
        period: latest.donem,
        stock: currentSnapshot?.donem_sonu_stok ?? null,
        unitCost: currentSnapshot?.birim_maliyet_tl ?? null,
        unitPrice: currentSnapshot?.birim_satis_tl ?? null,
        margin: latestMargin,
        coverageMonths,
        coverageBasis: scope === "ALL"
          ? "RANGE_AVERAGE_MONTHLY_SALES"
          : "SELECTED_PERIOD_SALES",
        coveragePeriodCount: salesVelocity.periodCount,
        inventoryStatus,
      },
      changes: {
        salesRatio: hasComparison
          ? changeRatio(latest.cikis_miktar, comparisonRow?.cikis_miktar ?? null)
          : null,
        costRatio: hasComparison
          ? changeRatio(latest.birim_maliyet_tl, comparisonRow?.birim_maliyet_tl ?? null)
          : null,
        marginPoints:
          hasComparison && latestMargin !== null && comparisonMargin !== null
            ? (latestMargin - comparisonMargin) * 100
            : null,
        stockRatio: hasComparison
          ? changeRatio(latest.donem_sonu_stok, comparisonRow?.donem_sonu_stok ?? null)
          : null,
      },
    });
  }

  return products.sort(
    (a, b) =>
      b.totals.revenue - a.totals.revenue ||
      a.stockCode.localeCompare(b.stockCode, "tr-TR"),
  );
}

function riskSeverity(type: RiskItem["type"]): RiskItem["severity"] {
  if (type === "CRITICAL_STOCK" || type === "COST_SPIKE") return "critical";
  if (type === "MARGIN_DROP" || type === "LOW_MARGIN") return "high";
  return "medium";
}

function formatCoverage(value: number, digits: number): string {
  return value.toLocaleString("tr-TR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function buildRisks(
  rows: ErpRow[],
  periods: string[],
  scope: "ALL" | string,
  profile: ReportProfile<ErpRow>,
): RiskItem[] {
  const activePeriod = scope === "ALL" ? periods.at(-1) ?? "" : scope;
  if (!activePeriod) return [];
  const byProductWarehouse = new Map<string, ErpRow[]>();
  for (const row of rows) {
    const key = `${row.stok_kodu}\u001f${row.depo}`;
    const group = byProductWarehouse.get(key) ?? [];
    group.push(row);
    byProductWarehouse.set(key, group);
  }
  for (const group of byProductWarehouse.values()) {
    group.sort((a, b) => periodIndex(a.donem) - periodIndex(b.donem));
  }

  const risks: RiskItem[] = [];
  const thresholds = profile.riskThresholds;
  const pushRisk = (
    row: ErpRow,
    startPeriod: string,
    observedPeriodCount: number,
    type: RiskItem["type"],
    title: string,
    detail: string,
    metric: number,
  ) => {
    risks.push({
      id: `${type}-${row.stok_kodu}-${row.depo}-${scope === "ALL" ? "ALL" : row.donem}`,
      type,
      severity: riskSeverity(type),
      basis: scope === "ALL" ? "MULTI_PERIOD" : "SINGLE_PERIOD",
      stockCode: row.stok_kodu,
      productName: row.urun_adi,
      warehouse: row.depo,
      startPeriod,
      period: row.donem,
      observedPeriodCount,
      title,
      detail,
      metric,
    });
  };

  for (const group of byProductWarehouse.values()) {
    const visibleRows = group.filter(
      (row) => periodIndex(row.donem) <= periodIndex(activePeriod),
    );
    if (!visibleRows.length) continue;
    const row = scope === "ALL"
      ? visibleRows.at(-1)!
      : visibleRows.find((candidate) => candidate.donem === scope);
    if (!row || row.donem !== activePeriod) continue;

    const currentIndex = visibleRows.findIndex((candidate) => candidate === row);
    const previous = currentIndex > 0 ? visibleRows[currentIndex - 1] : null;
    const previousIsAdjacent = Boolean(
      previous && periodIndex(row.donem) - periodIndex(previous.donem) === 1,
    );
    const comparisonRow = scope === "ALL"
      ? visibleRows.find((candidate) => candidate.donem === periods[0]) ?? null
      : previousIsAdjacent
        ? previous
        : null;
    const hasComparison = Boolean(comparisonRow && comparisonRow !== row);
    const scopeRows = scope === "ALL" ? visibleRows : [row];
    const salesVelocity = averageSales(scopeRows);
    const startPeriod = scope === "ALL" ? periods[0] : row.donem;
    const observedPeriodCount = scope === "ALL" ? visibleRows.length : 1;
    const salesBasisLabel = scope === "ALL"
      ? "Tüm dönemlerdeki geçerli aylık kayıtların ortalama"
      : "Seçili dönem";
    const coverage =
      finite(row.donem_sonu_stok) && salesVelocity.value > 0
        ? row.donem_sonu_stok / salesVelocity.value
        : row.donem_sonu_stok === 0
          ? 0
          : null;

    const hasCriticalCoverage =
      row.donem_sonu_stok === 0 ||
      (coverage !== null && coverage < thresholds.criticalCoverageMonths);

    if (hasCriticalCoverage) {
      pushRisk(
        row,
        startPeriod,
        observedPeriodCount,
        "CRITICAL_STOCK",
        "Kritik stok kapsamı",
        coverage === null
          ? "Stok sıfırlandı."
          : `${salesBasisLabel} satış hızına göre ${formatCoverage(coverage, 2)} aylık stok kaldı.`,
        coverage ?? 0,
      );
    } else if (coverage !== null && coverage > thresholds.slowCoverageMonths) {
      pushRisk(
        row,
        startPeriod,
        observedPeriodCount,
        "SLOW_MOVING",
        "Yavaş hareket eden stok",
        `${salesBasisLabel} satış hızına göre ${formatCoverage(coverage, 1)} aylık stok kapsamı bulunuyor.`,
        coverage,
      );
    } else if (finite(row.donem_sonu_stok) && row.donem_sonu_stok > 0 && salesVelocity.value === 0) {
      pushRisk(
        row,
        startPeriod,
        observedPeriodCount,
        "SLOW_MOVING",
        "Hareketsiz stok",
        `${scope === "ALL" ? "Tüm dönemlerdeki geçerli aylık kayıtlarda" : "Seçili dönemde"} satış yok; ${row.donem_sonu_stok.toLocaleString("tr-TR")} birim stok bulunuyor.`,
        row.donem_sonu_stok,
      );
    } else if (
      coverage === null &&
      finite(row.donem_sonu_stok) &&
      row.donem_sonu_stok > 0 &&
      row.donem_sonu_stok < thresholds.lowStockUnits
    ) {
      pushRisk(
        row,
        startPeriod,
        observedPeriodCount,
        "LOW_STOCK",
        "Düşük stok seviyesi",
        `Satış hızıyla stok kapsamı hesaplanamadı; dönem sonu stok ${row.donem_sonu_stok.toLocaleString("tr-TR")} birim.`,
        row.donem_sonu_stok,
      );
    }

    const scopeTotals = aggregate(scopeRows);
    const currentMargin = rowMargin(row);
    const margin = scope === "ALL"
      ? scopeTotals.revenue > 0
        ? scopeTotals.weightedMargin
        : null
      : currentMargin;
    if (margin !== null) {
      if (margin < thresholds.lowMarginRatio) {
        pushRisk(
          row,
          startPeriod,
          observedPeriodCount,
          "LOW_MARGIN",
          "Düşük ürün marjı",
          scope === "ALL"
            ? `Tüm dönemlerin ciro ağırlıklı ürün marjı %${(margin * 100).toFixed(1)} seviyesinde.`
            : `Birim brüt marj %${(margin * 100).toFixed(1)} seviyesinde.`,
          margin,
        );
      }

      if (
        hasComparison &&
        comparisonRow &&
        currentMargin !== null
      ) {
        const comparisonMargin = rowMargin(comparisonRow);
        const dropPoints = comparisonMargin === null
          ? null
          : (comparisonMargin - currentMargin) * 100;
        if (dropPoints !== null && dropPoints >= thresholds.marginDropPoints) {
          pushRisk(
            row,
            startPeriod,
            observedPeriodCount,
            "MARGIN_DROP",
            "Marj daralması",
            scope === "ALL"
              ? `Birim marj ilk dönemden son döneme ${dropPoints.toFixed(1)} yüzde puan geriledi.`
              : `Önceki döneme göre ${dropPoints.toFixed(1)} yüzde puan geriledi.`,
            dropPoints,
          );
        }
        const costJump =
          finite(comparisonRow.birim_maliyet_tl) &&
          comparisonRow.birim_maliyet_tl > 0 &&
          finite(row.birim_maliyet_tl)
            ? row.birim_maliyet_tl / comparisonRow.birim_maliyet_tl - 1
            : null;
        if (costJump !== null && costJump >= thresholds.costJumpRatio) {
          pushRisk(
            row,
            startPeriod,
            observedPeriodCount,
            "COST_SPIKE",
            scope === "ALL" ? "Maliyet artışı" : "Maliyet sıçraması",
            scope === "ALL"
              ? `Birim maliyet ilk dönemden son döneme %${(costJump * 100).toFixed(1)} arttı.`
              : `Birim maliyet önceki döneme göre %${(costJump * 100).toFixed(1)} arttı.`,
            costJump,
          );
        }
      }
    }
  }

  const severityRank = { critical: 0, high: 1, medium: 2 };
  return risks.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      periodIndex(b.period) - periodIndex(a.period) ||
      a.stockCode.localeCompare(b.stockCode, "tr-TR"),
  );
}

export function buildDashboardAnalytics(
  ingestion: Pick<IngestionResult<ErpRow>, "rows" | "periods">,
  profile: ReportProfile<ErpRow>,
  scope: "ALL" | string,
): DashboardAnalytics {
  if (scope !== "ALL" && !ingestion.periods.includes(scope)) {
    throw new Error(`Geçersiz dönem kapsamı: ${scope}`);
  }
  const activePeriod = scope === "ALL" ? ingestion.periods.at(-1) ?? "" : scope;
  const flowRows =
    scope === "ALL"
      ? ingestion.rows
      : ingestion.rows.filter((row) => row.donem === scope);
  const stockRows = ingestion.rows.filter((row) => row.donem === activePeriod);
  const flowTotals = aggregate(flowRows);
  const stockTotal = aggregate(stockRows).stock;

  return {
    selectedScope: scope,
    periods: ingestion.periods,
    activePeriod,
    totals: { ...flowTotals, stock: stockTotal },
    trend: buildTrend(ingestion.rows, ingestion.periods),
    categories: buildCategories(flowRows),
    products: buildProducts(ingestion.rows, ingestion.periods, activePeriod, scope, profile),
    risks: buildRisks(
      ingestion.rows,
      ingestion.periods,
      scope,
      profile,
    ),
  };
}
