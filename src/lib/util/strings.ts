export function truncate(value: string, maxLen = 1200): string {
  if (value.length <= maxLen) {
    return value;
  }
  return `${value.slice(0, maxLen - 3)}...`;
}

export function readBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

export function slugify(raw: string, fallback = "task", maxLen = 48): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!cleaned) {
    return fallback;
  }

  if (cleaned.length <= maxLen) {
    return cleaned;
  }

  return cleaned.slice(0, maxLen).replace(/-+$/g, "") || fallback;
}
