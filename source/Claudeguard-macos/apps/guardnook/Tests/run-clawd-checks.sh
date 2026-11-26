#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fixture=$(mktemp -d /tmp/guardnook-clawd-checks.XXXXXX)
trap 'rm -rf "$fixture"' EXIT
swiftc -parse-as-library Sources/GuardNook/ClawdMotion.swift Tests/ClawdChecks.swift -o "$fixture/clawd-checks"
"$fixture/clawd-checks"
