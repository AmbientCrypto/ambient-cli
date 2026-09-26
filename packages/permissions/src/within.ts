import path from "node:path";

/**
 * Workspace containment for permission checks. Paths are resolved with the host's path rules (so `..`,
 * absolute paths and Windows drive letters all normalize) and compared structurally via `path.relative` —
 * never by string prefix, which `../` and look-alike siblings (`/w/proj-evil`) would slip past. Windows paths
 * compare case-insensitively.
 */
export function resolveResource(
  root: string,
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // Git Bash spells `C:\proj` as `/c/proj`; read it the way the file tools do.
  const m = platform === "win32" ? /^\/([A-Za-z])(\/.*)?$/.exec(p) : null;
  const native = m?.[1] ? `${m[1].toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}` : p;
  return path.resolve(root, native);
}

export function isWithinWorkspace(root: string, p: string): boolean {
  const norm = (x: string) => {
    const r = path.resolve(x);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(root), norm(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
