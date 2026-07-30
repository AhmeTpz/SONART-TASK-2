import type { AiReport } from "@/lib/types";

export interface AiSuccess {
  status: "success";
  scope: string;
  dataVersion: string;
  report: AiReport;
  model: string;
  generatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isCurrentAiReport(value: unknown): value is AiReport {
  if (!isRecord(value) || typeof value.yonetici_ozeti !== "string") return false;
  if (!isRecord(value.degerlendirme)) return false;
  if (
    typeof value.degerlendirme.finansal_performans !== "string" ||
    typeof value.degerlendirme.stok_ve_operasyon !== "string" ||
    typeof value.degerlendirme.urun_ve_portfoy !== "string" ||
    !Array.isArray(value.aksiyon_onerileri)
  ) {
    return false;
  }
  return value.aksiyon_onerileri.every(
    (action) =>
      isRecord(action) &&
      typeof action.baslik === "string" &&
      typeof action.aksiyon === "string" &&
      typeof action.hedef === "string" &&
      typeof action.gerekce === "string" &&
      typeof action.sorumlu_birim === "string" &&
      typeof action.zaman_ufku === "string" &&
      typeof action.beklenen_etki === "string" &&
      typeof action.takip_metrigi === "string" &&
      Array.isArray(action.kanitlar) &&
      action.kanitlar.every((evidence) => typeof evidence === "string") &&
      typeof action.oncelik === "number",
  );
}

export function readCachedAiSuccess(
  value: string | null,
  expectedScope: string,
  expectedDataVersion: string,
): AiSuccess | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AiSuccess>;
    return parsed.status === "success" &&
      parsed.scope === expectedScope &&
      parsed.dataVersion === expectedDataVersion &&
      typeof parsed.model === "string" &&
      typeof parsed.generatedAt === "string" &&
      isCurrentAiReport(parsed.report)
      ? parsed as AiSuccess
      : null;
  } catch {
    return null;
  }
}
