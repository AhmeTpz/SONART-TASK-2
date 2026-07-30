import Papa from "papaparse";

import { AmbiguousEncodingError, detectAndDecode, repairMojibake } from "@/lib/encoding";
import type {
  AuditIssue,
  ErpRow,
  IngestionResult,
  ReportProfile,
} from "@/lib/types";

type CanonicalRow<T> = T & { __sourceRow: number };

export class IngestionError extends Error {
  constructor(
    message: string,
    public readonly issues: AuditIssue[],
  ) {
    super(message);
    this.name = "IngestionError";
  }
}

export function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

function issueId(issues: AuditIssue[]): string {
  return `AUD-${String(issues.length + 1).padStart(4, "0")}`;
}

function addIssue(issues: AuditIssue[], issue: Omit<AuditIssue, "id">): void {
  issues.push({ id: issueId(issues), ...issue });
}

function parsePeriod(value: string): string | null {
  const match = /^(\d{4})[-/.](\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

export function periodIndex(period: string): number {
  const [year, month] = period.split("-").map(Number);
  return year * 12 + month - 1;
}

function periodFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseLocaleNumber(value: string, integer = false): number | null {
  let normalized = value
    .normalize("NFC")
    .trim()
    .replace(/[₺]|\bTL\b/gi, "")
    .replace(/[\u00A0\u202F\s]/g, "");
  if (!normalized || /^(?:nan|[-+]?infinity)$/i.test(normalized)) return null;

  let negative = false;
  if (/^\(.+\)$/.test(normalized)) {
    negative = true;
    normalized = normalized.slice(1, -1);
  }

  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : ".";
    const grouping = decimal === "," ? /\./g : /,/g;
    normalized = normalized.replace(grouping, "").replace(decimal, ".");
  } else if (comma >= 0) {
    const grouped = /^[-+]?\d{1,3}(?:,\d{3})+$/.test(normalized);
    normalized = grouped ? normalized.replace(/,/g, "") : normalized.replace(",", ".");
  } else if (dot >= 0) {
    const grouped = /^[-+]?\d{1,3}(?:\.\d{3})+$/.test(normalized);
    normalized = grouped ? normalized.replace(/\./g, "") : normalized;
  }

  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized) * (negative ? -1 : 1);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) return null;
  return parsed;
}

function normalizeText(
  raw: string,
  field: string,
  sourceRow: number,
  dictionary: Record<string, string> | undefined,
  issues: AuditIssue[],
): string {
  let value = raw.normalize("NFC");
  const original = value;
  value = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value !== original) {
    addIssue(issues, {
      code: "TEXT_NORMALIZED",
      category: "TEXT",
      outcome: "AUTO_FIXED",
      confidence: "HIGH",
      message: "Görünmez karakterler ve gereksiz boşluklar temizlendi.",
      sourceRows: [sourceRow],
      field,
      before: original,
      after: value,
      method: "unicode-nfc-control-whitespace",
    });
  }

  const repaired = repairMojibake(value);
  if (repaired.repaired) {
    addIssue(issues, {
      code: "MOJIBAKE_REPAIRED",
      category: "ENCODING",
      outcome: "AUTO_FIXED",
      confidence: "HIGH",
      message: "Geri döndürülebilir UTF-8 mojibake bozulması onarıldı.",
      sourceRows: [sourceRow],
      field,
      before: value,
      after: repaired.value,
      method: "legacy-codepage-to-utf8-roundtrip",
    });
    value = repaired.value;
  }

  const dictionaryValue = dictionary?.[value.toLocaleLowerCase("tr-TR")];
  if (dictionaryValue && dictionaryValue !== value) {
    addIssue(issues, {
      code: "MASTER_DATA_MATCH",
      category: "TEXT",
      outcome: "AUTO_FIXED",
      confidence: "HIGH",
      message: "Değer, profil master-data sözlüğüyle eşleştirildi.",
      sourceRows: [sourceRow],
      field,
      before: value,
      after: dictionaryValue,
      method: "profile-master-data",
    });
    value = dictionaryValue;
  }
  return value;
}

function canonicalHash(row: Record<string, unknown>, fields: string[]): string {
  return JSON.stringify(fields.map((field) => row[field]));
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function createDataVersion<T extends Record<string, unknown>>(
  rows: CanonicalRow<T>[],
  quarantinedRows: IngestionResult<T>["quarantinedRows"],
  issues: AuditIssue[],
  profile: ReportProfile<T>,
): string {
  const fields = Object.keys(profile.fields);
  const signature = stableSerialize({
    profile: `${profile.id}@${profile.version}`,
    rows: rows.map((row) => canonicalHash(row, fields)).sort(),
    quarantined: quarantinedRows
      .map((row) => stableSerialize({
        reasons: row.reasons.slice().sort(),
        values: canonicalHash(row.row as Record<string, unknown>, fields),
      }))
      .sort(),
    issues: issues
      .map((issue) => stableSerialize([
        issue.code,
        issue.outcome,
        issue.field ?? null,
        issue.before ?? null,
        issue.after ?? null,
      ]))
      .sort(),
  });
  return `${profile.id}@${profile.version}:${stableHash(signature)}`;
}

function auditGroupConsistency<T extends Record<string, unknown>>(
  rows: CanonicalRow<T>[],
  profile: ReportProfile<T>,
  issues: AuditIssue[],
): void {
  if (!profile.consistencyFields?.length) return;
  const groups = new Map<string, CanonicalRow<T>[]>();
  for (const row of rows) {
    const key = canonicalHash(row, profile.groupKey);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    for (const field of profile.consistencyFields) {
      const values = [...new Set(group.map((row) => String(row[field] ?? "")))].filter(Boolean);
      if (values.length <= 1) continue;
      addIssue(issues, {
        code: "MASTER_DATA_DRIFT",
        category: "TEXT",
        outcome: "WARNING",
        confidence: "HIGH",
        message: "Aynı ürün ve depo için dönemler arasında ana veri değişikliği bulundu.",
        sourceRows: group.map((row) => row.__sourceRow),
        field,
        before: values[0],
        after: values.slice(1),
        method: "profile-group-consistency",
        details: { values },
      });
    }
  }
}

function auditLatestPeriodCompleteness<T extends Record<string, unknown>>(
  rows: CanonicalRow<T>[],
  periods: string[],
  profile: ReportProfile<T>,
  issues: AuditIssue[],
): void {
  if (periods.length < 2) return;
  const latestPeriod = periods.at(-1)!;
  const previousPeriod = periodFromIndex(periodIndex(latestPeriod) - 1);
  if (!periods.includes(previousPeriod)) return;
  const groupLabel = (row: CanonicalRow<T>) =>
    profile.groupKey.map((field) => `${field}=${String(row[field] ?? "")}`).join(" · ");
  const previousGroups = new Set(
    rows.filter((row) => row[profile.periodField] === previousPeriod).map(groupLabel),
  );
  const latestGroups = new Set(
    rows.filter((row) => row[profile.periodField] === latestPeriod).map(groupLabel),
  );
  const missingGroups = [...previousGroups].filter((key) => !latestGroups.has(key));
  if (!missingGroups.length) return;
  addIssue(issues, {
    code: "INCOMPLETE_LATEST_PERIOD",
    category: "PERIOD",
    outcome: "WARNING",
    confidence: "HIGH",
    message: `${latestPeriod} döneminde önceki dönemde bulunan ${missingGroups.length} ürün/depo kaydı yok; son dönem stok fotoğrafı eksik olabilir.`,
    sourceRows: [],
    method: "previous-period-group-coverage",
    details: {
      latestPeriod,
      previousPeriod,
      previousGroupCount: previousGroups.size,
      latestGroupCount: latestGroups.size,
      missingGroupCount: missingGroups.length,
      missingGroups,
    },
  });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function coefficientOfVariation(values: number[]): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  if (Math.abs(mean) < 1e-9) return deviation < 1e-9 ? 0 : Number.POSITIVE_INFINITY;
  return deviation / Math.abs(mean);
}

interface TemporalEstimate {
  value: number;
  method: "stable-median" | "linear-time-interpolation";
  observations: number;
  coefficientOfVariation: number;
}

function estimateTemporalValue<T extends Record<string, unknown>>(
  group: CanonicalRow<T>[],
  rowIndex: number,
  field: string,
  profile: ReportProfile<T>,
): TemporalEstimate | null {
  const policy = profile.inventoryBridge;
  if (!policy) return null;
  const observed = group.map((row) => row[field]).filter(finiteNumber);
  const variation = coefficientOfVariation(observed);
  if (
    observed.length >= policy.minStableObservations &&
    variation <= policy.stableCoefficientOfVariation
  ) {
    return {
      value: median(observed),
      method: "stable-median",
      observations: observed.length,
      coefficientOfVariation: variation,
    };
  }

  let previousIndex = rowIndex - 1;
  while (previousIndex >= 0 && !finiteNumber(group[previousIndex][field])) previousIndex -= 1;
  let nextIndex = rowIndex + 1;
  while (nextIndex < group.length && !finiteNumber(group[nextIndex][field])) nextIndex += 1;
  if (previousIndex < 0 || nextIndex >= group.length) return null;

  const previousValue = group[previousIndex][field] as number;
  const nextValue = group[nextIndex][field] as number;
  const previousPeriod = periodIndex(String(group[previousIndex][profile.periodField]));
  const nextPeriod = periodIndex(String(group[nextIndex][profile.periodField]));
  const currentPeriod = periodIndex(String(group[rowIndex][profile.periodField]));
  if (nextPeriod <= previousPeriod) return null;
  const ratio = (currentPeriod - previousPeriod) / (nextPeriod - previousPeriod);
  return {
    value: previousValue + (nextValue - previousValue) * ratio,
    method: "linear-time-interpolation",
    observations: observed.length,
    coefficientOfVariation: variation,
  };
}

function markEstimated(row: Record<string, unknown>, field: string): void {
  const current = Array.isArray(row.__estimatedFields)
    ? (row.__estimatedFields as string[])
    : [];
  if (!current.includes(field)) current.push(field);
  row.__estimatedFields = current;
}

function imputeInventoryBridge<T extends Record<string, unknown>>(
  rows: CanonicalRow<T>[],
  profile: ReportProfile<T>,
  issues: AuditIssue[],
): void {
  const policy = profile.inventoryBridge;
  if (!policy) return;
  const { inputField, outputField, stockField } = policy;
  const groups = new Map<string, CanonicalRow<T>[]>();
  for (const row of rows) {
    const key = canonicalHash(row, profile.groupKey);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        periodIndex(String(a[profile.periodField])) -
        periodIndex(String(b[profile.periodField])),
    );
    const anchorIndexes = group
      .map((row, index) => (finiteNumber(row[stockField]) ? index : -1))
      .filter((index) => index >= 0);

    for (let anchor = 1; anchor < anchorIndexes.length; anchor += 1) {
      const previousIndex = anchorIndexes[anchor - 1];
      const nextIndex = anchorIndexes[anchor];
      const internalGapCount = nextIndex - previousIndex - 1;
      if (internalGapCount > policy.maxGapPeriods) continue;
      const segmentIndexes = Array.from(
        { length: nextIndex - previousIndex },
        (_, offset) => previousIndex + offset + 1,
      );
      const hasMissingValue = segmentIndexes.some(
        (index) =>
          !finiteNumber(group[index][inputField]) ||
          !finiteNumber(group[index][outputField]) ||
          (index < nextIndex && !finiteNumber(group[index][stockField])),
      );
      if (!hasMissingValue) continue;

      const proposals = new Map<
        number,
        {
          input: number;
          output: number;
          inputEstimate: TemporalEstimate | null;
          outputEstimate: TemporalEstimate | null;
          inputImputed: boolean;
          outputImputed: boolean;
        }
      >();
      let unresolved = false;
      for (const index of segmentIndexes) {
        const row = group[index];
        const inputImputed = !finiteNumber(row[inputField]);
        const outputImputed = !finiteNumber(row[outputField]);
        const inputEstimate = inputImputed
          ? estimateTemporalValue(group, index, inputField, profile)
          : null;
        const outputEstimate = outputImputed
          ? estimateTemporalValue(group, index, outputField, profile)
          : null;
        const input = inputImputed ? inputEstimate?.value : (row[inputField] as number);
        const output = outputImputed ? outputEstimate?.value : (row[outputField] as number);
        if (!finiteNumber(input) || !finiteNumber(output)) {
          unresolved = true;
          break;
        }
        proposals.set(index, {
          input,
          output,
          inputEstimate,
          outputEstimate,
          inputImputed,
          outputImputed,
        });
      }
      if (unresolved) continue;

      const previousStock = group[previousIndex][stockField] as number;
      const nextStock = group[nextIndex][stockField] as number;
      const requiredNetMovement = nextStock - previousStock;
      const priorNetMovement = [...proposals.values()].reduce(
        (sum, proposal) => sum + proposal.input - proposal.output,
        0,
      );
      const reconciliationResidual = requiredNetMovement - priorNetMovement;
      const adjustableOutputs = [...proposals.entries()].filter(
        ([, proposal]) => proposal.outputImputed,
      );
      const adjustableInputs = [...proposals.entries()].filter(
        ([, proposal]) => proposal.inputImputed,
      );

      let adjustmentFailed = false;
      if (Math.abs(reconciliationResidual) > 1e-9) {
        if (adjustableOutputs.length) {
          const perRowAdjustment = -reconciliationResidual / adjustableOutputs.length;
          for (const [, proposal] of adjustableOutputs) {
            const adjusted = proposal.output + perRowAdjustment;
            const ratio = Math.abs(perRowAdjustment) / Math.max(Math.abs(proposal.output), 1);
            if (adjusted < 0 || ratio > policy.maxReconciliationAdjustmentRatio) {
              adjustmentFailed = true;
              break;
            }
            proposal.output = adjusted;
          }
        } else if (adjustableInputs.length) {
          const perRowAdjustment = reconciliationResidual / adjustableInputs.length;
          for (const [, proposal] of adjustableInputs) {
            const adjusted = proposal.input + perRowAdjustment;
            const ratio = Math.abs(perRowAdjustment) / Math.max(Math.abs(proposal.input), 1);
            if (adjusted < 0 || ratio > policy.maxReconciliationAdjustmentRatio) {
              adjustmentFailed = true;
              break;
            }
            proposal.input = adjusted;
          }
        } else {
          adjustmentFailed = true;
        }
      }

      const reconciledNet = [...proposals.values()].reduce(
        (sum, proposal) => sum + proposal.input - proposal.output,
        0,
      );
      if (adjustmentFailed || Math.abs(reconciledNet - requiredNetMovement) > 1e-6) {
        addIssue(issues, {
          code: "INVENTORY_BRIDGE_CONFLICT",
          category: "IMPUTATION",
          outcome: "WARNING",
          confidence: "HIGH",
          message: "Eksik akışlar stok köprüsüyle güven sınırları içinde uzlaştırılamadı.",
          sourceRows: segmentIndexes.map((index) => group[index].__sourceRow),
          method: "inventory-bridge-validation",
          details: { requiredNetMovement, priorNetMovement, reconciliationResidual },
        });
        continue;
      }

      let runningStock = previousStock;
      for (const index of segmentIndexes) {
        const row = group[index];
        const proposal = proposals.get(index)!;
        runningStock += proposal.input - proposal.output;
        if (proposal.inputImputed) {
          row[inputField as keyof CanonicalRow<T>] = proposal.input as CanonicalRow<T>[keyof CanonicalRow<T>];
          markEstimated(row, inputField);
          addIssue(issues, {
            code: "INVENTORY_INPUT_ESTIMATED",
            category: "IMPUTATION",
            outcome: "AUTO_FIXED",
            confidence:
              proposal.inputEstimate?.method === "stable-median" ? "HIGH" : "MEDIUM",
            message: "Eksik giriş miktarı ürün ve depo hareketlerine göre tahmin edildi.",
            sourceRows: [row.__sourceRow],
            field: inputField,
            before: null,
            after: proposal.input,
            method: proposal.inputEstimate?.method,
            details: proposal.inputEstimate
              ? { ...proposal.inputEstimate }
              : undefined,
          });
        }
        if (proposal.outputImputed) {
          const prior = proposal.outputEstimate?.value;
          row[outputField as keyof CanonicalRow<T>] = proposal.output as CanonicalRow<T>[keyof CanonicalRow<T>];
          markEstimated(row, outputField);
          addIssue(issues, {
            code: "INVENTORY_OUTPUT_RECONCILED",
            category: "IMPUTATION",
            outcome: "AUTO_FIXED",
            confidence: "MEDIUM",
            message: "Eksik çıkış miktarı dönemler arası stok sürekliliği korunarak tamamlandı.",
            sourceRows: [row.__sourceRow],
            field: outputField,
            before: null,
            after: proposal.output,
            method: "inventory-bridge-reconciliation",
            details: {
              temporalPrior: prior,
              requiredNetMovement,
              reconciliationAdjustment:
                prior === undefined ? null : proposal.output - prior,
            },
          });
        }
        if (index < nextIndex && !finiteNumber(row[stockField])) {
          row[stockField as keyof CanonicalRow<T>] = runningStock as CanonicalRow<T>[keyof CanonicalRow<T>];
          markEstimated(row, stockField);
          addIssue(issues, {
            code: "INVENTORY_STOCK_DERIVED",
            category: "IMPUTATION",
            outcome: "AUTO_FIXED",
            confidence: "MEDIUM",
            message: "Eksik dönem sonu stok, doğrulanmış giriş ve çıkış hareketlerinden hesaplandı.",
            sourceRows: [row.__sourceRow],
            field: stockField,
            before: null,
            after: runningStock,
            method: "inventory-roll-forward",
            details: {
              previousStock,
              estimatedInput: proposal.input,
              reconciledOutput: proposal.output,
              sourceReported: false,
            },
          });
        }
      }
    }

    for (const row of group) {
      for (const field of [inputField, outputField, stockField]) {
        if (!finiteNumber(row[field])) {
          addIssue(issues, {
            code: "UNRESOLVED_INVENTORY_VALUE",
            category: "IMPUTATION",
            outcome: "WARNING",
            confidence: "HIGH",
            message: "Stok hareketi için gerekli değer güvenli bir stok köprüsüyle türetilemedi.",
            sourceRows: [row.__sourceRow],
            field,
          });
        }
      }
    }
  }
}

function impute<T extends Record<string, unknown>>(
  rows: CanonicalRow<T>[],
  profile: ReportProfile<T>,
  issues: AuditIssue[],
): void {
  const groups = new Map<string, CanonicalRow<T>[]>();
  for (const row of rows) {
    const key = canonicalHash(row, profile.groupKey);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        periodIndex(String(a[profile.periodField])) -
        periodIndex(String(b[profile.periodField])),
    );
    for (let index = 1; index < group.length; index += 1) {
      const previousPeriod = periodIndex(String(group[index - 1][profile.periodField]));
      const currentPeriod = periodIndex(String(group[index][profile.periodField]));
      if (currentPeriod - previousPeriod > 1) {
        const missingPeriods = Array.from(
          { length: currentPeriod - previousPeriod - 1 },
          (_, offset) => periodFromIndex(previousPeriod + offset + 1),
        );
        addIssue(issues, {
          code: "MISSING_PERIOD_ROW",
          category: "PERIOD",
          outcome: "WARNING",
          confidence: "HIGH",
          message: "Grup takviminde eksik dönem satırı tespit edildi; pasiflik ihtimali nedeniyle satır üretilmedi.",
          sourceRows: [group[index - 1].__sourceRow, group[index].__sourceRow],
          method: "calendar-gap-detection",
          details: { missingPeriods },
        });
      }
    }
    for (const [field, policy] of Object.entries(profile.imputation)) {
      if (!policy) continue;
      let cursor = 0;
      while (cursor < group.length) {
        if (group[cursor][field] !== null && group[cursor][field] !== undefined) {
          cursor += 1;
          continue;
        }
        const start = cursor;
        while (
          cursor < group.length &&
          (group[cursor][field] === null || group[cursor][field] === undefined)
        ) {
          cursor += 1;
        }
        const end = cursor - 1;
        const gapLength = end - start + 1;
        const previous = start > 0 ? group[start - 1] : null;
        const next = cursor < group.length ? group[cursor] : null;

        if (gapLength > policy.maxGapPeriods) continue;
        if (policy.method === "linear" && previous && next) {
          const previousValue = previous[field];
          const nextValue = next[field];
          if (typeof previousValue !== "number" || typeof nextValue !== "number") continue;
          const previousPeriod = periodIndex(String(previous[profile.periodField]));
          const nextPeriod = periodIndex(String(next[profile.periodField]));
          if (nextPeriod - previousPeriod !== gapLength + 1) continue;
          for (let index = start; index <= end; index += 1) {
            const currentPeriod = periodIndex(String(group[index][profile.periodField]));
            const ratio = (currentPeriod - previousPeriod) / (nextPeriod - previousPeriod);
            const result = previousValue + (nextValue - previousValue) * ratio;
            group[index][field as keyof CanonicalRow<T>] = result as CanonicalRow<T>[keyof CanonicalRow<T>];
            addIssue(issues, {
              code: "VALUE_INTERPOLATED",
              category: "IMPUTATION",
              outcome: "AUTO_FIXED",
              confidence: "HIGH",
              message: "Kısa iç boşluk iki takvim komşusu arasında doğrusal tamamlandı.",
              sourceRows: [group[index].__sourceRow],
              field,
              before: null,
              after: result,
              method: "linear-interpolation",
              details: {
                previous: { period: previous[profile.periodField], value: previousValue },
                next: { period: next[profile.periodField], value: nextValue },
              },
            });
          }
        } else if (policy.method === "edge-fill") {
          const source = previous ?? next;
          const value = source?.[field];
          if (!source || typeof value !== "number") continue;
          for (let index = start; index <= end; index += 1) {
            group[index][field as keyof CanonicalRow<T>] = value as CanonicalRow<T>[keyof CanonicalRow<T>];
            addIssue(issues, {
              code: "VALUE_EDGE_FILLED",
              category: "IMPUTATION",
              outcome: "AUTO_FIXED",
              confidence: "MEDIUM",
              message: "Profilin izin verdiği kısa fiyat boşluğu komşu değerle tamamlandı.",
              sourceRows: [group[index].__sourceRow],
              field,
              before: null,
              after: value,
              method: previous ? "forward-fill" : "backward-fill",
              details: { sourcePeriod: source[profile.periodField] },
            });
          }
        }
      }
    }
  }
}

export function ingestCsv<T extends Record<string, unknown>>(
  buffer: Buffer,
  profile: ReportProfile<T>,
): IngestionResult<T> {
  const issues: AuditIssue[] = [];
  const headerHints = Object.values(profile.fields).flatMap((field) => field.aliases);
  let decoded: ReturnType<typeof detectAndDecode>;
  try {
    decoded = detectAndDecode(buffer, headerHints);
  } catch (error) {
    if (error instanceof AmbiguousEncodingError) {
      addIssue(issues, {
        code: "AMBIGUOUS_ENCODING",
        category: "ENCODING",
        outcome: "QUARANTINED",
        confidence: "LOW",
        message: error.message,
        sourceRows: [],
        details: { candidates: error.candidates },
      });
    }
    throw new IngestionError("CSV dosyası güvenle çözümlenemedi.", issues);
  }

  addIssue(issues, {
    code: "ENCODING_SELECTED",
    category: "ENCODING",
    outcome: "AUTO_FIXED",
    confidence: decoded.detection.confidence >= 0.8 ? "HIGH" : "MEDIUM",
    message: `${decoded.detection.encoding} encoding seçildi.`,
    sourceRows: [],
    after: decoded.detection.encoding,
    method: "candidate-scoring",
    details: { confidence: decoded.detection.confidence, candidates: decoded.detection.candidates },
  });

  const parsed = Papa.parse<string[]>(decoded.text, {
    delimiter: "",
    skipEmptyLines: "greedy",
  });
  parsed.errors.forEach((error) => {
    addIssue(issues, {
      code: "CSV_PARSE_ERROR",
      category: "SCHEMA",
      outcome: "WARNING",
      confidence: "HIGH",
      message: `CSV parse uyarısı: ${error.message}`,
      sourceRows: error.row === undefined ? [] : [error.row + 1],
      details: { type: error.type, parserCode: error.code },
    });
  });
  if (parsed.data.length < 2) {
    throw new IngestionError("CSV başlık veya veri satırı içermiyor.", issues);
  }

  const rawHeaders = parsed.data[0];
  const headerToIndex = new Map(rawHeaders.map((header, index) => [normalizeHeader(header), index]));
  const canonicalHeaderMap = new Map<string, number>();
  const knownHeaderIndexes = new Set<number>();

  for (const [field, definition] of Object.entries(profile.fields)) {
    const found = definition.aliases
      .map(normalizeHeader)
      .map((alias) => headerToIndex.get(alias))
      .find((index) => index !== undefined);
    if (found === undefined) {
      if (definition.required) {
        addIssue(issues, {
          code: "MISSING_REQUIRED_COLUMN",
          category: "SCHEMA",
          outcome: "QUARANTINED",
          confidence: "HIGH",
          message: `Zorunlu ${field} kolonu bulunamadı.`,
          sourceRows: [],
          field,
        });
      }
    } else {
      canonicalHeaderMap.set(field, found);
      knownHeaderIndexes.add(found);
    }
  }
  if (issues.some((issue) => issue.code === "MISSING_REQUIRED_COLUMN")) {
    throw new IngestionError("CSV şeması profil ile uyumlu değil.", issues);
  }
  rawHeaders.forEach((header, index) => {
    if (!knownHeaderIndexes.has(index)) {
      addIssue(issues, {
        code: "UNEXPECTED_COLUMN",
        category: "SCHEMA",
        outcome: "WARNING",
        confidence: "HIGH",
        message: `Beklenmeyen ${header} kolonu metriklere alınmadı.`,
        sourceRows: [],
        field: header,
      });
    }
  });

  const validRows: CanonicalRow<T>[] = [];
  const quarantinedRows: IngestionResult<T>["quarantinedRows"] = [];
  const rawDataRows = parsed.data.slice(1);

  rawDataRows.forEach((values, rowIndex) => {
    const sourceRow = rowIndex + 2;
    const row: Record<string, unknown> = { __sourceRow: sourceRow };
    const reasons: string[] = [];
    for (const [field, definition] of Object.entries(profile.fields)) {
      const columnIndex = canonicalHeaderMap.get(field);
      const raw = columnIndex === undefined ? "" : String(values[columnIndex] ?? "");
      if (!raw.trim()) {
        row[field] = null;
        if (definition.required && !definition.nullable) reasons.push(`${field}: zorunlu değer eksik`);
        continue;
      }

      if (definition.type === "text") {
        row[field] = normalizeText(
          raw,
          field,
          sourceRow,
          profile.masterData[field],
          issues,
        );
      } else if (definition.type === "period") {
        const period = parsePeriod(raw);
        row[field] = period;
        if (!period) reasons.push(`${field}: geçersiz dönem (${raw})`);
      } else {
        const value = parseLocaleNumber(raw, definition.type === "integer");
        row[field] = value;
        if (value === null) {
          addIssue(issues, {
            code: "INVALID_NUMBER",
            category: "NUMBER",
            outcome: definition.required ? "QUARANTINED" : "WARNING",
            confidence: "HIGH",
            message: `${field} sayısal değeri çözümlenemedi; sıfıra çevrilmedi.`,
            sourceRows: [sourceRow],
            field,
            before: raw,
          });
          if (definition.required) reasons.push(`${field}: geçersiz sayı`);
        } else if (
          (definition.minimum !== undefined && value < definition.minimum) ||
          (definition.maximum !== undefined && value > definition.maximum)
        ) {
          addIssue(issues, {
            code: "VALUE_OUT_OF_RANGE",
            category: "NUMBER",
            outcome: "QUARANTINED",
            confidence: "HIGH",
            message: `${field} değeri profil sınırlarının dışında kaldı.`,
            sourceRows: [sourceRow],
            field,
            before: raw,
            details: { minimum: definition.minimum, maximum: definition.maximum },
          });
          reasons.push(`${field}: izin verilen aralığın dışında (${raw})`);
        }
      }
    }

    if (reasons.length) {
      addIssue(issues, {
        code: "INVALID_IDENTITY_OR_PERIOD",
        category: reasons.some((reason) => reason.includes("dönem")) ? "PERIOD" : "SCHEMA",
        outcome: "QUARANTINED",
        confidence: "HIGH",
        message: reasons.join("; "),
        sourceRows: [sourceRow],
      });
      quarantinedRows.push({ sourceRows: [sourceRow], reasons, row: row as Partial<T> });
    } else {
      validRows.push(row as CanonicalRow<T>);
    }
  });

  const fieldNames = Object.keys(profile.fields);
  const exact = new Map<string, CanonicalRow<T>>();
  const deduplicated: CanonicalRow<T>[] = [];
  for (const row of validRows) {
    const hash = canonicalHash(row, fieldNames);
    const first = exact.get(hash);
    if (first) {
      addIssue(issues, {
        code: "EXACT_DUPLICATE_REMOVED",
        category: "DUPLICATE",
        outcome: "AUTO_FIXED",
        confidence: "HIGH",
        message: "Birebir aynı satır kaldırıldı.",
        sourceRows: [first.__sourceRow, row.__sourceRow],
        method: "canonical-row-hash",
      });
    } else {
      exact.set(hash, row);
      deduplicated.push(row);
    }
  }

  const naturalGroups = new Map<string, CanonicalRow<T>[]>();
  for (const row of deduplicated) {
    const key = canonicalHash(row, profile.naturalKey);
    const group = naturalGroups.get(key) ?? [];
    group.push(row);
    naturalGroups.set(key, group);
  }
  const conflicted = new Set<CanonicalRow<T>>();
  for (const group of naturalGroups.values()) {
    if (group.length <= 1) continue;
    group.forEach((row) => conflicted.add(row));
    const sourceRows = group.map((row) => row.__sourceRow);
    addIssue(issues, {
      code: "CONFLICTING_NATURAL_KEY",
      category: "DUPLICATE",
      outcome: "QUARANTINED",
      confidence: "HIGH",
      message: "Aynı doğal anahtarda farklı içerikler bulundu; hiçbir kayıt seçilmedi.",
      sourceRows,
      method: "profile-natural-key",
    });
    group.forEach((row) =>
      quarantinedRows.push({
        sourceRows: [row.__sourceRow],
        reasons: ["Çelişkili doğal anahtar"],
        row,
      }),
    );
  }

  const cleanRows = deduplicated.filter((row) => !conflicted.has(row));
  auditGroupConsistency(cleanRows, profile, issues);
  imputeInventoryBridge(cleanRows, profile, issues);
  impute(cleanRows, profile, issues);

  for (const row of cleanRows) {
    for (const [field, policy] of Object.entries(profile.imputation)) {
      if (policy && (row[field] === null || row[field] === undefined)) {
        addIssue(issues, {
          code: "UNRESOLVED_MISSING_VALUE",
          category: "IMPUTATION",
          outcome: "WARNING",
          confidence: "HIGH",
          message: "Eksik değer profil güven sınırları içinde tamamlanamadı.",
          sourceRows: [row.__sourceRow],
          field,
        });
      }
    }
  }

  const periods = [...new Set(cleanRows.map((row) => String(row[profile.periodField])))]
    .filter(Boolean)
    .sort((a, b) => periodIndex(a) - periodIndex(b));
  auditLatestPeriodCompleteness(cleanRows, periods, profile, issues);
  const summary = {
    autoFixed: issues.filter((issue) => issue.outcome === "AUTO_FIXED").length,
    warnings: issues.filter((issue) => issue.outcome === "WARNING").length,
    quarantined: issues.filter((issue) => issue.outcome === "QUARANTINED").length,
    exactDuplicatesRemoved: issues.filter((issue) => issue.code === "EXACT_DUPLICATE_REMOVED").length,
    imputations: issues.filter((issue) => issue.category === "IMPUTATION" && issue.outcome === "AUTO_FIXED").length,
    textRepairs: issues.filter((issue) => issue.code === "MOJIBAKE_REPAIRED").length,
  };
  const inclusionRate = rawDataRows.length
    ? Math.round((cleanRows.length / rawDataRows.length) * 1_000) / 10
    : 0;

  return {
    rows: cleanRows as T[],
    quarantinedRows,
    audit: { issues, summary },
    dataVersion: createDataVersion(cleanRows, quarantinedRows, issues, profile),
    inclusionRate,
    encoding: decoded.detection,
    periods,
    periodRange: periods.length ? { from: periods[0], to: periods.at(-1)! } : null,
    profile: { id: profile.id, version: profile.version },
    counts: {
      raw: rawDataRows.length,
      used: cleanRows.length,
      quarantined: quarantinedRows.length,
    },
  };
}

export function ingestErpCsv(buffer: Buffer, profile: ReportProfile<ErpRow>): IngestionResult<ErpRow> {
  return ingestCsv(buffer, profile);
}
