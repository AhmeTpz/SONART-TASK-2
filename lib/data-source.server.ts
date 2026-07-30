import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { ingestCsv } from "@/lib/data-pipeline";
import { erpProfile } from "@/lib/profiles/erp-profile";
import type { ErpRow, IngestionResult } from "@/lib/types";

const DATA_PATH = path.join(
  process.cwd(),
  "public",
  "data",
  "sonart_erp_cok_donemli_2.csv",
);

let cached: Promise<IngestionResult<ErpRow>> | null = null;

export function loadErpData(): Promise<IngestionResult<ErpRow>> {
  if (!cached) {
    cached = fs.readFile(DATA_PATH).then((buffer) => ingestCsv(buffer, erpProfile));
  }
  return cached;
}
