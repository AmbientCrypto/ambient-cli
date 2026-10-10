import { builtinModules } from "node:module";

const equal = (left, right) =>
  JSON.stringify(Object.entries(left ?? {}).sort()) ===
  JSON.stringify(Object.entries(right ?? {}).sort());

export function verifyReleaseLock(pkg, lock) {
  const root = lock.packages?.[""];
  if (lock.name !== pkg.name || lock.version !== pkg.version || root?.version !== pkg.version)
    throw new Error("Release lock is stale; run node scripts/update-release-lock.mjs");
  if (!equal(root.engines, pkg.engines) || !equal(root.dependencies, pkg.dependencies))
    throw new Error("Release lock dependencies or engines differ from package.json");
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (
      entry.link ||
      Object.values(entry.dependencies ?? {}).some((value) =>
        String(value).startsWith("workspace:"),
      )
    )
      throw new Error(`Unpublishable dependency: ${name}`);
    if (name && (!entry.version || !entry.integrity))
      throw new Error(`Unlocked dependency: ${name}`);
  }
  for (const name of Object.keys(pkg.dependencies)) {
    if (!lock.packages[`node_modules/${name}`])
      throw new Error(`Missing locked dependency: ${name}`);
  }
}

export function verifyExternals(pkg, metadata) {
  for (const output of Object.values(metadata.outputs)) {
    for (const item of output.imports ?? []) {
      if (
        !item.external ||
        item.path.startsWith(".") ||
        item.path.startsWith("node:") ||
        builtinModules.includes(item.path)
      )
        continue;
      const name = item.path.startsWith("@")
        ? item.path.split("/").slice(0, 2).join("/")
        : item.path.split("/")[0];
      if (!pkg.dependencies[name]) throw new Error(`Undeclared runtime dependency: ${item.path}`);
    }
  }
}
