#!/usr/bin/env bash
# Pre-commit / pre-push scan of STAGED files for material that must not be public:
# tenant resource IDs, tenant domains, credentials, personal machine paths.
# Usage: bash tools/check-public.sh   (exit 1 on any finding)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

files=$(git diff --cached --name-only --diff-filter=ACMR)
[ -z "$files" ] && { echo "check-public: nothing staged"; exit 0; }

if echo "$files" | grep -E '^local/|\.env($|\.)|\.pem$|\.key$|\.log$' ; then
  echo "check-public: forbidden path staged"; exit 1
fi

patterns=(
  '[a-z0-9]{8,}\.feishu\.cn'                 # tenant subdomain
  'feishu\.cn/(base|app|wiki|docx)/[A-Za-z0-9]{10,}'
  '\b(tbl|fld|vew|wkf|blk)[A-Za-z0-9]{10,}\b' # Base table/field/view/workflow/dashboard IDs
  '\bcht[a-z]{2}[A-Za-z0-9]{15,}\b'           # dashboard chart IDs
  '\bcli_[a-f0-9]{12,}\b'                     # Feishu app id
  '\bou_[a-f0-9]{20,}\b'                      # open_id
  '\b(app_token|tenant_access_token|user_access_token|refresh_token)\b.{0,4}[:=].{0,4}[A-Za-z0-9_-]{16,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  '/Users/[a-z]+/'
  '/Volumes/AIMATE'
)
status=0
for p in "${patterns[@]}"; do
  if git diff --cached -U0 --diff-filter=ACMR -- . ':!tools/check-public.sh' | grep -E '^\+' | grep -nE -- "$p" ; then
    echo "check-public: pattern matched: $p"; status=1
  fi
done
[ $status -eq 0 ] && echo "check-public: OK ($(echo "$files" | wc -l | tr -d ' ') files)"
exit $status
