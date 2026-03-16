function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (value && typeof value === 'object') {
    if (value instanceof Date) {
      return value.toISOString();
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      normalized[key] = normalizeValue(entryValue);
    }

    return normalized;
  }

  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}
