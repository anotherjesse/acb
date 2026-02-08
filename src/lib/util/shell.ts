export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function toBashExports(entries: Record<string, string | undefined>): string {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(entries)) {
    if (raw === undefined) {
      continue;
    }
    lines.push(`export ${key}=${shellEscape(raw)}`);
  }
  return lines.join("; ");
}
