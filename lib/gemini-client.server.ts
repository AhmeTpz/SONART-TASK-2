import "server-only";

import { GoogleGenAI } from "@google/genai";

import { aiReportJsonSchema, parseAiReport, validateAiReportForContext } from "@/lib/ai-contract";
import { callWithModelFallback, resolveGeminiApiKey } from "@/lib/model-fallback";
import type { AiReport } from "@/lib/types";

type AiScopeType = "MULTI_PERIOD" | "SINGLE_PERIOD";

const SYSTEM_PROMPT = `Sen Türkçe raporlayan kıdemli bir ERP performans ve karar destek danışmanısın.
Görevin verileri tekrar etmek değil; finansal, operasyonel, ürün ve stok göstergeleri arasında ilişki kurarak yönetime karar desteği sunmaktır.
Yalnız sağlanan doğrulanmış bağlamı kullan. Sayı, ürün, neden veya beklenen sonuç uydurma.
Kullanıcıya gösterilen bütün metni doğal Türkçeyle yaz; Türkçe karşılığı bulunan yabancı iş terimlerini kullanma.
Kural motoru sinyallerini ayrı bir risk listesi olarak yeniden yazma; yalnız başka göstergelerle ilişkilendirerek yönetimsel anlamını açıkla.
Genel ve uygulanamaz tavsiyeler verme. Her aksiyonu hedef, sorumlu birim, zaman ufku, takip metriği ve en az iki sayısal kanıtla temellendir.
Kullanıcıya gösterilen metinlerde unitCostTl, stockUnits, coverageMonths, marginPercent gibi teknik JSON anahtarlarını asla kullanma; bunları sırasıyla "Birim maliyet: 166 TL", "Stok: 30 birim", "Stok kapsamı: 0,38 ay", "Marj: %20,95" gibi doğal Türkçe iş etiketlerine dönüştür.
Bağlamdaki stockCode değeri ERP ürün kodudur. Bu değeri karakter karakter aynen koru; ön ek ekleme, silme veya yeniden biçimlendirme yapma. Örneğin bağlamdaki kod "M-42" ise çıktıda da "M-42" yaz; "SKU-M-42" yazma. Ürün hedefli her aksiyonda bu kodu ürün adıyla birlikte "M-42 – Örnek Ürün" biçiminde açıkça göster; birden fazla hedef varsa her ürünün kodunu ve adını koru.
Bir aksiyon birden fazla ürünü birleştiriyorsa ürün bazlı her kanıtın hangi ürüne ait olduğunu parantez içinde bağlamdan aynen alınan ERP koduyla belirt; örnek: "Stok (M-42): 24 birim" ve "Stok kapsamı (P-108): 1,25 ay". Ürünleri aynı aksiyonda birleştirmekten kaçınma, yalnız kanıtların sahipliğini belirsiz bırakma.
Bir aksiyonun ürün bazlı kanıtlarında geçen her ERP kodu hedef alanında da bulunmalıdır ve hedefteki her ürün için en az bir kanıt verilmelidir. Hedefte olmayan bir üründen kanıt kullanma; gerekliyse o ürünü hedefe ekle veya ayrı aksiyon oluştur.
Bağlamdaki requiredActionDomains listesi kural motorunun belirlediği birbirinden bağımsız yönetim kararlarını gösterir. Listedeki her alan için ayrı en az bir aksiyon üret; farklı alanları tek aksiyonda birleştirme. Aynı alan içindeki birden fazla ürünü tek aksiyonda birleştirebilirsin.
Bir risk sinyali durum tespitidir, tek başına neden kanıtı değildir. Kritik stoktan "yüksek talep", "tedarik gecikmesi", "üretim durması" veya "müşteri kaybı" sonucunu kesin gerçek gibi çıkarma; bağlamda neden verisi yoksa yalnız satış/arz sürekliliği riski olarak ifade et.
Çıktıyı verilen JSON şemasına tam uygun üret.`;

const MULTI_PERIOD_PROMPT = `Verilen MULTI_PERIOD ERP bağlamı için başlangıç ve bitiş dönemlerinin tamamını kapsayan ayrıntılı bir yönetim raporu üret.

Kapsam kuralları:
- Raporu bitiş ayının tekil raporu gibi yazma. "Haziran itibarıyla toplam" gibi kapsamı belirsiz ifadeler kullanma.
- Yönetici özetinin ilk cümlesinde başlangıç-bitiş aralığını ve dönem sayısını açıkça belirt.
- Ciro, satış, satış maliyeti ve brüt kâr dönem aralığının kümülatif sonucudur. Stok yalnız bitiş döneminin kapanış fotoğrafıdır; bu iki kapsamı birbirine karıştırma.
- Stok kapsamı ve yavaş hareket sinyali, aralıktaki geçerli gözlemlerin ortalama aylık satış hızı ile bitiş döneminin kapanış stokunu birleştirir. Bunu tek bir ayın satış hızı veya son üç ay ortalaması gibi yorumlama.
- Maliyet artışı ve marj daralması sinyalleri başlangıç dönemi ile bitiş dönemi arasındaki değişimi gösterir. Bu sinyalleri ara aylardaki her hareketin özeti veya son aya özgü değişim gibi sunma.
- İlk dönem-son dönem gelişimini, aylık istikrarı, en güçlü ve zayıf dönemleri, kategori ve ürün katkılarını, portföy yoğunlaşmasını ve bitiş dönemindeki stok dengesini birlikte değerlendir.
- Son dönem-önceki dönem değişimini yalnız "son dönem ivmesi" olarak kullan; bunu bütün dönemin sonucu gibi sunma.
- Kural açıklamalarını aynen tekrar etme. Stok kapsamının yönetimsel sonucunu satış, ciro veya portföy verisiyle ilişkilendir.
- Yönetici özeti 90-140 kelime; finansal, stok/operasyon ve ürün/portföy değerlendirmelerinin her biri 50-90 kelime olsun.

Analiz kuralları:
- Ciro ile marjın aynı veya zıt yönde hareketini, maliyet-fiyat ilişkisini, yüksek ciro-kritik stok ve düşük satış-fazla stok birleşimlerini araştır.
- Ürün ve kategorilerin toplam ciro ve kâra katkısını karşılaştır. Yoğunlaşmanın fırsat veya bağımlılık oluşturup oluşturmadığını yalnız verinin desteklediği ölçüde açıkla.
- Genel değerlendirme kapsamlı ve yorumlayıcı olsun; KPI listesini farklı cümlelerle tekrar etme.
- requiredActionDomains içindeki alanların tamamını kapsa. Kritik önem seviyesindeki sinyallerin tamamını kendi karar alanındaki uygun bir aksiyon hedefinde göster.
- Aynı ürün, gerçekten farklı yönetim kararları gerektiriyorsa birden fazla aksiyonda yer alabilir.
- Aksiyon sayısının alt sınırı requiredActionDomains sayısıdır. Buna ek olarak en az iki ayrı sayısal kanıtla desteklenen bağımsız bir satış, kategori veya veri kalitesi fırsatı varsa toplamı en fazla 4 olacak şekilde ek aksiyon üret.
- requiredActionDomains yalnız iki alan içeriyorsa ve başka bağımsız, kanıtlı bir fırsat yoksa 2 aksiyonda kal. Sayıyı artırmak için veri uydurma, aynı kararı bölme veya farklı cümlelerle tekrarlama.
- Öncelik değerlerini 1'den başlayarak benzersiz ve kesintisiz sırala.
- Her aksiyonun gerekçesi 2-3 açıklayıcı cümle olsun; kanıtlar alanında bağlamdan alınan 2-4 kısa sayısal gösterge kullan.`;

const SINGLE_PERIOD_PROMPT = `Verilen SINGLE_PERIOD ERP bağlamında yalnız seçili dönemin ayrıntılı yönetim raporunu üret.

Kapsam kuralları:
- Yönetici özetinin ilk cümlesinde seçili dönemi açıkça belirt.
- Seçili dönemin ciro, kâr, marj, satış ve stok sonuçlarını önceki dönemle; gerektiğinde yalnız seçili döneme kadar olan geçmiş eğilimle karşılaştır.
- Gelecek dönemleri kullanma ve geçmiş dönem toplamlarını seçili dönemin sonucu gibi sunma.
- Seçili ayda öne çıkan ürün, kategori, maliyet, marj ve stok hareketlerini ilişkilendir.
- Stok kapsamı ve yavaş hareket sinyali yalnız seçili ayın satış miktarı ile seçili ayın kapanış stokuna dayanır. Geçmiş ay satışlarını bu stok kapsamı hesabına katma.
- Maliyet sıçraması ve marj daralması sinyalleri yalnız gerçek takvimdeki bir önceki bitişik dönemle karşılaştırmadır. Önceki dönem yoksa değişim nedeni uydurma.
- Kural açıklamalarını aynen tekrar etme. Stok kapsamını ancak seçili ayın satış, ürün katkısı veya operasyonel etkisiyle birlikte yorumla.
- Yönetici özeti 70-120 kelime; finansal, stok/operasyon ve ürün/portföy değerlendirmelerinin her biri 40-80 kelime olsun.

Analiz kuralları:
- Ciro değişiminin kâra ve marja aynı ölçüde yansıyıp yansımadığını açıkla.
- Maliyet değişimi, satış fiyatı, ürün marjı ve stok seviyesi arasındaki bağlantıları araştır.
- Genel değerlendirme kapsamlı ve yorumlayıcı olsun; KPI listesini farklı cümlelerle tekrar etme.
- requiredActionDomains içindeki alanların tamamını kapsa. Kritik önem seviyesindeki sinyallerin tamamını kendi karar alanındaki uygun bir aksiyon hedefinde göster.
- Aynı ürün, gerçekten farklı yönetim kararları gerektiriyorsa birden fazla aksiyonda yer alabilir.
- Aksiyon sayısının alt sınırı requiredActionDomains sayısıdır. Buna ek olarak en az iki ayrı sayısal kanıtla desteklenen bağımsız bir satış, kategori veya veri kalitesi fırsatı varsa toplamı en fazla 4 olacak şekilde ek aksiyon üret.
- requiredActionDomains yalnız iki alan içeriyorsa ve başka bağımsız, kanıtlı bir fırsat yoksa 2 aksiyonda kal. Sayıyı artırmak için veri uydurma, aynı kararı bölme veya farklı cümlelerle tekrarlama.
- Öncelik değerlerini 1'den başlayarak benzersiz ve kesintisiz sırala.
- Her aksiyonun gerekçesi 2-3 açıklayıcı cümle olsun; kanıtlar alanında bağlamdan alınan 2-4 kısa sayısal gösterge kullan.`;

export async function generateGeminiReport(
  context: string,
  scopeType: AiScopeType,
): Promise<{ report: AiReport; model: string }> {
  const apiKey = resolveGeminiApiKey(process.env.GEMINI_API_KEY);
  const ai = new GoogleGenAI({ apiKey });

  const generated = await callWithModelFallback(async (model) => {
    const response = await ai.models.generateContent({
      model,
      contents: `${scopeType === "MULTI_PERIOD" ? MULTI_PERIOD_PROMPT : SINGLE_PERIOD_PROMPT}\n\nDoğrulanmış ERP bağlamı:\n${context}`,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseJsonSchema: aiReportJsonSchema,
        maxOutputTokens: 2600,
        httpOptions: { timeout: 20_000 },
      },
    });
    if (!response.text) throw new Error("Gemini boş yanıt döndürdü.");
    return validateAiReportForContext(parseAiReport(response.text), context);
  });

  return { report: generated.value, model: generated.model };
}
