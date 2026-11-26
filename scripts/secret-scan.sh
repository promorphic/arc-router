#!/usr/bin/env bash
# Secret scan run before every push. Scans tracked and staged files, plus the
# whole git history, for key material. Uses gitleaks when it is installed and
# always runs the pattern check below.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# 1. No env or key files tracked.
bad_files=$(git ls-files | grep -E '(^|/)\.env($|\.)|\.pem$|\.key$|\.keystore$|entity[-_]secret|recovery.*\.dat$' | grep -v '^\.env\.example$' || true)
if [ -n "$bad_files" ]; then
  echo "FAIL: secret-bearing files are tracked:"; echo "$bad_files"; fail=1
fi

# 2. Key-shaped strings in the working tree and in history.
patterns='(TEST|LIVE)_API_KEY:[0-9a-f]{16,}:[0-9a-f]{16,}|TEST_CLIENT_KEY:[0-9a-f]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(PRIVATE_KEY|ENTITY_SECRET|API_SECRET|MNEMONIC)[A-Z_]*[[:space:]]*[=:][[:space:]]*["'"'"']?[0-9A-Za-z+/ ]{24,}|gh[pousr]_[0-9A-Za-z]{30,}|AIza[0-9A-Za-z_-]{30,}'

tree_hits=$(git grep -nIE "$patterns" -- . ':!scripts/secret-scan.sh' || true)
if [ -n "$tree_hits" ]; then
  echo "FAIL: key-shaped strings in tracked files:"; echo "$tree_hits" | cut -c1-160; fail=1
fi

if git rev-parse HEAD >/dev/null 2>&1; then
  hist_hits=$(git log -p --all --no-color -- . ':!scripts/secret-scan.sh' | grep -nE "^\+.*($patterns)" || true)
  if [ -n "$hist_hits" ]; then
    echo "FAIL: key-shaped strings in git history:"; echo "$hist_hits" | cut -c1-160; fail=1
  fi
fi

# 3. A 32-byte hex literal assigned to anything named like a key (private keys are 64 hex chars;
#    transaction hashes in MILESTONES.md are allowed, so this only looks at assignments).
hex_hits=$(git grep -nIE '(key|secret|pk|mnemonic)[A-Za-z_]*["'"'"']?[[:space:]]*[=:][[:space:]]*["'"'"']?0x[0-9a-fA-F]{64}\b' -- . ':!scripts/secret-scan.sh' || true)
if [ -n "$hex_hits" ]; then
  echo "FAIL: 32-byte hex assigned to a key-like name:"; echo "$hex_hits" | cut -c1-160; fail=1
fi

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-banner --redact || fail=1
else
  echo "note: gitleaks not installed; pattern scan only"
fi

if [ "$fail" -ne 0 ]; then echo "secret scan FAILED"; exit 1; fi
echo "secret scan passed"
