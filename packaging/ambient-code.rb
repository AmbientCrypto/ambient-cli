class AmbientCode < Formula
  desc "Terminal coding agent for the Ambient network"
  homepage "https://github.com/AmbientCrypto/ambient-cli"
  url "https://github.com/AmbientCrypto/ambient-cli/releases/download/v1.0.4/ambient-code-1.0.4.tgz"
  version "1.0.4"
  sha256 "1ddca384c85a29b4efa6cc077749ef74b4e0c7c8edc2613156a613c1a344568b"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "ambient 1.0.4", shell_output("#{bin}/ambient --version")
    assert_match "ink@8.0.0", shell_output("#{bin}/ambient doctor --offline")
  end
end
