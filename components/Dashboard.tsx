"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiReportCard, type AiViewState } from "@/components/AiReportCard";
import { DataQualityModal } from "@/components/DataQualityModal";
import { DashboardHeader } from "@/components/DashboardHeader";
import { KpiCards } from "@/components/KpiCards";
import { ProductAnalysisSection } from "@/components/ProductAnalysisSection";
import { RiskTable } from "@/components/RiskTable";
import { TrendCharts } from "@/components/TrendCharts";
import { isCurrentAiReport, readCachedAiSuccess, type AiSuccess } from "@/lib/ai-cache";
import { buildDashboardAnalytics } from "@/lib/analytics";
import { formatPeriod } from "@/lib/format";
import { erpProfile } from "@/lib/profiles/erp-profile";
import type { ErpRow, IngestionResult, RiskItem } from "@/lib/types";

const CACHE_PREFIX = "sonart-ai-report:v15:";

export function Dashboard({ ingestion }: { ingestion: IngestionResult<ErpRow> }) {
  const [scope, setScope] = useState<"ALL" | string>("ALL");
  const [dataQualityOpen, setDataQualityOpen] = useState(false);
  const [aiStates, setAiStates] = useState<Record<string, AiViewState>>({});
  const [selectedProductId, setSelectedProductId] = useState("");
  const attempted = useRef(new Set<string>());
  const productAnalysisRef = useRef<HTMLDivElement>(null);
  const hasUsableData = ingestion.rows.length > 0 && ingestion.periods.length > 0;
  const analytics = useMemo(() => buildDashboardAnalytics(ingestion, erpProfile, scope), [ingestion, scope]);
  const estimatedRowCount = useMemo(
    () => ingestion.rows.filter((row) => row.__estimatedFields?.length).length,
    [ingestion.rows],
  );

  const requestReport = useCallback(async (targetScope: string, force = false) => {
    if (!hasUsableData) return;
    const cacheKey = `${ingestion.dataVersion}:${targetScope}`;
    if (!force && attempted.current.has(cacheKey)) return;
    attempted.current.add(cacheKey);
    if (!force) {
      const cached = readCachedAiSuccess(
        sessionStorage.getItem(`${CACHE_PREFIX}${cacheKey}`),
        targetScope,
        ingestion.dataVersion,
      );
      if (cached) {
        setAiStates((current) => ({ ...current, [targetScope]: cached }));
        return;
      }
    }
    setAiStates((current) => ({ ...current, [targetScope]: { status: "loading" } }));
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: targetScope }),
      });
      const payload = (await response.json()) as { error?: string; scope?: string; dataVersion?: string; report?: unknown; model?: string; generatedAt?: string };
      if (!response.ok || payload.scope !== targetScope || payload.dataVersion !== ingestion.dataVersion || !isCurrentAiReport(payload.report) || !payload.model || !payload.generatedAt) {
        throw new Error(payload.error ?? "AI servisi beklenmeyen bir yanıt verdi.");
      }
      const success: AiSuccess = { status: "success", scope: targetScope, dataVersion: payload.dataVersion, report: payload.report, model: payload.model, generatedAt: payload.generatedAt };
      setAiStates((current) => ({ ...current, [targetScope]: success }));
      sessionStorage.setItem(`${CACHE_PREFIX}${cacheKey}`, JSON.stringify(success));
    } catch (error) {
      setAiStates((current) => ({ ...current, [targetScope]: { status: "error", message: error instanceof Error ? error.message : "Rapor üretilemedi." } }));
    }
  }, [hasUsableData, ingestion.dataVersion]);

  const exportDashboardPdf = useCallback(() => {
    const previousTitle = document.title;
    const reportScope = scope === "ALL" ? "Tum-Donemler" : scope;
    const documentRoot = document.documentElement;
    let fallbackTimer = 0;
    document.title = `Sonart-ERP-Yonetim-Raporu-${reportScope}`;
    documentRoot.classList.add("pdf-exporting");
    const restorePrintState = () => {
      document.title = previousTitle;
      documentRoot.classList.remove("pdf-exporting");
      window.removeEventListener("afterprint", restorePrintState);
      window.clearTimeout(fallbackTimer);
    };
    window.addEventListener("afterprint", restorePrintState);
    fallbackTimer = window.setTimeout(restorePrintState, 60_000);
    window.print();
  }, [scope]);

  useEffect(() => {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith("sonart-ai-report:") && !key.startsWith(CACHE_PREFIX)) {
        sessionStorage.removeItem(key);
      }
    }
  }, []);

  useEffect(() => { void requestReport(scope); }, [requestReport, scope]);

  const storedAiState = aiStates[scope];
  const hasOutdatedInMemoryReport =
    storedAiState?.status === "success" &&
    (storedAiState.dataVersion !== ingestion.dataVersion || !isCurrentAiReport(storedAiState.report));
  useEffect(() => {
    if (!hasOutdatedInMemoryReport) return;
    sessionStorage.removeItem(`${CACHE_PREFIX}${ingestion.dataVersion}:${scope}`);
    void requestReport(scope, true);
  }, [hasOutdatedInMemoryReport, ingestion.dataVersion, requestReport, scope]);

  const openProductFromRisk = useCallback((risk: RiskItem) => {
    const product = analytics.products.find(
      (candidate) => candidate.stockCode === risk.stockCode && candidate.warehouse === risk.warehouse,
    );
    if (!product) return;
    setSelectedProductId(product.id);
    window.requestAnimationFrame(() => {
      productAnalysisRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [analytics.products]);

  const aiState = hasOutdatedInMemoryReport
    ? { status: "loading" as const }
    : storedAiState ?? { status: "loading" as const };
  const scopeTitle = scope === "ALL" ? "Tüm dönemler" : formatPeriod(scope);
  const incompleteLatestPeriod = ingestion.audit.issues.find(
    (issue) => issue.code === "INCOMPLETE_LATEST_PERIOD",
  );

  if (!hasUsableData) {
    return (
      <div className="dashboard-shell">
        <DashboardHeader scope={scope} periods={ingestion.periods} ingestion={ingestion} onScopeChange={setScope} onOpenDataQuality={() => setDataQualityOpen(true)} />
        <main className="dashboard-main empty-data-main">
          <section className="empty-data-state" role="status">
            <span className="eyebrow">Veri kontrolü tamamlandı</span>
            <h1>Analiz için kullanılabilir veri bulunamadı</h1>
            <p>Geçerli dönem içeren ve kalite kontrollerinden geçen kayıt olmadığı için dashboard metrikleri ve AI değerlendirmesi başlatılmadı.</p>
            <button type="button" onClick={() => setDataQualityOpen(true)}>Veri ayrıntılarını incele</button>
          </section>
        </main>
        <DataQualityModal ingestion={ingestion} open={dataQualityOpen} onClose={() => setDataQualityOpen(false)} />
      </div>
    );
  }

  return (
    <div className="dashboard-shell">
      <DashboardHeader scope={scope} periods={ingestion.periods} ingestion={ingestion} onScopeChange={setScope} onOpenDataQuality={() => setDataQualityOpen(true)} />
      <main className="dashboard-main">
        <section className="print-only print-document-header">
          <div><span>Sonart AI-Vision Basic</span><h1>Dashboard Yönetim Raporu</h1><p>Finansal performans, stok, ürün portföyü, risk ve AI yönetim değerlendirmesi</p></div>
          <strong>{scope === "ALL" ? `${formatPeriod(ingestion.periods[0])} - ${formatPeriod(ingestion.periods.at(-1) ?? "")}` : formatPeriod(scope)}</strong>
        </section>
        <section className="overview-heading">
          <div><span className="eyebrow">Operasyon özeti</span><h1>{scopeTitle}</h1><p>{ingestion.counts.used} doğrulanmış kayıt · {estimatedRowCount} kayıtta eksik değer tamamlandı · stok değeri {formatPeriod(analytics.activePeriod)} kapanışını gösterir</p></div>
          <div className="freshness"><span /> Veri seti işlendi <b>{ingestion.periods.length} dönem</b></div>
        </section>
        {ingestion.counts.quarantined > 0 && <button className="quarantine-banner" type="button" onClick={() => setDataQualityOpen(true)}><strong>{ingestion.counts.quarantined} kayıt kalite kontrolüne takıldı.</strong> Bu kayıtlar rapor sonuçlarına dahil edilmedi. Ayrıntıları gör →</button>}
        {incompleteLatestPeriod && <button className="period-warning-banner" type="button" onClick={() => setDataQualityOpen(true)}><strong>Son dönem kayıt kapsamı eksik olabilir.</strong> {incompleteLatestPeriod.message} Ayrıntıları gör →</button>}
        {estimatedRowCount > 0 && <button className="estimation-banner" type="button" onClick={() => setDataQualityOpen(true)}><strong>{estimatedRowCount} kayıtta eksik değer güvenli biçimde tamamlandı.</strong> Sonuç, komşu dönemler ve stok hareketleriyle doğrulandı. Ayrıntıları gör →</button>}
        <KpiCards analytics={analytics} />
        <TrendCharts analytics={analytics} />
        <div className="product-analysis-anchor" ref={productAnalysisRef}>
          <ProductAnalysisSection analytics={analytics} selectedProductId={selectedProductId} onSelectedProductChange={setSelectedProductId} />
        </div>
        <div className="lower-grid">
          <RiskTable scope={scope} risks={analytics.risks} onSelectProduct={openProductFromRisk} />
          <AiReportCard state={aiState} scope={scope} onRetry={() => void requestReport(scope, true)} onExportPdf={exportDashboardPdf} />
        </div>
        <section className="print-only print-quality-summary">
          <div><span>Veri güvenilirliği</span><h2>Rapor veri kalitesi</h2></div>
          <dl>
            <div><dt>Analize dahil oranı</dt><dd>%{ingestion.inclusionRate.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}</dd></div>
            <div><dt>Kaynak kayıt</dt><dd>{ingestion.counts.raw}</dd></div>
            <div><dt>Analize dahil</dt><dd>{ingestion.counts.used}</dd></div>
            <div><dt>Analiz dışı</dt><dd>{ingestion.counts.quarantined}</dd></div>
            <div><dt>Otomatik işlem</dt><dd>{ingestion.audit.summary.autoFixed}</dd></div>
            <div><dt>Encoding</dt><dd>{ingestion.encoding.encoding.toUpperCase()}</dd></div>
          </dl>
        </section>
        <footer className="dashboard-footer"><span>Sonart AI-Vision Basic</span><span>Veri kalitesi kontrolleri etkin · {ingestion.periods.length} dönem doğrulandı</span></footer>
      </main>
      <DataQualityModal ingestion={ingestion} open={dataQualityOpen} onClose={() => setDataQualityOpen(false)} />
    </div>
  );
}
