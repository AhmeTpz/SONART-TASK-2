import { BadgeDollarSign, Boxes, CircleGauge, TrendingUp } from "lucide-react";

import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import type { DashboardAnalytics } from "@/lib/types";

export function KpiCards({ analytics }: { analytics: DashboardAnalytics }) {
  const cards = [
    { label: "Net ciro", value: formatCurrency(analytics.totals.revenue), detail: `${formatNumber(analytics.totals.salesQuantity)} birim çıkış`, icon: BadgeDollarSign, tone: "blue" },
    { label: "Brüt kâr", value: formatCurrency(analytics.totals.grossProfit), detail: `${formatCurrency(analytics.totals.cogs)} satış maliyeti`, icon: TrendingUp, tone: "emerald" },
    { label: "Ağırlıklı marj", value: formatPercent(analytics.totals.weightedMargin, 2), detail: "Ciro ağırlıklı hesaplandı", icon: CircleGauge, tone: "violet" },
    { label: "Dönem sonu stok", value: formatNumber(analytics.totals.stock), detail: `${analytics.activePeriod} snapshot`, icon: Boxes, tone: "amber" },
  ];

  return (
    <section className="kpi-grid" aria-label="Ana performans göstergeleri">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <article className={`kpi-card tone-${card.tone}`} key={card.label}>
            <div className="kpi-heading"><span>{card.label}</span><div className="kpi-icon"><Icon size={20} /></div></div>
            <strong>{card.value}</strong><p>{card.detail}</p>
          </article>
        );
      })}
    </section>
  );
}
