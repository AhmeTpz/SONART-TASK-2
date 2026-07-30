export const PRIMARY_MODEL = "gemini-3.5-flash-lite";
export const FALLBACK_MODEL = "gemini-3.1-flash-lite";

export class MissingGeminiKeyError extends Error {
  constructor() {
    super("GEMINI_API_KEY sunucu ortamında tanımlı değil.");
    this.name = "MissingGeminiKeyError";
  }
}

export function resolveGeminiApiKey(value: string | undefined): string {
  if (!value?.trim()) throw new MissingGeminiKeyError();
  return value;
}

export function isModelNotFound(error: unknown): boolean {
  const candidate = error as { status?: number; code?: number | string; message?: string };
  const status = Number(candidate?.status ?? candidate?.code);
  const message = candidate?.message ?? "";
  return status === 404 || /(?:model.*not found|not found.*model|NOT_FOUND)/i.test(message);
}

export async function callWithModelFallback<T>(
  call: (model: string) => Promise<T>,
): Promise<{ value: T; model: string }> {
  try {
    return { value: await call(PRIMARY_MODEL), model: PRIMARY_MODEL };
  } catch (error) {
    if (!isModelNotFound(error)) throw error;
    return { value: await call(FALLBACK_MODEL), model: FALLBACK_MODEL };
  }
}
