export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

type ParsedLine = {
  indent: number;
  content: string;
  lineNo: number;
};

export function parseSimpleYaml(input: string): YamlValue {
  const lines = preprocess(input);
  if (lines.length === 0) {
    return {};
  }

  if (lines[0].indent !== 0) {
    throw new Error(`YAML root must start at indentation 0 (line ${lines[0].lineNo}).`);
  }

  const [value, nextIndex] = parseBlock(lines, 0, 0);
  if (nextIndex !== lines.length) {
    const next = lines[nextIndex];
    throw new Error(`Unexpected YAML content at line ${next.lineNo}.`);
  }

  return value;
}

function preprocess(input: string): ParsedLine[] {
  const rawLines = input.split(/\r?\n/);
  const lines: ParsedLine[] = [];

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";

    if (raw.includes("\t")) {
      throw new Error(`Tabs are not supported in YAML indentation (line ${i + 1}).`);
    }

    const withoutComment = stripComment(raw).replace(/\s+$/, "");
    if (!withoutComment.trim()) {
      continue;
    }

    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const content = withoutComment.slice(indent);
    lines.push({ indent, content, lineNo: i + 1 });
  }

  return lines;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (char === "#" && !inSingle && !inDouble) {
      const previous = i === 0 ? " " : (line[i - 1] ?? " ");
      if (/\s/.test(previous)) {
        return line.slice(0, i);
      }
    }
  }

  return line;
}

function parseBlock(lines: ParsedLine[], index: number, indent: number): [YamlValue, number] {
  if (index >= lines.length) {
    return [{}, index];
  }

  const line = lines[index];
  if (!line || line.indent !== indent) {
    throw new Error(`Unexpected indentation at line ${line?.lineNo ?? "?"}.`);
  }

  if (line.content === "-" || line.content.startsWith("- ")) {
    return parseList(lines, index, indent);
  }

  return parseMap(lines, index, indent);
}

function parseList(lines: ParsedLine[], startIndex: number, indent: number): [YamlValue[], number] {
  const result: YamlValue[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      break;
    }

    if (line.indent < indent) {
      break;
    }

    if (line.indent > indent) {
      throw new Error(`Unexpected indentation in list at line ${line.lineNo}.`);
    }

    if (!(line.content === "-" || line.content.startsWith("- "))) {
      break;
    }

    const remainder = line.content === "-" ? "" : line.content.slice(1).trimStart();
    index += 1;

    if (!remainder) {
      const next = lines[index];
      if (!next || next.indent <= indent) {
        result.push(null);
        continue;
      }

      const [child, nextIndex] = parseBlock(lines, index, next.indent);
      result.push(child);
      index = nextIndex;
      continue;
    }

    const inlinePair = parseInlinePair(remainder);
    if (!inlinePair) {
      result.push(parseScalar(remainder));
      continue;
    }

    const obj: Record<string, YamlValue> = {};
    obj[inlinePair.key] = inlinePair.value === "" ? null : parseScalar(inlinePair.value);

    const next = lines[index];
    if (next && next.indent > indent) {
      const [extra, nextIndex] = parseBlock(lines, index, next.indent);
      if (Array.isArray(extra) || extra === null || typeof extra !== "object") {
        throw new Error(`Expected mapping for list item continuation at line ${next.lineNo}.`);
      }
      for (const [key, value] of Object.entries(extra)) {
        obj[key] = value;
      }
      index = nextIndex;
    }

    result.push(obj);
  }

  return [result, index];
}

function parseMap(lines: ParsedLine[], startIndex: number, indent: number): [Record<string, YamlValue>, number] {
  const result: Record<string, YamlValue> = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!line) {
      break;
    }

    if (line.indent < indent) {
      break;
    }

    if (line.indent > indent) {
      throw new Error(`Unexpected indentation in map at line ${line.lineNo}.`);
    }

    if (line.content === "-" || line.content.startsWith("- ")) {
      break;
    }

    const pair = parseRequiredPair(line.content, line.lineNo);
    index += 1;

    if (pair.value === "") {
      const next = lines[index];
      if (!next || next.indent <= indent) {
        result[pair.key] = null;
      } else {
        const [child, nextIndex] = parseBlock(lines, index, next.indent);
        result[pair.key] = child;
        index = nextIndex;
      }
      continue;
    }

    result[pair.key] = parseScalar(pair.value);
  }

  return [result, index];
}

function parseInlinePair(text: string): { key: string; value: string } | null {
  const idx = text.indexOf(":");
  if (idx <= 0) {
    return null;
  }

  const nextChar = text[idx + 1];
  if (nextChar !== undefined && !/\s/.test(nextChar)) {
    return null;
  }

  const key = text.slice(0, idx).trim();
  if (!key) {
    return null;
  }

  const value = text.slice(idx + 1).trim();
  return { key, value };
}

function parseRequiredPair(text: string, lineNo: number): { key: string; value: string } {
  const pair = parseInlinePair(text);
  if (!pair) {
    throw new Error(`Expected "key: value" mapping syntax at line ${lineNo}.`);
  }
  return pair;
}

function parseScalar(raw: string): YamlScalar {
  const value = raw.trim();

  if (value === "null" || value === "~") {
    return null;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
