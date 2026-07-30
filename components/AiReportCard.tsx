"use client";

import {
  BarChart3,
  Bot,
  Boxes,
  BrainCircuit,
  Clock3,
  FileDown,
  Gauge,
  RefreshCw,
  Sparkles,
  Target,
  TriangleAlert,
} from "lucide-react";

import { formatPeriod } from "@/lib/format";
import type { AiSuccess } from "@/lib/ai-cache";
export type { AiSuccess } from "@/lib/ai-cache";
export type AiViewState = { status: "loading" } | AiSuccess | { status: "error"; message: string };
interface AiReportCardProps { state: AiViewState; scope: string; onRetry: () => void; onExportPdf: () => void; }

function scopeLabel(scope: string): string { return scope === "ALL" ? "Tüm Dönemler" : formatPeriod(scope); }

function generatedAtLabel(value: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const evidenceFields: Record<string, { label: string; unit?: string; percentPrefix?: boolean }> = {
  revenueTl: { label: "Ciro", unit: "TL" },
  grossProfitTl: { label: "Brüt kâr", unit: "TL" },
  costOfGoodsSoldTl: { label: "Satış maliyeti", unit: "TL" },
  unitCostTl: { label: "Birim maliyet", unit: "TL" },
  unitPriceTl: { label: "Birim satış fiyatı", unit: "TL" },
  stockUnits: { label: "Stok", unit: "birim" },
  stockUnitsAtSnapshot: { label: "Dönem sonu stok", unit: "birim" },
  salesQuantity: { label: "Satış miktarı", unit: "birim" },
  inputQuantity: { label: "Giriş miktarı", unit: "birim" },
  coverageMonths: { label: "Stok kapsamı", unit: "ay" },
  marginPercent: { label: "Marj", percentPrefix: true },
  weightedMarginPercent: { label: "Ağırlıklı marj", percentPrefix: true },
  revenueSharePercent: { label: "Ciro payı", percentPrefix: true },
  revenueChangePercent: { label: "Ciro değişimi", percentPrefix: true },
  grossProfitChangePercent: { label: "Brüt kâr değişimi", percentPrefix: true },
  salesPercent: { label: "Satış değişimi", percentPrefix: true },
  costPercent: { label: "Maliyet değişimi", percentPrefix: true },
  stockPercent: { label: "Stok değişimi", percentPrefix: true },
  marginPoints: { label: "Marj değişimi", unit: "puan" },
  marginChangePoints: { label: "Marj değişimi", unit: "puan" },
  observedPeriodCount: { label: "Görüldüğü dönem", unit: "dönem" },
  activeRuleSignalCount: { label: "Aktif sinyal", unit: "adet" },
};

function formatEvidence(evidence: string): string {
  const match = evidence.trim().match(/^([A-Za-z][A-Za-z0-9_.]*)\s*[:=]\s*(.+)$/);
  if (!match) return evidence;
  const keyParts = match[1].split(".");
  const fieldKey = keyParts.at(-1) ?? "";
  const field = evidenceFields[fieldKey];
  if (!field) return evidence;
  const productCode = keyParts.length > 1 && /\d/.test(keyParts[0]) ? keyParts[0] : null;
  const displayLabel = productCode ? `${field.label} (${productCode})` : field.label;

  const rawValue = match[2].trim();
  const unitlessValue = rawValue
    .replace(/^%\s*/, "")
    .replace(/\s*(?:%|TL|birim|ay|puan|dönem|adet)$/i, "")
    .trim();
  const numericValue = /^-?\d+(?:[.,]\d+)?$/.test(unitlessValue)
    ? Number(unitlessValue.replace(",", "."))
    : null;
  if (numericValue === null) return `${displayLabel}: ${rawValue}`;
  const localizedValue = numericValue.toLocaleString("tr-TR", { maximumFractionDigits: 2 });
  const valueWithUnit = field.percentPrefix
    ? `%${localizedValue}`
    : field.unit
      ? `${localizedValue} ${field.unit}`
      : localizedValue;
  return `${displayLabel}: ${valueWithUnit}`;
}

const assessmentSections = [
  { key: "finansal_performans", label: "Finansal performans", icon: BarChart3 },
  { key: "stok_ve_operasyon", label: "Stok ve operasyon", icon: Boxes },
  { key: "urun_ve_portfoy", label: "Ürün ve portföy", icon: Gauge },
] as const;

function Report({ result, onRetry, onExportPdf }: { result: AiSuccess; onRetry: () => void; onExportPdf: () => void }) {
  return (
    <div className="ai-report-body">
      <section className="ai-executive-summary">
        <span><Sparkles size={14} /> Yönetici özeti</span>
        <p>{result.report.yonetici_ozeti}</p>
      </section>

      <div className="ai-assessment-grid">
        {assessmentSections.map((section) => {
          const Icon = section.icon;
          return (
            <section className="ai-assessment-card" key={section.key}>
              <h3><Icon size={15} /> {section.label}</h3>
              <p>{result.report.degerlendirme[section.key]}</p>
            </section>
          );
        })}
      </div>

      <section className="ai-actions-section">
        <div className="ai-section-title">
          <div><Target size={17} /><h3>Öncelikli aksiyon planı</h3></div>
          <span>{result.report.aksiyon_onerileri.length} karar önerisi</span>
        </div>
        <div className="ai-action-list">
          {result.report.aksiyon_onerileri
            .slice()
            .sort((a, b) => a.oncelik - b.oncelik)
            .map((action, index) => (
              <article className="ai-action-card" key={`${action.baslik}-${index}`}>
                <div className="ai-action-heading">
                  <span className="action-number">{action.oncelik}</span>
                  <div>
                    <strong>{action.baslik}</strong>
                    <small>{action.hedef}</small>
                  </div>
                </div>
                <div className="ai-action-meta">
                  <span><Bot size={12} /> {action.sorumlu_birim}</span>
                  <span><Clock3 size={12} /> {action.zaman_ufku}</span>
                </div>
                <p className="ai-action-command">{action.aksiyon}</p>
                <p className="ai-action-reason">{action.gerekce}</p>
                <div className="ai-evidence-list">
                  {action.kanitlar.map((evidence, evidenceIndex) => (
                    <span key={`${evidence}-${evidenceIndex}`}>{formatEvidence(evidence)}</span>
                  ))}
                </div>
                <div className="ai-action-result">
                  <div><small>Beklenen etki</small><span>{action.beklenen_etki}</span></div>
                  <div><small>Takip metriği</small><span>{action.takip_metrigi}</span></div>
                </div>
              </article>
            ))}
        </div>
      </section>

      <div className="ai-report-footer">
        <div className="ai-meta"><Bot size={13} /> {result.model} · Üretildi: {generatedAtLabel(result.generatedAt)}</div>
        <div className="ai-report-actions">
          <button type="button" onClick={onRetry} title="Bu kapsam için AI raporunu yeniden üret"><RefreshCw size={11} /> Yeniden üret</button>
          <button type="button" onClick={onExportPdf} title="Seçili dashboard kapsamını PDF olarak kaydet"><FileDown size={11} /> PDF&apos;e aktar</button>
        </div>
      </div>
    </div>
  );
}

export function AiReportCard({ state, scope, onRetry, onExportPdf }: AiReportCardProps) {
  return (
    <article className="panel ai-panel">
      <div className="panel-heading ai-heading"><div className="ai-title-wrap"><span className="ai-logo"><BrainCircuit size={22} /></span><div><span className="eyebrow">Gemini destekli</span><h2>AI yönetim değerlendirmesi</h2></div></div><span className="scope-chip">{scopeLabel(scope)}</span></div>
      {state.status === "loading" && <div className="ai-loading" role="status"><span className="ai-pulse"><BrainCircuit size={25} /></span><div><strong>Yönetim değerlendirmesi hazırlanıyor</strong><p>Finansal sonuçlar, ürün hareketleri ve stok dengesi birlikte analiz ediliyor.</p></div></div>}
      {state.status === "error" && <div className="ai-error"><div><TriangleAlert size={18} /><span><strong>Bu kapsam için değerlendirme üretilemedi.</strong><p>{state.message}</p></span></div><button type="button" onClick={onRetry}><RefreshCw size={15} /> Tekrar dene</button></div>}
      {state.status === "success" && <Report result={state} onRetry={onRetry} onExportPdf={onExportPdf} />}
    </article>
  );
}
