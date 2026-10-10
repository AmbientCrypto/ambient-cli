import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8"));
const artifact = join(root, "dist-pack", `ambient-code-${pkg.version}.tgz`);
const verified = JSON.parse(readFileSync(artifact.replace(/\.tgz$/, ".verified.json"), "utf8"));
const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
if (verified.sha256 !== sha256)
  throw new Error("Verify the current release tarball before staging Homebrew");
writeFileSync(
  join(root, "packaging/ambient-code.rb"),
  `class AmbientCode < Formula
  desc "Terminal coding agent for the Ambient network"
  homepage "https://github.com/AmbientCrypto/ambient-cli"
  url "https://github.com/AmbientCrypto/ambient-cli/releases/download/v${pkg.version}/ambient-code-${pkg.version}.tgz"
  version "${pkg.version}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "ambient ${pkg.version}", shell_output("#{bin}/ambient --version")
    assert_match "ink@${pkg.dependencies.ink}", shell_output("#{bin}/ambient doctor --offline")
  end
end
`,
);
process.stdout.write(
  "Prepared packaging/ambient-code.rb for the tap using the verified release SHA-256\n",
);
