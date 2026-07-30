import iconv from "iconv-lite";

import type {
  EncodingCandidate,
  EncodingDetection,
  SupportedEncoding,
} from "@/lib/types";

const MOJIBAKE_PATTERN = /(?:Ã.|Ä.|Å.|Â.|â€|â€™|ï»¿)/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TURKISH_PATTERN = /[İıŞşĞğÜüÖöÇç]/g;

export class AmbiguousEncodingError extends Error {
  constructor(public readonly candidates: EncodingCandidate[]) {
    super("Dosya encoding'i yeterli güvenle belirlenemedi.");
    this.name = "AmbiguousEncodingError";
  }
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function decode(buffer: Buffer, encoding: SupportedEncoding): string | null {
  if (encoding === "utf-8") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      return null;
    }
  }
  return iconv.decode(buffer, encoding);
}

function scoreText(
  text: string,
  encoding: SupportedEncoding,
  headerHints: string[],
  strictUtf8: boolean,
): EncodingCandidate {
  const replacementCount = (text.match(/�/g) ?? []).length;
  const controlCount = (text.match(CONTROL_PATTERN) ?? []).length;
  const mojibakeCount = (text.match(MOJIBAKE_PATTERN) ?? []).length;
  const turkishCount = (text.match(TURKISH_PATTERN) ?? []).length;
  const headers = (text.split(/\r?\n/, 1)[0] ?? "")
    .split(/[;,\t|]/)
    .map(normalizeHeader);
  const normalizedHints = new Set(headerHints.map(normalizeHeader));
  const headerMatchCount = headers.filter((header) => normalizedHints.has(header)).length;

  let score = headerMatchCount * 15 + Math.min(turkishCount, 20) * 0.5;
  score -= replacementCount * 100 + controlCount * 20 + mojibakeCount * 18;
  if (encoding === "utf-8" && strictUtf8) score += 40;

  return {
    encoding,
    score,
    replacementCount,
    controlCount,
    mojibakeCount,
    headerMatchCount,
  };
}

export function detectAndDecode(
  input: Buffer,
  headerHints: string[],
): { text: string; detection: EncodingDetection } {
  let buffer = input;
  let hadBom = false;
  let bomEncoding: SupportedEncoding | null = null;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    hadBom = true;
    bomEncoding = "utf-8";
    buffer = buffer.subarray(3);
  }

  const decoded = new Map<SupportedEncoding, string>();
  const strictUtf8Text = decode(buffer, "utf-8");
  if (strictUtf8Text !== null) decoded.set("utf-8", strictUtf8Text);
  decoded.set("windows-1254", decode(buffer, "windows-1254") ?? "");
  decoded.set("iso-8859-9", decode(buffer, "iso-8859-9") ?? "");

  const candidates = [...decoded.entries()]
    .map(([encoding, text]) =>
      scoreText(text, encoding, headerHints, strictUtf8Text !== null),
    )
    .sort((a, b) => b.score - a.score);

  if (bomEncoding) {
    return {
      text: decoded.get(bomEncoding)!,
      detection: { encoding: bomEncoding, confidence: 1, hadBom, candidates },
    };
  }

  const top = candidates[0];
  if (!top) throw new AmbiguousEncodingError([]);
  const topText = decoded.get(top.encoding)!;
  const runnerUp = candidates.find(
    (candidate) => decoded.get(candidate.encoding) !== topText,
  );
  const margin = runnerUp ? top.score - runnerUp.score : 100;
  const requiredMargin = strictUtf8Text !== null && top.encoding === "utf-8" ? 10 : 15;

  if (margin < requiredMargin) throw new AmbiguousEncodingError(candidates);

  return {
    text: topText,
    detection: {
      encoding: top.encoding,
      confidence: Math.max(0.5, Math.min(0.99, 0.55 + margin / 100)),
      hadBom,
      candidates,
    },
  };
}

function anomalyScore(text: string): number {
  return (
    (text.match(MOJIBAKE_PATTERN) ?? []).length * 10 +
    (text.match(/�/g) ?? []).length * 20 +
    (text.match(CONTROL_PATTERN) ?? []).length * 5
  );
}

export function repairMojibake(value: string): { value: string; repaired: boolean } {
  if (!(value.match(MOJIBAKE_PATTERN) ?? []).length) {
    return { value, repaired: false };
  }

  const candidates = ["windows-1252", "windows-1254", "iso-8859-1"]
    .map((encoding) => {
      try {
        const bytes = iconv.encode(value, encoding);
        const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return repaired;
      } catch {
        return null;
      }
    })
    .filter((candidate): candidate is string => candidate !== null);

  const best = candidates.sort((a, b) => anomalyScore(a) - anomalyScore(b))[0];
  if (best && anomalyScore(value) - anomalyScore(best) >= 10) {
    return { value: best, repaired: true };
  }
  return { value, repaired: false };
}
