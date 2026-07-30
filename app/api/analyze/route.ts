import { NextResponse } from "next/server";

import { analyzeRequestSchema, buildAiContext } from "@/lib/ai-contract";
import { buildDashboardAnalytics } from "@/lib/analytics";
import { loadErpData } from "@/lib/data-source.server";
import { generateGeminiReport } from "@/lib/gemini-client.server";
import { MissingGeminiKeyError } from "@/lib/model-fallback";
import { erpProfile } from "@/lib/profiles/erp-profile";

export const runtime = "nodejs";

function userFacingAiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (/DEADLINE_EXCEEDED|deadline|timeout|timed out|504/i.test(message)) {
    return "AI servisi zaman aşımına uğradı. Kısa bir süre sonra tekrar deneyin.";
  }
  if (/RESOURCE_EXHAUSTED|quota|rate limit|429/i.test(message)) {
    return "AI kullanım kotasına ulaşıldı. Bir süre sonra tekrar deneyin.";
  }

  return "AI raporu şu anda üretilemedi. Lütfen tekrar deneyin.";
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Geçerli bir JSON gövdesi gönderin." }, { status: 400 });
  }

  const parsed = analyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "İstek yalnız { scope: \"ALL\" | \"YYYY-MM\" } biçiminde olmalıdır." },
      { status: 400 },
    );
  }

  try {
    const ingestion = await loadErpData();
    if (!ingestion.rows.length || !ingestion.periods.length) {
      return NextResponse.json(
        { error: "Analiz için kullanılabilir kayıt veya geçerli dönem bulunamadı." },
        { status: 422 },
      );
    }
    const scope = parsed.data.scope;
    if (scope !== "ALL" && !ingestion.periods.includes(scope)) {
      return NextResponse.json(
        { error: "Dönem temiz veri kümesinde bulunamadı.", availablePeriods: ingestion.periods },
        { status: 422 },
      );
    }
    const analytics = buildDashboardAnalytics(ingestion, erpProfile, scope);
    const context = buildAiContext(analytics, ingestion);
    const generated = await generateGeminiReport(
      context,
      scope === "ALL" ? "MULTI_PERIOD" : "SINGLE_PERIOD",
    );

    return NextResponse.json({
      scope,
      report: generated.report,
      model: generated.model,
      generatedAt: new Date().toISOString(),
      dataVersion: ingestion.dataVersion,
      dataQuality: {
        inclusionRate: ingestion.inclusionRate,
        usedRows: ingestion.counts.used,
        quarantinedRows: ingestion.counts.quarantined,
      },
    });
  } catch (error) {
    if (error instanceof MissingGeminiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("AI report generation failed", error);
    return NextResponse.json({ error: userFacingAiError(error) }, { status: 502 });
  }
}
