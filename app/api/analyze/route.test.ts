import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/data-source.server", () => ({ loadErpData: vi.fn() }));
vi.mock("@/lib/gemini-client.server", () => ({ generateGeminiReport: vi.fn() }));

import { POST } from "@/app/api/analyze/route";
import { ingestCsv } from "@/lib/data-pipeline";
import { loadErpData } from "@/lib/data-source.server";
import { generateGeminiReport } from "@/lib/gemini-client.server";
import { MissingGeminiKeyError } from "@/lib/model-fallback";
import { erpProfile } from "@/lib/profiles/erp-profile";

const HEADER =
  "stok_kodu,urun_adi,kategori,depo,donem,giris_miktar,cikis_miktar,donem_sonu_stok,birim_maliyet_tl,birim_satis_tl";

function ingestion(sales = 10) {
  return ingestCsv(
    Buffer.from(`${HEADER}\nSKU-API,API Ürünü,Kategori,Ana Depo,2025-01,10,${sales},100,10,20`),
    erpProfile,
  );
}

const report = {
  yonetici_ozeti: "Doğrulanmış özet.",
  degerlendirme: {
    finansal_performans: "Finansal değerlendirme.",
    stok_ve_operasyon: "Operasyon değerlendirmesi.",
    urun_ve_portfoy: "Portföy değerlendirmesi.",
  },
  aksiyon_onerileri: [],
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/analyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadErpData).mockResolvedValue(ingestion());
    vi.mocked(generateGeminiReport).mockResolvedValue({ report, model: "test-model" });
  });

  it("bozuk JSON ve fazla alanı 400 ile reddeder", async () => {
    const malformed = await POST(new Request("http://localhost/api/analyze", {
      method: "POST",
      body: "{",
    }));
    const extraField = await POST(jsonRequest({ scope: "ALL", rawCsv: "secret" }));

    expect(malformed.status).toBe(400);
    expect(extraField.status).toBe(400);
    expect(generateGeminiReport).not.toHaveBeenCalled();
  });

  it("temiz veride bulunmayan dönemi modele göndermeden reddeder", async () => {
    const response = await POST(jsonRequest({ scope: "2099-01" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ availablePeriods: ["2025-01"] });
    expect(generateGeminiReport).not.toHaveBeenCalled();
  });

  it("boş temiz veri için AI çağrısını başlatmaz", async () => {
    vi.mocked(loadErpData).mockResolvedValue(ingestion(-1));
    const response = await POST(jsonRequest({ scope: "ALL" }));
    expect(response.status).toBe(422);
    expect(generateGeminiReport).not.toHaveBeenCalled();
  });

  it("başarılı yanıta veri sürümü ve nesnel dahil oranını ekler", async () => {
    const source = ingestion();
    vi.mocked(loadErpData).mockResolvedValue(source);
    const response = await POST(jsonRequest({ scope: "ALL" }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      scope: "ALL",
      dataVersion: source.dataVersion,
      model: "test-model",
      dataQuality: { inclusionRate: 100, usedRows: 1, quarantinedRows: 0 },
    });
  });

  it("eksik anahtar ve timeout hatalarını kullanıcıya güvenli biçimde çevirir", async () => {
    vi.mocked(generateGeminiReport).mockRejectedValueOnce(new MissingGeminiKeyError());
    const missingKey = await POST(jsonRequest({ scope: "ALL" }));
    expect(missingKey.status).toBe(503);

    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(generateGeminiReport).mockRejectedValueOnce(new Error("request timeout"));
    const timeout = await POST(jsonRequest({ scope: "ALL" }));
    expect(timeout.status).toBe(502);
    expect(await timeout.json()).toMatchObject({ error: expect.stringContaining("zaman aşımına") });
    errorLog.mockRestore();
  });
});
