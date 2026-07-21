export function normalizeLabel(value: string): string {
  return value.trim().normalize("NFC");
}

export function normalizeLabelKey(value: string): string {
  return normalizeLabel(value).toUpperCase().toLowerCase();
}
