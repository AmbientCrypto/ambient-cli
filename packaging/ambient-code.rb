class AmbientCode < Formula
  desc "Terminal coding agent for the Ambient network"
  homepage "https://github.com/AmbientCrypto/ambient-cli"
  url "https://github.com/AmbientCrypto/ambient-cli/releases/download/v1.0.4/ambient-code-1.0.4.tgz"
  version "1.0.4"
  sha256 "f28e8a839ed06b843835ac50f9c4b86979da427ea0f0dfddcc74ea7368353cc4"
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
