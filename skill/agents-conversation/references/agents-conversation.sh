#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${OPENCLAW_AGENTS_CONVERSATION_URL:-http://127.0.0.1:29080/agents-conversation}"
CLIENT_ID="${OPENCLAW_AGENTS_CONVERSATION_CLIENT_ID:-${USER:-user}@${HOSTNAME:-localhost}}"
CLIENT_ID="${CLIENT_ID//[[:space:]]/_}"

json_escape() {
  local input="${1-}"
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import json, sys
print(json.dumps(sys.stdin.read()))
PY
    return 0
  fi
  printf '%s' "$input" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' -e ':a;N;$!ba;s/\n/\\n/g'
}

usage() {
  cat <<'EOF'
Usage:
  agents-conversation.sh agents
  agents-conversation.sh groups
  agents-conversation.sh conversations <groupId> [cursor]
  agents-conversation.sh send <groupId> <groupName> <members_csv> <senderId> <initialMessage>
  agents-conversation.sh end <groupId>
  agents-conversation.sh delete <groupId>
  agents-conversation.sh debug <groupId>

Env:
  OPENCLAW_AGENTS_CONVERSATION_URL  Base URL (default: http://127.0.0.1:29080/agents-conversation)
  OPENCLAW_AGENTS_CONVERSATION_CLIENT_ID  Stable client id for incremental conversation polling
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

cmd="$1"
shift

case "$cmd" in
  agents)
    curl -sS "${BASE_URL}/agents"
    ;;
  groups)
    curl -sS "${BASE_URL}/groups"
    ;;
  conversations)
    if [[ $# -lt 1 ]]; then
      usage
      exit 1
    fi
    group_id="$1"
    cursor="${2:-}"
    sleep 5
    url="${BASE_URL}/groups/${group_id}/conversations?clientId=${CLIENT_ID}"
    if [[ -n "${cursor}" ]]; then
      cursor="${cursor//[[:space:]]/}"
      url="${url}&cursor=${cursor}"
    fi
    curl -sS "$url"
    ;;
  send)
    if [[ $# -lt 5 ]]; then
      usage
      exit 1
    fi
    group_id="$1"
    group_name="$2"
    members_csv="$3"
    sender_id="$4"
    shift 4
    text="$*"
    IFS=',' read -ra members <<< "$members_csv"
    json_members=""
    for member in "${members[@]}"; do
      trimmed="${member//[[:space:]]/}"
      if [[ -n "$trimmed" ]]; then
        if [[ -n "$json_members" ]]; then
          json_members+=","
        fi
        json_members+="\"${trimmed}\""
      fi
    done
    group_name_json="$(printf '%s' "$group_name" | json_escape)"
    sender_id_json="$(printf '%s' "$sender_id" | json_escape)"
    text_json="$(printf '%s' "$text" | json_escape)"
    curl -sS -X POST "${BASE_URL}/groups/${group_id}/messages" \
      -H "Content-Type: application/json" \
      -d "{\"groupName\":${group_name_json},\"members\":[${json_members}],\"initialMessage\":${text_json},\"senderId\":${sender_id_json}}"
    ;;
  end)
    if [[ $# -lt 1 ]]; then
      usage
      exit 1
    fi
    group_id="$1"
    curl -sS -X POST "${BASE_URL}/groups/${group_id}/end"
    ;;
  delete)
    if [[ $# -lt 1 ]]; then
      usage
      exit 1
    fi
    group_id="$1"
    curl -sS -X POST "${BASE_URL}/groups/${group_id}/delete"
    ;;
  debug)
    if [[ $# -lt 1 ]]; then
      usage
      exit 1
    fi
    group_id="$1"
    curl -sS "${BASE_URL}/groups/${group_id}/debug"
    ;;
  *)
    usage
    exit 1
    ;;
esac
