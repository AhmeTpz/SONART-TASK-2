import { ChevronRight, Database, ShieldCheck } from "lucide-react";

import { formatPeriod } from "@/lib/format";
import type { IngestionResult, ErpRow } from "@/lib/types";

interface DashboardHeaderProps {
  scope: "ALL" | string;
  periods: string[];
  ingestion: IngestionResult<ErpRow>;
  onScopeChange: (scope: "ALL" | string) => void;
  onOpenDataQuality: () => void;
}

export function DashboardHeader({ scope, periods, ingestion, onScopeChange, onOpenDataQuality }: DashboardHeaderProps) {
  return (
    <header className="dashboard-header">
      <div className="brand-block">
        <div className="brand-mark" aria-hidden="true"><Database size={22} strokeWidth={2.2} /></div>
        <div>
          <div className="brand-line">
            <span className="brand-name">SONART</span><span className="brand-divider" /><span className="brand-product">AI-Vision Basic</span>
          </div>
          <p>Stok, satış ve kârlılık kontrol merkezi</p>
        </div>
      </div>

      <div className="header-actions">
        <label className="period-control">
          <span>Rapor dönemi</span>
          <select aria-label="Rapor dönemi" value={scope} onChange={(event) => onScopeChange(event.target.value)}>
            <option value="ALL">Tüm Dönemler</option>
            {periods.map((period) => <option value={period} key={period}>{formatPeriod(period)}</option>)}
          </select>
        </label>

        <button className="quality-button" type="button" onClick={onOpenDataQuality} aria-label={`Analize dahil oranı yüzde ${ingestion.inclusionRate.toLocaleString("tr-TR")}, veri ayrıntılarını aç`}>
          <span className="quality-icon"><ShieldCheck size={18} /></span>
          <span className="quality-copy"><small>Analize dahil oranı</small><strong>%{ingestion.inclusionRate.toLocaleString("tr-TR")}</strong></span>
          <ChevronRight className="quality-chevron" size={17} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
