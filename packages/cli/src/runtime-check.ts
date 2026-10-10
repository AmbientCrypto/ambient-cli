declare const __AMB_MIN_NODE__: number;

export const MIN_NODE_MAJOR = typeof __AMB_MIN_NODE__ === "number" ? __AMB_MIN_NODE__ : 22;

export function unsupportedNodeMessage(version: string): string | undefined {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version);
  if (match && Number(match[1]) >= MIN_NODE_MAJOR) return undefined;
  return `Ambient requires Node ${MIN_NODE_MAJOR}+ (found ${version}). Upgrade Node, then reinstall or update Ambient using the same installation method.`;
}
