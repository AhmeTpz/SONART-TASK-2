"use client";

import {
  ArrowDownRight,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  CircleGauge,
  PackageSearch,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCurrency, formatNumber, formatPercent, formatPeriod } from "@/lib/format";
import type { DashboardAnalytics, ProductAnalysis } from "@/lib/types";

const COMPACT_PRODUCT_ROWS = 2;
const collator = new Intl.Collator("tr-TR", { numeric: true, sensitivity: "base" });
const profitSeriesOrder: Record<string, number> = { unitPrice: 0, unitCost: 1, margin: 2 };

type ProductSortKey = "product" | "category" | "revenue" | "sales" | "stock" | "coverage" | "margin" | "salesChange";
type SortDirection = "asc" | "desc";

interface ProductSortState {
  key: ProductSortKey | null;
  direction: SortDirection;
}

interface ProductAnalysisSectionProps {
  analytics: DashboardAnalytics;
  selectedProductId: string;
  onSelectedProductChange: (productId: string) => void;
}

function productSortValue(product: ProductAnalysis, key: ProductSortKey): string | number | null {
  switch (key) {
    case "product": return `${product.stockCode}\u001f${product.productName}`;
    case "category": return `${product.category}\u001f${product.warehouse}`;
    case "revenue": return product.totals.revenue;
    case "sales": return product.totals.salesQuantity;
    case "stock": return product.latest.stock;
    case "coverage": return product.latest.coverageMonths;
    case "margin": return product.totals.weightedMargin;
    case "salesChange": return product.changes.salesRatio;
  }
}

function compareValues(left: string | number | null, right: string | number | null, direction: SortDirection): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const result = typeof left === "number" && typeof right === "number"
    ? left - right
    : collator.compare(String(left), String(right));
  return direction === "asc" ? result : -result;
}

function ProductSortHeader({ label, sortKey, sort, onSort }: { label: string; sortKey: ProductSortKey; sort: ProductSortState; onSort: (key: ProductSortKey) => void }) {
  const active = sort.key === sortKey;
  const Icon = !active ? ChevronsUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
      <button className="sortable-column" type="button" onClick={() => onSort(sortKey)}>
        {label}<Icon />
      </button>
    </th>
  );
}

function shortPeriod(period: string): string {
  const [month, year] = formatPeriod(period).split(" ");
  return `${month?.slice(0, 3)} ${year?.slice(-2)}`;
}

function signedPercent(value: number | null): string {
  if (value === null) return "Karşılaştırma yok";
  const sign = value > 0 ? "+" : "";
  return `${sign}%${(value * 100).toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
}

function signedPoints(value: number | null): string {
  if (value === null) return "Karşılaştırma yok";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} puan`;
}

function changeDetail(value: number | null, subject: string, comparisonLabel: string): string {
  if (value === null) return `${subject} için karşılaştırma verisi bulunmuyor.`;
  if (value === 0) return `${subject} ${comparisonLabel} göre değişmedi.`;
  return `${subject} ${comparisonLabel} göre %${Math.abs(value * 100).toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${value > 0 ? "arttı" : "azaldı"}.`;
}

function inventoryInsight(product: ProductAnalysis): { value: string; detail: string; tone: string } {
  const coverage = product.latest.coverageMonths;
  const coverageLabel = coverage === null
    ? "Hesaplanamadı"
    : `${coverage.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ay`;
  const salesBasis = product.latest.coverageBasis === "RANGE_AVERAGE_MONTHLY_SALES"
    ? "İncelenen dönemin ortalama aylık satış hızına"
    : "Seçili dönemin satış hızına";

  switch (product.latest.inventoryStatus) {
    case "CRITICAL":
      return { value: coverageLabel, detail: `${salesBasis} göre stok tükenme riski bulunuyor.`, tone: "critical" };
    case "SLOW":
      return { value: coverageLabel, detail: `${salesBasis} göre stok kapsamı yavaş hareket sınırının üzerinde.`, tone: "warning" };
    case "NO_SALES":
      return { value: "Satış yok", detail: `${salesBasis} temel olacak satış bulunmadığı için stok devir hızı hesaplanamıyor.`, tone: "warning" };
    case "NORMAL":
      return { value: coverageLabel, detail: `${salesBasis} göre stok kapsamı risk sınırları içinde.`, tone: "positive" };
    default:
      return { value: coverageLabel, detail: "Stok kapsamı için yeterli satış veya stok verisi bulunmuyor.", tone: "neutral" };
  }
}

function DirectionIcon({ value }: { value: number | null }) {
  if (value === null || value === 0) return <ArrowRight size={17} />;
  return value > 0 ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />;
}

function metricRatio(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return current / previous - 1;
}

function buildPortfolioOverview(analytics: DashboardAnalytics): ProductAnalysis | null {
  if (!analytics.products.length) return null;

  const byPeriod = new Map<string, {
    inputQuantity: number;
    hasInput: boolean;
    salesQuantity: number;
    hasSales: boolean;
    stock: number;
    hasStock: boolean;
    revenue: number;
    grossProfit: number;
  }>();

  for (const product of analytics.products) {
    for (const item of product.trend) {
      const current = byPeriod.get(item.period) ?? {
        inputQuantity: 0,
        hasInput: false,
        salesQuantity: 0,
        hasSales: false,
        stock: 0,
        hasStock: false,
        revenue: 0,
        grossProfit: 0,
      };
      if (item.inputQuantity !== null) {
        current.inputQuantity += item.inputQuantity;
        current.hasInput = true;
      }
      if (item.salesQuantity !== null) {
        current.salesQuantity += item.salesQuantity;
        current.hasSales = true;
      }
      if (item.stock !== null) {
        current.stock += item.stock;
        current.hasStock = true;
      }
      current.revenue += item.revenue;
      current.grossProfit += item.grossProfit;
      byPeriod.set(item.period, current);
    }
  }

  const trend = analytics.periods
    .filter((period) => byPeriod.has(period))
    .map((period) => {
      const item = byPeriod.get(period)!;
      const cogs = item.revenue - item.grossProfit;
      return {
        period,
        inputQuantity: item.hasInput ? item.inputQuantity : null,
        salesQuantity: item.hasSales ? item.salesQuantity : null,
        stock: item.hasStock ? item.stock : null,
        unitCost: item.salesQuantity > 0 ? cogs / item.salesQuantity : null,
        unitPrice: item.salesQuantity > 0 ? item.revenue / item.salesQuantity : null,
        revenue: item.revenue,
        grossProfit: item.grossProfit,
        margin: item.revenue > 0 ? item.grossProfit / item.revenue : null,
      };
    });
  if (!trend.length) return null;
  const latest = trend.at(-1)!;
  const comparison = analytics.selectedScope === "ALL"
    ? trend[0] ?? null
    : trend.at(-2) ?? null;
  const coverageTrend = analytics.selectedScope === "ALL" ? trend : [latest];
  const observedSales = coverageTrend
    .map((item) => item.salesQuantity)
    .filter((value): value is number => value !== null);
  const averageSales = observedSales.length
    ? observedSales.reduce((sum, value) => sum + value, 0) / observedSales.length
    : 0;
  const coverageMonths = latest.stock !== null && averageSales > 0
    ? latest.stock / averageSales
    : latest.stock === 0
      ? 0
      : null;

  return {
    id: "__ALL_PRODUCTS__",
    stockCode: "TÜMÜ",
    productName: "Tüm ürünler",
    category: "Tüm kategoriler",
    warehouse: "Tüm depolar",
    trend,
    totals: {
      revenue: analytics.totals.revenue,
      cogs: analytics.totals.cogs,
      grossProfit: analytics.totals.grossProfit,
      weightedMargin: analytics.totals.weightedMargin,
      inputQuantity: analytics.products.reduce((sum, product) => sum + product.totals.inputQuantity, 0),
      salesQuantity: analytics.totals.salesQuantity,
    },
    latest: {
      period: latest.period,
      stock: latest.stock,
      unitCost: latest.unitCost,
      unitPrice: latest.unitPrice,
      margin: latest.margin,
      coverageMonths,
      coverageBasis: analytics.selectedScope === "ALL"
        ? "RANGE_AVERAGE_MONTHLY_SALES"
        : "SELECTED_PERIOD_SALES",
      coveragePeriodCount: observedSales.length,
      inventoryStatus: "UNKNOWN",
    },
    changes: {
      salesRatio: metricRatio(latest.salesQuantity, comparison?.salesQuantity ?? null),
      costRatio: metricRatio(latest.unitCost, comparison?.unitCost ?? null),
      marginPoints: latest.margin !== null && comparison !== null && comparison.margin !== null
        ? (latest.margin - comparison.margin) * 100
        : null,
      stockRatio: metricRatio(latest.stock, comparison?.stock ?? null),
    },
  };
}

export function ProductAnalysisSection({ analytics, selectedProductId, onSelectedProductChange }: ProductAnalysisSectionProps) {
  const [showAllProducts, setShowAllProducts] = useState(false);
  const [productSort, setProductSort] = useState<ProductSortState>({ key: null, direction: "asc" });
  const productOptions = useMemo(() => [...analytics.products].sort(
    (left, right) =>
      collator.compare(left.stockCode, right.stockCode) ||
      collator.compare(left.warehouse, right.warehouse) ||
      collator.compare(left.productName, right.productName),
  ), [analytics.products]);
  const portfolioOverview = useMemo(() => buildPortfolioOverview(analytics), [analytics]);
  const selectedProduct = productOptions.find((product) => product.id === selectedProductId) ?? null;
  const selected = selectedProduct ?? portfolioOverview;
  const sortedProducts = useMemo(() => {
    if (!productSort.key) return analytics.products;
    const key = productSort.key;
    return [...analytics.products].sort((left, right) =>
      compareValues(productSortValue(left, key), productSortValue(right, key), productSort.direction) ||
      collator.compare(left.id, right.id),
    );
  }, [analytics.products, productSort]);
  const visibleProducts = showAllProducts ? sortedProducts : sortedProducts.slice(0, COMPACT_PRODUCT_ROWS);
  const changeProductSort = (key: ProductSortKey) => {
    setProductSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };
  if (!selected) return null;

  const isPortfolioOverview = selectedProduct === null;
  const inventory = isPortfolioOverview
    ? (() => {
        const criticalCount = analytics.products.filter((product) => product.latest.inventoryStatus === "CRITICAL").length;
        const slowCount = analytics.products.filter((product) => product.latest.inventoryStatus === "SLOW" || product.latest.inventoryStatus === "NO_SALES").length;
        return {
          value: criticalCount > 0 ? `${criticalCount} kritik` : `${slowCount} izlenecek`,
          detail: `${analytics.products.length} ürün / depo içinde ${criticalCount} kritik, ${slowCount} yavaş veya hareketsiz stok bulunuyor.`,
          tone: criticalCount > 0 ? "critical" : slowCount > 0 ? "warning" : "positive",
        };
      })()
    : inventoryInsight(selected);
  const scopeLabel = analytics.selectedScope === "ALL" ? "Tüm dönemler" : formatPeriod(analytics.selectedScope);
  const comparisonLabel = analytics.selectedScope === "ALL" ? "ilk döneme" : "önceki döneme";

  return (
    <section className="product-analysis" aria-labelledby="product-analysis-title">
      <div className="product-section-heading">
        <div>
          <span className="eyebrow">Ürün detay analizi</span>
          <h2 id="product-analysis-title">Ürün bazında dönemsel analiz</h2>
          <p>Satış, stok, fiyat, maliyet ve marj hareketlerini ürün ve depo kırılımında inceleyin.</p>
        </div>
        <label className="product-selector">
          <span>İncelenen görünüm</span>
          <select value={selectedProduct?.id ?? ""} onChange={(event) => onSelectedProductChange(event.target.value)}>
            <option value="">Tüm ürünler — portföy özeti</option>
            {productOptions.map((product) => (
              <option value={product.id} key={product.id}>
                {product.stockCode} — {product.productName} · {product.warehouse}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="selected-product-heading">
        <div className="product-code-badge">{selected.stockCode}</div>
        <div>
          <h3>{selected.productName}</h3>
          <p>{selected.category} · {selected.warehouse} · {scopeLabel}</p>
        </div>
        <span className="product-period-chip">Son veri: {formatPeriod(selected.latest.period)}</span>
      </div>

      <div className="product-kpi-grid">
        <article><span>Seçili kapsam ciro</span><strong>{formatCurrency(selected.totals.revenue)}</strong><small>{formatNumber(selected.totals.salesQuantity)} birim çıkış</small></article>
        <article><span>Brüt kâr</span><strong>{formatCurrency(selected.totals.grossProfit)}</strong><small>{formatCurrency(selected.totals.cogs)} satış maliyeti</small></article>
        <article><span>Ağırlıklı marj</span><strong>{formatPercent(selected.totals.weightedMargin, 2)}</strong><small>Ciro ağırlıklı ürün marjı</small></article>
        <article><span>Güncel stok</span><strong>{selected.latest.stock === null ? "—" : formatNumber(selected.latest.stock)}</strong><small>{formatPeriod(selected.latest.period)} kapanışı</small></article>
      </div>

      <div className="product-chart-grid">
        <article className="product-chart-card">
          <div className="product-card-heading"><div><span className="eyebrow">Hareket dengesi</span><h3>Aylık giriş, çıkış ve stok</h3></div><PackageSearch size={19} /></div>
          <div className="product-chart-wrap" aria-label={`${selected.stockCode} aylık giriş çıkış ve stok grafiği`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={selected.trend} margin={{ top: 12, right: 8, left: -14, bottom: 2 }}>
                <CartesianGrid stroke="#e8edf4" strokeDasharray="4 4" vertical={false} />
                <XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fill: "#6d7890", fontSize: 10 }} tickFormatter={shortPeriod} />
                <YAxis yAxisId="movement" axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 9 }} tickFormatter={(value) => formatNumber(value, true)} />
                <YAxis yAxisId="stock" orientation="right" axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 9 }} tickFormatter={(value) => formatNumber(value, true)} />
                <Tooltip formatter={(value, name) => [formatNumber(Number(value)), name]} labelFormatter={(label) => formatPeriod(String(label))} contentStyle={{ borderRadius: 10, borderColor: "#e2e8f0", fontSize: 10 }} />
                <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: 10, paddingTop: 10 }} />
                <Bar yAxisId="movement" dataKey="inputQuantity" name="Giriş" fill="#89a7e8" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                <Bar yAxisId="movement" dataKey="salesQuantity" name="Çıkış" fill="#165dff" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                <Line yAxisId="stock" type="monotone" dataKey="stock" name="Stok" stroke="#0c936d" strokeWidth={2.4} dot={{ r: 3, fill: "white", strokeWidth: 2 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="print-only print-chart-data print-product-chart-data">
            <h4>{selected.stockCode} · {selected.productName} — hareket değerleri</h4>
            <table><thead><tr><th>Dönem</th><th>Giriş</th><th>Çıkış</th><th>Dönem sonu stok</th></tr></thead>
              <tbody>{selected.trend.map((item) => <tr key={item.period}><td>{formatPeriod(item.period)}</td><td>{item.inputQuantity === null ? "-" : formatNumber(item.inputQuantity)}</td><td>{item.salesQuantity === null ? "-" : formatNumber(item.salesQuantity)}</td><td>{item.stock === null ? "-" : formatNumber(item.stock)}</td></tr>)}</tbody>
            </table>
          </div>
        </article>

        <article className="product-chart-card">
          <div className="product-card-heading"><div><span className="eyebrow">Kârlılık dinamiği</span><h3>Fiyat, maliyet ve marj</h3></div><TrendingUp size={19} /></div>
          <div className="product-chart-wrap" aria-label={`${selected.stockCode} fiyat maliyet ve marj grafiği`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={selected.trend} margin={{ top: 12, right: 8, left: -14, bottom: 2 }}>
                <CartesianGrid stroke="#e8edf4" strokeDasharray="4 4" vertical={false} />
                <XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fill: "#6d7890", fontSize: 10 }} tickFormatter={shortPeriod} />
                <YAxis yAxisId="money" axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 9 }} tickFormatter={(value) => `₺${formatNumber(value, true)}`} />
                <YAxis yAxisId="margin" orientation="right" domain={[0, 1]} axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 9 }} tickFormatter={(value) => `%${Math.round(Number(value) * 100)}`} />
                <Tooltip itemSorter={(item) => profitSeriesOrder[String(item.dataKey)] ?? 99} formatter={(value, name) => [name === "Marj" ? formatPercent(Number(value), 1) : formatCurrency(Number(value)), name]} labelFormatter={(label) => formatPeriod(String(label))} contentStyle={{ borderRadius: 10, borderColor: "#e2e8f0", fontSize: 10 }} />
                <Line yAxisId="money" type="monotone" dataKey="unitPrice" name="Satış fiyatı" stroke="#165dff" strokeWidth={2.4} dot={{ r: 3 }} isAnimationActive={false} />
                <Line yAxisId="money" type="monotone" dataKey="unitCost" name="Birim maliyet" stroke="#e49b25" strokeWidth={2.4} dot={{ r: 3 }} isAnimationActive={false} />
                <Line yAxisId="margin" type="monotone" dataKey="margin" name="Marj" stroke="#7755d9" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2.5 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="profit-chart-legend" aria-label="Kârlılık grafiği göstergeleri">
            <span><i className="legend-price" />Satış fiyatı</span>
            <span><i className="legend-cost" />Birim maliyet</span>
            <span><i className="legend-margin" />Marj</span>
          </div>
          <div className="print-only print-chart-data print-product-chart-data">
            <h4>{selected.stockCode} · {selected.productName} — kârlılık değerleri</h4>
            <table><thead><tr><th>Dönem</th><th>Satış fiyatı</th><th>Birim maliyet</th><th>Marj</th></tr></thead>
              <tbody>{selected.trend.map((item) => <tr key={item.period}><td>{formatPeriod(item.period)}</td><td>{item.unitPrice === null ? "-" : formatCurrency(item.unitPrice)}</td><td>{item.unitCost === null ? "-" : formatCurrency(item.unitCost)}</td><td>{item.margin === null ? "-" : formatPercent(item.margin, 1)}</td></tr>)}</tbody>
            </table>
          </div>
        </article>
      </div>

      <div className="product-insights">
        <article className={selected.changes.salesRatio !== null && selected.changes.salesRatio < 0 ? "insight-warning" : "insight-positive"}>
          <span><DirectionIcon value={selected.changes.salesRatio} /> Satış değişimi</span><strong>{signedPercent(selected.changes.salesRatio)}</strong><p>{changeDetail(selected.changes.salesRatio, "Çıkış miktarı", comparisonLabel)}</p>
        </article>
        <article className={selected.changes.costRatio !== null && selected.changes.costRatio > 0 ? "insight-warning" : "insight-neutral"}>
          <span><DirectionIcon value={selected.changes.costRatio} /> Maliyet değişimi</span><strong>{signedPercent(selected.changes.costRatio)}</strong><p>{changeDetail(selected.changes.costRatio, "Birim maliyet", comparisonLabel)}</p>
        </article>
        <article className={selected.changes.marginPoints !== null && selected.changes.marginPoints < 0 ? "insight-warning" : "insight-positive"}>
          <span><DirectionIcon value={selected.changes.marginPoints} /> Marj değişimi</span><strong>{signedPoints(selected.changes.marginPoints)}</strong><p>{selected.changes.marginPoints === null ? "Marj için karşılaştırma verisi bulunmuyor." : `Birim marj ${comparisonLabel} göre ${Math.abs(selected.changes.marginPoints).toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} puan ${selected.changes.marginPoints >= 0 ? "genişledi" : "daraldı"}.`}</p>
        </article>
        <article className={`insight-${inventory.tone}`}>
          <span><CircleGauge size={17} /> Stok kapsamı</span><strong>{inventory.value}</strong><p>{inventory.detail}</p>
        </article>
      </div>

      <article className="product-comparison-card">
        <div className="product-comparison-heading"><div><span className="eyebrow">Ürün karşılaştırması</span><h3>{scopeLabel} performans sıralaması</h3></div><span>{analytics.products.length} ürün / depo</span></div>
        <div className="product-table-scroll">
          <table className="product-table">
            <thead><tr>
              <ProductSortHeader label="Ürün" sortKey="product" sort={productSort} onSort={changeProductSort} />
              <ProductSortHeader label="Kategori / depo" sortKey="category" sort={productSort} onSort={changeProductSort} />
              <ProductSortHeader label="Ciro" sortKey="revenue" sort={productSort} onSort={changeProductSort} />
              <ProductSortHeader label="Çıkış" sortKey="sales" sort={productSort} onSort={changeProductSort} />
              <ProductSortHeader label="Güncel stok" sortKey="stock" sort={productSort} onSort={changeProductSort} />
              <ProductSortHeader label="Stok kapsamı" sortKey="coverage" sort={productSort} onSort={changeProductSort} />
              <ProductSortHeader label="Marj" sortKey="margin" sort={productSort} onSort={changeProductSort} />
              <ProductSortHeader label={analytics.selectedScope === "ALL" ? "İlk–son satış değişimi" : "Önceki aya göre satış"} sortKey="salesChange" sort={productSort} onSort={changeProductSort} />
            </tr></thead>
            <tbody>
              {visibleProducts.map((product) => (
                <tr className={product.id === selected.id ? "selected-row" : ""} key={product.id}>
                  <td><button className="product-name-button" type="button" aria-pressed={product.id === selected.id} onClick={() => onSelectedProductChange(product.id)}><strong>{product.stockCode}</strong><span>{product.productName}</span></button></td>
                  <td><strong>{product.category}</strong><small>{product.warehouse}</small></td>
                  <td>{formatCurrency(product.totals.revenue)}</td>
                  <td>{formatNumber(product.totals.salesQuantity)}</td>
                  <td>{product.latest.stock === null ? "—" : formatNumber(product.latest.stock)}</td>
                  <td>{product.latest.coverageMonths === null ? "—" : `${product.latest.coverageMonths.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} ay`}</td>
                  <td>{formatPercent(product.totals.weightedMargin, 1)}</td>
                  <td className={product.changes.salesRatio !== null && product.changes.salesRatio < 0 ? "negative-change" : "positive-change"}>{signedPercent(product.changes.salesRatio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {analytics.products.length > COMPACT_PRODUCT_ROWS && (
          <button className="table-toggle" type="button" aria-expanded={showAllProducts} onClick={() => setShowAllProducts((current) => !current)}>
            {showAllProducts ? <><ChevronUp /> Daha az göster</> : <><ChevronDown /> Devamını gör <span>({analytics.products.length - COMPACT_PRODUCT_ROWS} ürün daha)</span></>}
          </button>
        )}
      </article>
    </section>
  );
}
