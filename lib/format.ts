export function formatCurrency(value: number, compact = false): string {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
    notation: compact ? "compact" : "standard",
  }).format(value);
}

export function formatCompactCurrency(value: number): string {
  const absolute = Math.abs(value);
  const unit = absolute >= 1_000_000_000_000
    ? { divisor: 1_000_000_000_000, suffix: "Tn" }
    : absolute >= 1_000_000_000
      ? { divisor: 1_000_000_000, suffix: "Mr" }
      : absolute >= 1_000_000
        ? { divisor: 1_000_000, suffix: "Mn" }
        : absolute >= 1_000
          ? { divisor: 1_000, suffix: "B" }
          : null;

  if (!unit) {
    const rounded = Math.round(absolute).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${value < 0 ? "-" : ""}₺${rounded}`;
  }

  const scaled = absolute / unit.divisor;
  const rounded = (Math.round(scaled * 10) / 10)
    .toString()
    .replace(".", ",");
  return `${value < 0 ? "-" : ""}₺${rounded} ${unit.suffix}`;
}

export function formatNumber(value: number, compact = false): string {
  return new Intl.NumberFormat("tr-TR", {
    maximumFractionDigits: 1,
    notation: compact ? "compact" : "standard",
  }).format(value);
}

export function formatPercent(value: number, fractionDigits = 1): string {
  return new Intl.NumberFormat("tr-TR", {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  if (!year || !month) return period;
  return new Intl.DateTimeFormat("tr-TR", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}
