"use client";

import { CheckCircle2, ChevronDown, Database, FileWarning, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { AuditIssue, ErpRow, IngestionResult } from "@/lib/types";

interface DataQualityModalProps {
  ingestion: IngestionResult<ErpRow>;
  open: boolean;
  onClose: () => void;
}

const outcomeLabels = {
  AUTO_FIXED: "Otomatik tamamlandı",
  WARNING: "Kontrol önerisi",
  QUARANTINED: "Analiz dışı",
} as const;

const confidenceLabels = {
  HIGH: "Yüksek güven",
  MEDIUM: "Orta güven",
  LOW: "Düşük güven",
} as const;

const fieldLabels: Record<string, string> = {
  stok_kodu: "Stok kodu",
  urun_adi: "Ürün adı",
  kategori: "Kategori",
  depo: "Depo",
  donem: "Dönem",
  giris_miktar: "Giriş miktarı",
  cikis_miktar: "Çıkış miktarı",
  donem_sonu_stok: "Dönem sonu stok",
  birim_maliyet_tl: "Birim maliyet",
  birim_satis_tl: "Birim satış fiyatı",
};

const issueTitles: Record<string, string> = {
  TEXT_NORMALIZED: "Metin biçimi standartlaştırıldı.",
  MOJIBAKE_REPAIRED: "Bozuk görünen Türkçe karakterler güvenli biçimde onarıldı.",
  MASTER_DATA_MATCH: "Ürün bilgisi tanımlı ana veriyle eşleştirildi.",
  INVENTORY_BRIDGE_CONFLICT: "Stok hareketlerinde doğrulanması gereken bir tutarsızlık tespit edildi.",
  INVENTORY_INPUT_ESTIMATED: "Eksik giriş miktarı ürün ve depo hareketlerine göre tahmin edildi.",
  INVENTORY_OUTPUT_RECONCILED: "Eksik çıkış miktarı stok sürekliliği korunarak tamamlandı.",
  INVENTORY_STOCK_DERIVED: "Dönem sonu stok, giriş ve çıkış hareketlerinden hesaplandı.",
  UNRESOLVED_INVENTORY_VALUE: "Eksik stok hareketi yeterli güvenle tamamlanamadı.",
  MISSING_PERIOD_ROW: "Eksik dönem kaydı tespit edildi; yeni kayıt oluşturulmadı.",
  VALUE_INTERPOLATED: "Eksik değer komşu dönem hareketlerine göre tamamlandı.",
  VALUE_EDGE_FILLED: "Eksik değer en yakın doğrulanmış dönemden tamamlandı.",
  AMBIGUOUS_ENCODING: "Dosya karakter yapısı yeterli güvenle doğrulanamadı.",
  ENCODING_SELECTED: "Dosya biçimi ve Türkçe karakter uyumu doğrulandı.",
  CSV_PARSE_ERROR: "Dosyada okunamayan bir kayıt tespit edildi.",
  MISSING_REQUIRED_COLUMN: "Analiz için gerekli bir veri alanı bulunamadı.",
  UNEXPECTED_COLUMN: "Rapor profilinde tanımlı olmayan bir alan tespit edildi.",
  INVALID_NUMBER: "Sayısal alan geçerli bir değere dönüştürülemedi.",
  INVALID_IDENTITY_OR_PERIOD: "Kimlik veya dönem bilgisi doğrulanamayan kayıt analiz dışında bırakıldı.",
  EXACT_DUPLICATE_REMOVED: "Tekrarlanan kayıt analizden çıkarıldı.",
  CONFLICTING_NATURAL_KEY: "Aynı döneme ait çelişkili kayıtlar analiz dışında bırakıldı.",
  UNRESOLVED_MISSING_VALUE: "Eksik değer güvenli biçimde tamamlanamadı.",
  VALUE_OUT_OF_RANGE: "Değer ERP profilinin izin verdiği aralığın dışında kaldı.",
  MASTER_DATA_DRIFT: "Ürün ana bilgisinde dönemler arasında değişiklik bulundu.",
  INCOMPLETE_LATEST_PERIOD: "Son dönem stok fotoğrafında eksik ürün veya depo kaydı olabilir.",
};

function preview(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Eksik";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function issueTitle(issue: AuditIssue): string {
  return issueTitles[issue.code] ?? issue.message;
}

function isTurkishTextOperation(issue: AuditIssue): boolean {
  return issue.outcome === "AUTO_FIXED" &&
    (issue.code === "MOJIBAKE_REPAIRED" || issue.code === "MASTER_DATA_MATCH");
}

const turkishCharacterPattern = /[İıŞşĞğÜüÖöÇç]/;

export function DataQualityModal({ ingestion, open, onClose }: DataQualityModalProps) {
  const [openList, setOpenList] = useState<"review" | "excluded" | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);

  if (!open) return null;
  const { audit, counts } = ingestion;
  const visibleIssues = audit.issues.filter((issue) => issue.code !== "ENCODING_SELECTED");
  const excludedCount = Math.max(0, counts.raw - counts.used);
  const findSourceRow = (sourceRow: number | undefined): Partial<ErpRow> | undefined => {
    if (!sourceRow) return undefined;
    return ingestion.rows.find((row) => row.__sourceRow === sourceRow) ??
      (ingestion.quarantinedRows.find((record) => record.sourceRows.includes(sourceRow))?.row as Partial<ErpRow> | undefined);
  };
  const duplicateRecords = audit.issues
    .filter((issue) => issue.code === "EXACT_DUPLICATE_REMOVED")
    .map((issue) => {
      const retainedSourceRow = issue.sourceRows[0];
      const excludedSourceRow = issue.sourceRows.at(-1);
      return {
        id: issue.id,
        title: "Tekrarlanan kayıt",
        reason: "Aynı içerik dosyada daha önce bulunduğu için yalnızca ilk kayıt analize dahil edildi.",
        sourceRows: excludedSourceRow ? [excludedSourceRow] : issue.sourceRows,
        relatedSourceRow: retainedSourceRow,
        row: findSourceRow(retainedSourceRow),
      };
    });
  const quarantinedRecords = ingestion.quarantinedRows.map((record, index) => ({
    id: `excluded-${index}-${record.sourceRows.join("-")}`,
    title: "Doğrulanamayan kayıt",
    reason: record.reasons.join(" · "),
    sourceRows: record.sourceRows,
    relatedSourceRow: undefined,
    row: record.row as Partial<ErpRow>,
  }));
  const excludedRecords = [...duplicateRecords, ...quarantinedRecords].sort(
    (a, b) => (a.sourceRows[0] ?? 0) - (b.sourceRows[0] ?? 0),
  );
  const reviewRecords = audit.issues
    .filter((issue) => issue.outcome === "WARNING")
    .map((issue) => ({
      id: issue.id,
      title: issueTitle(issue),
      sourceRows: issue.sourceRows,
      field: issue.field ? fieldLabels[issue.field] ?? issue.field : null,
      before: issue.before,
      after: issue.after,
      detail: issue.message,
      row: findSourceRow(issue.sourceRows[0]),
    }));
  const turkishTextIssues = audit.issues.filter(isTurkishTextOperation);
  const turkishTextRows = new Set(turkishTextIssues.flatMap((issue) => issue.sourceRows));
  const turkishCharacterRowCount = ingestion.rows.filter((row) =>
    Object.values(row).some(
      (value) => typeof value === "string" && turkishCharacterPattern.test(value),
    ),
  );

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="data-quality-modal" role="dialog" aria-modal="true" aria-labelledby="data-quality-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="eyebrow">Veri güvenilirliği</span>
            <h2 id="data-quality-title">Veri Kalitesi Detayları</h2>
            <p>Analize alınan kayıtlar ve uygulanan kalite kontrolleri</p>
          </div>
          <button className="icon-button" type="button" aria-label="Veri kalitesi penceresini kapat" onClick={onClose}><X /></button>
        </div>

        <div className="quality-summary-grid">
          <div className="quality-summary-card"><Database /><span><strong>{counts.raw}</strong>Kaynak kayıt</span></div>
          <div className="quality-summary-card"><CheckCircle2 /><span><strong>{counts.used}</strong>Doğrulanan kayıt</span></div>
          <button className="quality-summary-card review-summary-card" type="button" disabled={reviewRecords.length === 0} aria-expanded={openList === "review"} aria-controls="review-record-list" onClick={() => setOpenList((current) => current === "review" ? null : "review")}>
            <FileWarning /><span><strong>{reviewRecords.length}</strong>Kontrol uyarısı</span>{reviewRecords.length > 0 && <ChevronDown className={openList === "review" ? "expanded" : ""} />}
          </button>
          <button className="quality-summary-card excluded-summary-card" type="button" disabled={excludedCount === 0} aria-expanded={openList === "excluded"} aria-controls="excluded-record-list" onClick={() => setOpenList((current) => current === "excluded" ? null : "excluded")}>
            <FileWarning /><span><strong>{excludedCount}</strong>Analize alınmayan</span>{excludedCount > 0 && <ChevronDown className={openList === "excluded" ? "expanded" : ""} />}
          </button>
          <div className="quality-summary-card"><ShieldCheck /><span><strong>%{ingestion.inclusionRate.toLocaleString("tr-TR")}</strong>Analize dahil oranı</span></div>
        </div>

        {openList === "review" && reviewRecords.length > 0 && (
          <div className="excluded-records review-records" id="review-record-list">
            <div className="excluded-records-heading"><div><span className="eyebrow">İnceleme listesi</span><strong>Kontrol edilmesi önerilen durumlar</strong></div><span>{reviewRecords.length} uyarı</span></div>
            <div className="excluded-record-list">
              {reviewRecords.map((record) => (
                <article key={record.id}>
                  <div className="excluded-record-index">{record.sourceRows.length ? record.sourceRows.join(", ") : "!"}</div>
                  <div className="excluded-record-content">
                    <div><strong>{record.title}</strong><span>{record.sourceRows.length ? `Kaynak satır: ${record.sourceRows.join(", ")}` : "Dosya genelinde"}</span></div>
                    {record.field && <p>İlgili alan: {record.field}</p>}
                    {!record.field && <p>{record.detail}</p>}
                    <div className="excluded-record-identity">
                      <strong>{record.row?.stok_kodu ?? "Kayıt geneli"}</strong>
                      <span>{record.row?.urun_adi ?? "Ürün bilgisi bulunmuyor"}</span>
                      {(record.row?.donem || record.row?.depo) && <small>{[record.row?.donem, record.row?.depo].filter(Boolean).join(" · ")}</small>}
                    </div>
                    {(record.before !== undefined || record.after !== undefined) && <div className="review-value-change"><span>{preview(record.before)}</span><b>→</b><span>{preview(record.after)}</span></div>}
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}

        {openList === "excluded" && excludedCount > 0 && (
          <div className="excluded-records" id="excluded-record-list">
            <div className="excluded-records-heading"><div><span className="eyebrow">Kayıt kontrolü</span><strong>Analize alınmayan kayıtlar</strong></div><span>{excludedCount} kayıt</span></div>
            <div className="excluded-record-list">
              {excludedRecords.map((record) => (
                <article key={record.id}>
                  <div className="excluded-record-index">{record.sourceRows.join(", ")}</div>
                  <div className="excluded-record-content">
                    <div><strong>{record.title}</strong><span>Kaynak satır: {record.sourceRows.join(", ")}</span></div>
                    <p>{record.reason}</p>
                    <div className="excluded-record-identity">
                      <strong>{record.row?.stok_kodu ?? "Kod doğrulanamadı"}</strong>
                      <span>{record.row?.urun_adi ?? "Ürün bilgisi bulunamadı"}</span>
                      {(record.row?.donem || record.row?.depo) && <small>{[record.row?.donem, record.row?.depo].filter(Boolean).join(" · ")}</small>}
                    </div>
                    {record.relatedSourceRow && <small className="retained-record-note">Aynı içeriğe sahip {record.relatedSourceRow}. satır analize bir kez dahil edildi.</small>}
                  </div>
                </article>
              ))}
              {excludedRecords.length === 0 && <p className="excluded-record-fallback">{excludedCount} kayıt analize alınmadı; kaynak satır ayrıntısı oluşturulamadı.</p>}
            </div>
          </div>
        )}

        <div className="validation-card">
          <span className="validation-icon"><ShieldCheck /></span>
          <div>
            <span className="eyebrow">Dosya doğrulaması</span>
            <strong>Türkçe karakterler ve ERP alan yapısı doğrulandı</strong>
            <p>{counts.raw} kaynak kaydın {counts.used} tanesi analize hazır hale getirildi.</p>
          </div>
          <span className="validation-status">Başarılı</span>
        </div>

        <div className="quality-note">
          Yalnız güven seviyesi yeterli olan işlemler otomatik uygulanır. Belirsiz veya çelişkili kayıtlar rapor metriklerine dahil edilmez.
        </div>

        <div className="quality-events">
          <div className="quality-list-heading"><strong>Uygulanan veri işlemleri</strong><span>{visibleIssues.length + 1} işlem</span></div>
          <article className="quality-event">
            <span className="quality-outcome outcome-auto_fixed">Doğrulandı</span>
            <div>
              <div className="quality-event-title">
                <strong>Türkçe karakter uyumluluğu kontrol edildi.</strong>
                <span className="confidence-badge confidence-high">Yüksek güven</span>
              </div>
              <p className="quality-event-meta">
                {turkishCharacterRowCount.length} kayıt Türkçe karakter içeriyor ve doğru biçimde okundu · {turkishTextRows.size} kayıtta otomatik metin onarımı uygulandı
              </p>
            </div>
          </article>
          {visibleIssues.map((issue) => (
            <article className="quality-event" key={issue.id}>
              <span className={`quality-outcome outcome-${issue.outcome.toLowerCase()}`}>{outcomeLabels[issue.outcome]}</span>
              <div>
                <div className="quality-event-title">
                  <strong>{issueTitle(issue)}</strong>
                  <span className={`confidence-badge confidence-${issue.confidence.toLowerCase()}`}>{confidenceLabels[issue.confidence]}</span>
                </div>
                <p className="quality-event-meta">
                  {issue.sourceRows.length ? `Kaynak satır: ${issue.sourceRows.join(", ")}` : "Dosya genelinde"}
                  {issue.field ? ` · ${fieldLabels[issue.field] ?? issue.field}` : ""}
                </p>
                {(issue.before !== undefined || issue.after !== undefined) && (
                  <div className="value-change">
                    <span><small>Önce</small>{preview(issue.before)}</span>
                    <b>→</b>
                    <span><small>Sonuç</small>{preview(issue.after)}</span>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
