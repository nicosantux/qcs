# Template for Formula/qcs.rb in the tap repository; the release workflow fills in the hashes.
class Qcs < Formula
  desc "Assign and inspect which git identity is used in each folder or repository"
  homepage "https://github.com/nicosantux/qcs"
  version "1.0.0" # x-release-please-version

  on_macos do
    on_arm do
      url "https://github.com/nicosantux/qcs/releases/download/v#{version}/qcs-darwin-arm64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_qcs-darwin-arm64.tar.gz"
    end
    on_intel do
      url "https://github.com/nicosantux/qcs/releases/download/v#{version}/qcs-darwin-x64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_qcs-darwin-x64.tar.gz"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/nicosantux/qcs/releases/download/v#{version}/qcs-linux-arm64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_qcs-linux-arm64.tar.gz"
    end
    on_intel do
      url "https://github.com/nicosantux/qcs/releases/download/v#{version}/qcs-linux-x64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_OF_qcs-linux-x64.tar.gz"
    end
  end

  def install
    bin.install "qcs"
  end

  test do
    assert_match "unknown command", shell_output("#{bin}/qcs bogus 2>&1", 64)
  end
end
