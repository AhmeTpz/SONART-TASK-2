"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronsUpDown,
  ShieldAlert,
} from "lucide-react";
import { useMemo, useState } from "react";

import { formatPeriod } from "@/lib/format";
import type { RiskItem } from "@/lib/types";

const collator = new Intl.Collator("tr-TR", { numeric: true, sensitivity: "base" });
const severityRank: Record<RiskItem["severity"], number> = { critical: 0, high: 1, medium: 2 };

type RiskSortKey = "severity" | "product" | "risk" | "evidence" | "period";
type SortDirection = "asc" | "desc";

interface RiskSortState {
  key: RiskSortKey | null;
  direction: SortDirection;
}

function riskSortValue(risk: RiskItem, key: RiskSortKey): string | number {
  switch (key) {
    case "severity": return severityRank[risk.severity];
    case "product": return `${risk.stockCode}\u001f${risk.productName}\u001f${risk.warehouse}`;
    case "risk": return risk.title;
    case "evidence": return risk.detail;
    case "period": return risk.period;
  }
}

function compareValues(left: string | number, right: string | number, direction: SortDirection): number {
  const result = typeof left === "number" && typeof right === "number"
    ? left - right
    : collator.compare(String(left), String(right));
  return direction === "asc" ? result : -result;
}

function RiskSortHeader({ label, sortKey, sort, onSort }: { label: string; sortKey: RiskSortKey; sort: RiskSortState; onSort: (key: RiskSortKey) => void }) {
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

export function RiskTable({ scope, risks, onSelectProduct }: { scope: "ALL" | string; risks: RiskItem[]; onSelectProduct: (risk: RiskItem) => void }) {
  const [riskSort, setRiskSort] = useState<RiskSortState>({ key: null, direction: "asc" });
  const sortedRisks = useMemo(() => {
    if (!riskSort.key) return risks;
    const key = riskSort.key;
    return [...risks].sort((left, right) =>
      compareValues(riskSortValue(left, key), riskSortValue(right, key), riskSort.direction) ||
      collator.compare(left.id, right.id),
    );
  }, [riskSort, risks]);
  const changeRiskSort = (key: RiskSortKey) => {
    setRiskSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  };

  return (
    <article className="panel risk-panel">
      <div className="panel-heading risk-heading">
        <div><span className="eyebrow">Kural tabanlı kontrol</span><h2>Öncelikli risk sinyalleri</h2></div>
        <div className="risk-total"><ShieldAlert size={16} /> {risks.length} sinyal</div>
      </div>
      {risks.length === 0 ? (
        <div className="empty-state"><ShieldAlert size={24} /><strong>Seçili dönemde eşik aşımı yok</strong><span>Profildeki risk kuralları olağan dışı bir sinyal üretmedi.</span></div>
      ) : (
        <>
          <div className="table-scroll">
            <table className="risk-table">
              <thead><tr>
                <RiskSortHeader label="Önem" sortKey="severity" sort={riskSort} onSort={changeRiskSort} />
                <RiskSortHeader label="Stok / depo" sortKey="product" sort={riskSort} onSort={changeRiskSort} />
                <RiskSortHeader label="Risk" sortKey="risk" sort={riskSort} onSort={changeRiskSort} />
                <RiskSortHeader label="Kanıt" sortKey="evidence" sort={riskSort} onSort={changeRiskSort} />
                {scope === "ALL"
                  ? <th aria-label="Ürün detayına git" />
                  : <RiskSortHeader label="Dönem" sortKey="period" sort={riskSort} onSort={changeRiskSort} />}
              </tr></thead>
              <tbody>
                {sortedRisks.map((risk) => (
                  <tr
                    className="risk-row-action"
                    key={risk.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${risk.stockCode} ${risk.productName} ürün analizini aç`}
                    onClick={() => onSelectProduct(risk)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectProduct(risk);
                      }
                    }}
                  >
                    <td><span className={`severity severity-${risk.severity}`}><AlertTriangle size={13} />{risk.severity === "critical" ? "Kritik" : risk.severity === "high" ? "Yüksek" : "Orta"}</span></td>
                    <td><strong>{risk.stockCode}</strong><small>{risk.warehouse}</small></td>
                    <td><span className="risk-type">{risk.title}</span><small>{risk.productName}</small></td>
                    <td className="risk-detail">{risk.detail}</td>
                    <td>{scope !== "ALL" && <span className="period-cell">{formatPeriod(risk.period)}</span>}<ArrowUpRight size={14} aria-hidden="true" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </article>
  );
}
