export type AuditOutcome = "AUTO_FIXED" | "WARNING" | "QUARANTINED";
export type AuditConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface AuditIssue {
  id: string;
  code: string;
  category:
    | "ENCODING"
    | "SCHEMA"
    | "TEXT"
    | "NUMBER"
    | "DUPLICATE"
    | "IMPUTATION"
    | "PERIOD";
  outcome: AuditOutcome;
  confidence: AuditConfidence;
  message: string;
  sourceRows: number[];
  field?: string;
  before?: unknown;
  after?: unknown;
  method?: string;
  details?: Record<string, unknown>;
}

export interface EncodingCandidate {
  encoding: SupportedEncoding;
  score: number;
  replacementCount: number;
  controlCount: number;
  mojibakeCount: number;
  headerMatchCount: number;
}

export type SupportedEncoding = "utf-8" | "windows-1254" | "iso-8859-9";

export interface EncodingDetection {
  encoding: SupportedEncoding;
  confidence: number;
  hadBom: boolean;
  candidates: EncodingCandidate[];
}

export interface AuditReport {
  issues: AuditIssue[];
  summary: {
    autoFixed: number;
    warnings: number;
    quarantined: number;
    exactDuplicatesRemoved: number;
    imputations: number;
    textRepairs: number;
  };
}

export interface QuarantinedRow<T> {
  sourceRows: number[];
  reasons: string[];
  row: Partial<T> | Record<string, unknown>;
}

export interface IngestionResult<T> {
  rows: T[];
  quarantinedRows: QuarantinedRow<T>[];
  audit: AuditReport;
  dataVersion: string;
  inclusionRate: number;
  encoding: EncodingDetection;
  periods: string[];
  periodRange: { from: string; to: string } | null;
  profile: { id: string; version: string };
  counts: { raw: number; used: number; quarantined: number };
}

export type FieldType = "text" | "integer" | "number" | "period";

export interface FieldDefinition {
  aliases: string[];
  type: FieldType;
  required: boolean;
  nullable?: boolean;
  minimum?: number;
  maximum?: number;
}

export type ImputationPolicy =
  | { method: "linear"; maxGapPeriods: number }
  | { method: "edge-fill"; maxGapPeriods: number };

export interface InventoryBridgePolicy<T extends Record<string, unknown>> {
  inputField: keyof T & string;
  outputField: keyof T & string;
  stockField: keyof T & string;
  maxGapPeriods: number;
  minStableObservations: number;
  stableCoefficientOfVariation: number;
  maxReconciliationAdjustmentRatio: number;
}

export interface RiskThresholds {
  criticalCoverageMonths: number;
  lowStockUnits: number;
  slowCoverageMonths: number;
  lowMarginRatio: number;
  marginDropPoints: number;
  costJumpRatio: number;
}

export interface ReportProfile<T extends Record<string, unknown>> {
  id: string;
  version: string;
  locale: string;
  fields: { [K in keyof T]?: FieldDefinition } & Record<string, FieldDefinition>;
  naturalKey: (keyof T & string)[];
  groupKey: (keyof T & string)[];
  periodField: keyof T & string;
  imputation: Partial<Record<keyof T & string, ImputationPolicy>>;
  inventoryBridge?: InventoryBridgePolicy<T>;
  masterData: Partial<Record<keyof T & string, Record<string, string>>>;
  consistencyFields?: (keyof T & string)[];
  riskThresholds: RiskThresholds;
}

export interface ErpRow extends Record<string, unknown> {
  stok_kodu: string;
  urun_adi: string;
  kategori: string;
  depo: string;
  donem: string;
  giris_miktar: number | null;
  cikis_miktar: number | null;
  donem_sonu_stok: number | null;
  birim_maliyet_tl: number | null;
  birim_satis_tl: number | null;
  __sourceRow: number;
  __estimatedFields?: string[];
}

export type RiskType =
  | "CRITICAL_STOCK"
  | "LOW_STOCK"
  | "SLOW_MOVING"
  | "LOW_MARGIN"
  | "MARGIN_DROP"
  | "COST_SPIKE";

export interface RiskItem {
  id: string;
  type: RiskType;
  severity: "critical" | "high" | "medium";
  basis: "SINGLE_PERIOD" | "MULTI_PERIOD";
  stockCode: string;
  productName: string;
  warehouse: string;
  startPeriod: string;
  period: string;
  observedPeriodCount: number;
  title: string;
  detail: string;
  metric: number;
}

export interface PeriodMetric {
  period: string;
  revenue: number;
  grossProfit: number;
  margin: number;
  stock: number;
  salesQuantity: number;
}

export interface CategoryMetric {
  category: string;
  revenue: number;
  grossProfit: number;
}

export interface ProductPeriodMetric {
  period: string;
  inputQuantity: number | null;
  salesQuantity: number | null;
  stock: number | null;
  unitCost: number | null;
  unitPrice: number | null;
  revenue: number;
  grossProfit: number;
  margin: number | null;
}

export type ProductInventoryStatus =
  | "CRITICAL"
  | "SLOW"
  | "NORMAL"
  | "NO_SALES"
  | "UNKNOWN";

export interface ProductAnalysis {
  id: string;
  stockCode: string;
  productName: string;
  category: string;
  warehouse: string;
  trend: ProductPeriodMetric[];
  totals: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    weightedMargin: number;
    inputQuantity: number;
    salesQuantity: number;
  };
  latest: {
    period: string;
    stock: number | null;
    unitCost: number | null;
    unitPrice: number | null;
    margin: number | null;
    coverageMonths: number | null;
    coverageBasis: "SELECTED_PERIOD_SALES" | "RANGE_AVERAGE_MONTHLY_SALES";
    coveragePeriodCount: number;
    inventoryStatus: ProductInventoryStatus;
  };
  changes: {
    salesRatio: number | null;
    costRatio: number | null;
    marginPoints: number | null;
    stockRatio: number | null;
  };
}

export interface DashboardAnalytics {
  selectedScope: "ALL" | string;
  periods: string[];
  activePeriod: string;
  totals: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    weightedMargin: number;
    stock: number;
    salesQuantity: number;
  };
  trend: PeriodMetric[];
  categories: CategoryMetric[];
  products: ProductAnalysis[];
  risks: RiskItem[];
}

export interface AiReport {
  yonetici_ozeti: string;
  degerlendirme: {
    finansal_performans: string;
    stok_ve_operasyon: string;
    urun_ve_portfoy: string;
  };
  aksiyon_onerileri: Array<{
    baslik: string;
    aksiyon: string;
    hedef: string;
    gerekce: string;
    sorumlu_birim: string;
    zaman_ufku: string;
    beklenen_etki: string;
    takip_metrigi: string;
    kanitlar: string[];
    oncelik: number;
  }>;
}
