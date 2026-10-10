class AmbientCode < Formula
  desc "Terminal coding agent for the Ambient network"
  homepage "https://github.com/AmbientCrypto/ambient-cli"
  url "https://github.com/AmbientCrypto/ambient-cli/releases/download/v1.0.5/ambient-code-1.0.5.tgz"
  version "1.0.5"
  sha256 "d757d6a41885531ee4f5c7b86e863f105db968f0314bf73d6ba850f3f8ef481d"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "ambient 1.0.5", shell_output("#{bin}/ambient --version")
    assert_match "ink@8.0.0", shell_output("#{bin}/ambient doctor --offline")
  end
end
