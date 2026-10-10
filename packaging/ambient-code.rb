class AmbientCode < Formula
  desc "Terminal coding agent for the Ambient network"
  homepage "https://github.com/AmbientCrypto/ambient-cli"
  url "https://github.com/AmbientCrypto/ambient-cli/releases/download/v1.0.4/ambient-code-1.0.4.tgz"
  version "1.0.4"
  sha256 "3b39e5bb95267f8da3e7b8087cc4e2820a3050c3c917c10d3ac4523f45a0d38f"
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
