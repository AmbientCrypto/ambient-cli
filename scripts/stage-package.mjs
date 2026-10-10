import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyExternals, verifyReleaseLock } from "./package-contract.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = process.argv[2];
if (!stage) throw new Error("A managed staging directory is required");
const pkg = JSON.parse(
  execFileSync(process.execPath, [join(root, "scripts/npm-package-json.mjs")], {
    encoding: "utf8",
  }),
);
const sourceLock = JSON.parse(readFileSync(join(root, "packaging/npm-shrinkwrap.json"), "utf8"));
const lock = {
  ...sourceLock,
  name: pkg.name,
  packages: { ...sourceLock.packages, "": { ...sourceLock.packages[""], name: pkg.name } },
};
verifyReleaseLock(pkg, lock);
const dist = join(root, "packages/cli/dist");
const metadata = readdirSync(dist).filter(
  (name) => name.endsWith(".json") && name.includes("metafile"),
);
if (!metadata.length) throw new Error("Build metadata missing; rebuild before packing");
for (const name of metadata)
  verifyExternals(pkg, JSON.parse(readFileSync(join(dist, name), "utf8")));
mkdirSync(join(stage, "dist"), { recursive: true });
for (const name of readdirSync(dist).filter((name) => name.endsWith(".js")))
  copyFileSync(join(dist, name), join(stage, "dist", name));
for (const name of ["README.md", "LICENSE", "NOTICE"])
  copyFileSync(join(root, name), join(stage, name));
writeFileSync(join(stage, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(join(stage, "npm-shrinkwrap.json"), `${JSON.stringify(lock, null, 2)}\n`);
