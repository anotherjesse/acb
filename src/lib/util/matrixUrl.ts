export function normalizeHomeserverUrl(raw: string): string {
  const parsed = new URL(raw);
  parsed.hash = "";
  parsed.search = "";

  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/_matrix\/static$/i, "");
  pathname = pathname.replace(/\/_matrix\/client(?:\/v\d+)?$/i, "");

  parsed.pathname = pathname || "/";
  return parsed.toString().replace(/\/$/, "");
}
