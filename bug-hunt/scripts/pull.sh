#!/usr/bin/env bash
# Read agent results from a bug-hunt workflow run's journal.
#
# Usage:
#   pull.sh <runId|journal.jsonl> list                  # kind/id of every result, latest wins
#   pull.sh <runId|journal.jsonl> <kind> <id>           # latest result as JSON
#   pull.sh <runId|journal.jsonl> <kind> <id> <field>   # one field, raw (e.g. draft F05 body)
#
# Kinds: research, verify, contracts, plan, align, draft, comment, fresh, report.
# Drafts and comments are keyed by their id (the first finding id of the issue).
set -euo pipefail

src="${1:?usage: pull.sh <runId|journal> list|<kind> <id> [field]}"
if [ -f "$src" ]; then
  journal="$src"
else
  journal=$(find ~/.claude/projects -path "*/workflows/$src/journal.jsonl" 2>/dev/null | head -1)
fi
[ -n "${journal:-}" ] && [ -f "$journal" ] || { echo "journal not found for $src" >&2; exit 1; }

mode="${2:-list}"
if [ "$mode" = "list" ]; then
  jq -r 'select(.type=="result" and (.result|type)=="object" and .result.kind) | "\(.result.kind)\t\(.result.id // .result.iteration // "-")"' "$journal" \
    | awk -F'\t' '{k=$1"\t"$2; if(!(k in seen)){order[++n]=k}; seen[k]++} END{for(i=1;i<=n;i++) print order[i]"\t(x"seen[order[i]]")"}' \
    | column -t -s $'\t'
  exit 0
fi

kind="$mode"
id="${3:?id required}"
field="${4:-}"
obj=$(jq -c --arg k "$kind" --arg id "$id" \
  'select(.type=="result" and (.result|type)=="object" and .result.kind==$k and ((.result.id // "")==$id or $id=="-"))  | .result' \
  "$journal" | tail -1)
[ -n "$obj" ] || { echo "no $kind result for $id" >&2; exit 1; }

if [ -n "$field" ]; then
  jq -r --arg f "$field" '.[$f] | if type=="string" then . else tojson end' <<<"$obj"
else
  jq . <<<"$obj"
fi
