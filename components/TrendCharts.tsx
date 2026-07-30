"use client";

import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";

import { formatCompactCurrency, formatCurrency, formatNumber, formatPercent, formatPeriod } from "@/lib/format";
import type { DashboardAnalytics, ProductInventoryStatus } from "@/lib/types";

const COLORS = ["#165dff", "#10a37f", "#7755d9", "#e49b25", "#e2607a", "#35a3c6"];
const DONUT_PRODUCT_LIMIT = 7;
const DONUT_COLORS = ["#165dff", "#10a37f", "#7755d9", "#e49b25", "#e2607a", "#35a3c6", "#5f7fae", "#c2cbd8"];
const STATUS_COLORS: Record<ProductInventoryStatus, string> = {
  CRITICAL: "#d9485f",
  SLOW: "#e49b25",
  NORMAL: "#168f70",
  NO_SALES: "#8b98aa",
  UNKNOWN: "#a5afbd",
};
const STATUS_LABELS: Record<ProductInventoryStatus, string> = {
  CRITICAL: "Kritik",
  SLOW: "Yavaş hareket",
  NORMAL: "Normal",
  NO_SALES: "Satış yok",
  UNKNOWN: "Hesaplanamadı",
};

interface ProductRevenueSlice {
  id: string;
  stockCode: string;
  productName: string;
  warehouse: string;
  revenue: number;
  grossProfit: number;
  salesQuantity: number;
  share: number;
  color: string;
}

interface PortfolioPoint {
  id: string;
  stockCode: string;
  productName: string;
  warehouse: string;
  coverage: number;
  margin: number;
  revenue: number;
  stock: number | null;
  status: ProductInventoryStatus;
  color: string;
}

function chartPeriod(period: string): string {
  const label = formatPeriod(period).split(" ");
  return `${label[0]?.slice(0, 3)} ${label[1]?.slice(-2)}`;
}

function RevenueDonutTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const item = payload[0].payload as ProductRevenueSlice;
  return (
    <div className="chart-detail-tooltip">
      <strong>{item.stockCode} · {item.productName}</strong>
      <span>{item.warehouse}</span>
      <dl>
        <div><dt>Ciro</dt><dd>{formatCurrency(item.revenue)}</dd></div>
        <div><dt>Brüt kâr</dt><dd>{formatCurrency(item.grossProfit)}</dd></div>
        <div><dt>Satış</dt><dd>{formatNumber(item.salesQuantity)} birim</dd></div>
        <div><dt>Ciro payı</dt><dd>{formatPercent(item.share, 1)}</dd></div>
      </dl>
    </div>
  );
}

function PortfolioTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const item = payload[0].payload as PortfolioPoint;
  return (
    <div className="chart-detail-tooltip">
      <strong>{item.stockCode} · {item.productName}</strong>
      <span>{item.warehouse}</span>
      <dl>
        <div><dt>Stok kapsamı</dt><dd>{item.coverage.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} ay</dd></div>
        <div><dt>Marj</dt><dd>{formatPercent(item.margin, 1)}</dd></div>
        <div><dt>Ciro</dt><dd>{formatCurrency(item.revenue)}</dd></div>
        <div><dt>Güncel stok</dt><dd>{item.stock === null ? "—" : formatNumber(item.stock)}</dd></div>
      </dl>
    </div>
  );
}

export function TrendCharts({ analytics }: { analytics: DashboardAnalytics }) {
  const revenueSlices = useMemo<ProductRevenueSlice[]>(() => {
    const ranked = analytics.products
      .filter((product) => product.totals.revenue > 0)
      .sort((left, right) => right.totals.revenue - left.totals.revenue);
    const totalRevenue = ranked.reduce((sum, product) => sum + product.totals.revenue, 0);
    const featured = ranked.slice(0, DONUT_PRODUCT_LIMIT).map((product) => ({
      id: product.id,
      stockCode: product.stockCode,
      productName: product.productName,
      warehouse: product.warehouse,
      revenue: product.totals.revenue,
      grossProfit: product.totals.grossProfit,
      salesQuantity: product.totals.salesQuantity,
    }));
    const remaining = ranked.slice(DONUT_PRODUCT_LIMIT);
    const entries = remaining.length
      ? [...featured, {
          id: "remaining-products",
          stockCode: "Diğer",
          productName: "Kalan ürünler",
          warehouse: `${remaining.length} ürün / depo`,
          revenue: remaining.reduce((sum, product) => sum + product.totals.revenue, 0),
          grossProfit: remaining.reduce((sum, product) => sum + product.totals.grossProfit, 0),
          salesQuantity: remaining.reduce((sum, product) => sum + product.totals.salesQuantity, 0),
        }]
      : featured;
    return entries.map((entry, index) => ({
      ...entry,
      share: totalRevenue > 0 ? entry.revenue / totalRevenue : 0,
      color: entry.id === "remaining-products" ? DONUT_COLORS.at(-1)! : DONUT_COLORS[index % (DONUT_COLORS.length - 1)],
    }));
  }, [analytics.products]);

  const portfolioPoints = useMemo<PortfolioPoint[]>(() => analytics.products
    .filter((product) => product.latest.coverageMonths !== null && Number.isFinite(product.latest.coverageMonths))
    .map((product) => ({
      id: product.id,
      stockCode: product.stockCode,
      productName: product.productName,
      warehouse: product.warehouse,
      coverage: product.latest.coverageMonths!,
      margin: product.totals.weightedMargin,
      revenue: product.totals.revenue,
      stock: product.latest.stock,
      status: product.latest.inventoryStatus,
      color: STATUS_COLORS[product.latest.inventoryStatus],
    })), [analytics.products]);
  const donutRevenue = revenueSlices.reduce((sum, item) => sum + item.revenue, 0);
  const portfolioExcludedCount = analytics.products.length - portfolioPoints.length;

  return (
    <section className="chart-grid">
      <article className="panel chart-panel">
        <div className="panel-heading"><div><span className="eyebrow">Dönemsel görünüm</span><h2>Satış ve stok trendi</h2></div><span className="panel-note">Stok sağ eksen</span></div>
        <div className="chart-wrap" aria-label="Aylık satış ve stok grafiği">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={analytics.trend} margin={{ top: 12, right: 8, left: -14, bottom: 2 }}>
              <CartesianGrid stroke="#e7ebf3" strokeDasharray="4 4" vertical={false} />
              <XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fill: "#697386", fontSize: 12 }} tickFormatter={chartPeriod} />
              <YAxis yAxisId="money" axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 11 }} tickFormatter={(value) => formatNumber(value, true)} />
              <YAxis yAxisId="stock" orientation="right" axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 11 }} tickFormatter={(value) => formatNumber(value, true)} />
              <Tooltip cursor={{ fill: "#f4f7fb" }} formatter={(value, name) => [name === "Stok" ? formatNumber(Number(value)) : formatCurrency(Number(value)), name]} labelFormatter={(label) => formatPeriod(String(label))} contentStyle={{ borderRadius: 12, borderColor: "#e3e8f0", boxShadow: "0 12px 32px rgba(20,37,63,.1)" }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
              <Bar yAxisId="money" dataKey="revenue" name="Ciro" fill="#165dff" radius={[5, 5, 0, 0]} maxBarSize={38} isAnimationActive={false} />
              <Line yAxisId="stock" type="monotone" dataKey="stock" name="Stok" stroke="#10a37f" strokeWidth={2.5} dot={{ r: 3, fill: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="print-only print-chart-data">
          <table><thead><tr><th>Dönem</th><th>Ciro</th><th>Brüt kâr</th><th>Marj</th><th>Satış</th><th>Stok</th></tr></thead>
            <tbody>{analytics.trend.map((item) => <tr key={item.period}><td>{formatPeriod(item.period)}</td><td>{formatCurrency(item.revenue)}</td><td>{formatCurrency(item.grossProfit)}</td><td>{formatPercent(item.margin, 2)}</td><td>{formatNumber(item.salesQuantity)}</td><td>{formatNumber(item.stock)}</td></tr>)}</tbody>
          </table>
        </div>
      </article>

      <article className="panel chart-panel">
        <div className="panel-heading"><div><span className="eyebrow">Kategori karması</span><h2>Ciro ve brüt kâr</h2></div><span className="panel-note">Seçili kapsam</span></div>
        <div className="chart-wrap category-chart-wrap" aria-label="Kategori bazında ciro ve brüt kâr grafiği">
          <div className="category-chart-canvas">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.categories} margin={{ top: 12, right: 4, left: -14, bottom: 2 }}>
                <CartesianGrid stroke="#e7ebf3" strokeDasharray="4 4" vertical={false} />
                <XAxis dataKey="category" axisLine={false} tickLine={false} tick={{ fill: "#697386", fontSize: 11 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 11 }} tickFormatter={(value) => formatNumber(value, true)} />
                <Tooltip cursor={{ fill: "#f4f7fb" }} formatter={(value, name) => [formatCurrency(Number(value)), name]} contentStyle={{ borderRadius: 12, borderColor: "#e3e8f0", boxShadow: "0 12px 32px rgba(20,37,63,.1)" }} />
                <Bar dataKey="revenue" name="Ciro" radius={[5, 5, 0, 0]} maxBarSize={28} isAnimationActive={false}>{analytics.categories.map((entry, index) => <Cell key={entry.category} fill={COLORS[index % COLORS.length]} />)}</Bar>
                <Bar dataKey="grossProfit" name="Brüt kâr" fill="#b8c3d4" radius={[5, 5, 0, 0]} maxBarSize={28} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="category-chart-legend" aria-label="Kategori grafiği göstergeleri">
            <span><i className="category-revenue-swatch"><b /><b /><b /><b /></i>Ciro</span>
            <span><i className="category-profit-swatch" />Brüt kâr</span>
          </div>
        </div>
        <div className="print-only print-chart-data">
          <table><thead><tr><th>Kategori</th><th>Ciro</th><th>Brüt kâr</th><th>Marj</th><th>Ciro payı</th></tr></thead>
            <tbody>{analytics.categories.map((item) => <tr key={item.category}><td>{item.category}</td><td>{formatCurrency(item.revenue)}</td><td>{formatCurrency(item.grossProfit)}</td><td>{formatPercent(item.revenue > 0 ? item.grossProfit / item.revenue : 0, 1)}</td><td>{formatPercent(analytics.totals.revenue > 0 ? item.revenue / analytics.totals.revenue : 0, 1)}</td></tr>)}</tbody>
          </table>
        </div>
      </article>

      <article className="panel chart-panel portfolio-panel">
        <div className="panel-heading"><div><span className="eyebrow">Stok verimliliği</span><h2>Ürün portföy haritası</h2></div><span className="panel-note">Balon büyüklüğü: ciro</span></div>
        {portfolioPoints.length ? (
          <>
            <div className="chart-wrap portfolio-chart" aria-label="Ürünlerin stok kapsamı marj ve ciro karşılaştırması">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 14, right: 15, left: -5, bottom: 8 }}>
                  <CartesianGrid stroke="#e7ebf3" strokeDasharray="4 4" />
                  <XAxis type="number" dataKey="coverage" name="Stok kapsamı" unit=" ay" domain={[0, "auto"]} axisLine={false} tickLine={false} tick={{ fill: "#697386", fontSize: 10 }} tickFormatter={(value) => Number(value).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} />
                  <YAxis type="number" dataKey="margin" name="Marj" axisLine={false} tickLine={false} tick={{ fill: "#8a94a6", fontSize: 10 }} tickFormatter={(value) => formatPercent(Number(value), 0)} />
                  <ZAxis type="number" dataKey="revenue" range={[65, 360]} />
                  <Tooltip cursor={{ stroke: "#9aabc1", strokeDasharray: "4 4" }} content={PortfolioTooltip} />
                  <Scatter data={portfolioPoints} isAnimationActive={false}>
                    {portfolioPoints.map((product) => <Cell key={product.id} fill={product.color} fillOpacity={0.82} stroke="white" strokeWidth={1.5} />)}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div className="portfolio-footer">
              <div className="portfolio-legend"><span><i className="status-critical" />Kritik kapsam</span><span><i className="status-normal" />Normal</span><span><i className="status-slow" />Yavaş hareket</span></div>
              <small>{portfolioPoints.length} ürün / depo karşılaştırıldı{portfolioExcludedCount > 0 ? ` · ${portfolioExcludedCount} kayıt için kapsam hesaplanamadı` : ""}</small>
            </div>
          </>
        ) : (
          <div className="chart-empty-state">Stok kapsamı hesaplanabilen ürün bulunmuyor.</div>
        )}
        <div className="print-only print-chart-data print-product-data">
          <table><thead><tr><th>Ürün</th><th>Kategori / depo</th><th>Ciro</th><th>Brüt kâr</th><th>Marj</th><th>Satış</th><th>Stok</th><th>Kapsam</th><th>Durum</th></tr></thead>
            <tbody>{analytics.products.map((item) => <tr key={item.id}><td><strong>{item.stockCode}</strong> {item.productName}</td><td>{item.category}<br />{item.warehouse}</td><td>{formatCurrency(item.totals.revenue)}</td><td>{formatCurrency(item.totals.grossProfit)}</td><td>{formatPercent(item.totals.weightedMargin, 1)}</td><td>{formatNumber(item.totals.salesQuantity)}</td><td>{item.latest.stock === null ? "-" : formatNumber(item.latest.stock)}</td><td>{item.latest.coverageMonths === null ? "-" : `${item.latest.coverageMonths.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} ay`}</td><td>{STATUS_LABELS[item.latest.inventoryStatus]}</td></tr>)}</tbody>
          </table>
        </div>
      </article>

      <article className="panel chart-panel donut-panel">
        <div className="panel-heading"><div><span className="eyebrow">Ciro yoğunlaşması</span><h2>Ürünlerin ciro payı</h2></div><span className="panel-note">İlk {Math.min(DONUT_PRODUCT_LIMIT, analytics.products.length)} ürün</span></div>
        {revenueSlices.length ? (
          <>
            <div className="donut-layout">
            <div className="donut-visual" aria-label="Ürün bazında ciro payı halka grafiği">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={[{ value: 1 }]} dataKey="value" cx="50%" cy="50%" innerRadius="54%" outerRadius="94%" fill="#eef2f7" stroke="none" isAnimationActive={false} />
                  <Pie data={revenueSlices} dataKey="revenue" nameKey="stockCode" cx="50%" cy="50%" innerRadius="54%" outerRadius="94%" paddingAngle={2} cornerRadius={5} stroke="white" strokeWidth={2} isAnimationActive={false}>
                    {revenueSlices.map((item) => <Cell key={item.id} fill={item.color} />)}
                  </Pie>
                  <Tooltip content={RevenueDonutTooltip} />
                </PieChart>
              </ResponsiveContainer>
              <div className="donut-center"><span>Toplam ciro</span><strong>{formatCompactCurrency(donutRevenue)}</strong></div>
            </div>
            <div className="donut-legend">
              {revenueSlices.map((item) => (
                <div className={item.id === "remaining-products" ? "donut-other" : undefined} key={item.id}>
                  <i style={{ background: item.color }} />
                  <span><strong>{item.stockCode}</strong><small>{item.productName}</small></span>
                  <b>{formatPercent(item.share, 1)}</b>
                </div>
              ))}
            </div>
            </div>
            <div className="print-only print-chart-data">
              <table><thead><tr><th>Ürün</th><th>Ciro</th><th>Brüt kâr</th><th>Satış</th><th>Ciro payı</th></tr></thead>
                <tbody>{revenueSlices.map((item) => <tr key={item.id}><td><strong>{item.stockCode}</strong> {item.productName}</td><td>{formatCurrency(item.revenue)}</td><td>{formatCurrency(item.grossProfit)}</td><td>{formatNumber(item.salesQuantity)}</td><td>{formatPercent(item.share, 1)}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="chart-empty-state">Seçili kapsamda ürün cirosu bulunmuyor.</div>
        )}
      </article>
    </section>
  );
}
