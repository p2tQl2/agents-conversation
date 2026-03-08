#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${OPENCLAW_AGENTS_CONVERSATION_URL:-http://127.0.0.1:29080/agents-conversation}"

usage() {
  cat <<'EOF'
Usage:
  agents-local-hub-api.sh agents
  agents-local-hub-api.sh groups
  agents-local-hub-api.sh conversations <groupId>
  agents-local-hub-api.sh send <groupId> <groupName> <members_csv> <senderId> <initialMessage>
  agents-local-hub-api.sh end <groupId>
  agents-local-hub-api.sh delete <groupId>
  agents-local-hub-api.sh debug <groupId>

Env:
  OPENCLAW_AGENTS_CONVERSATION_URL  Base URL (default: http://127.0.0.1:29080/agents-conversation)
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
    sleep 5
    curl -sS "${BASE_URL}/groups/${group_id}/conversations"
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
    curl -sS -X POST "${BASE_URL}/groups/${group_id}/messages" \
      -H "Content-Type: application/json" \
      -d "{\"groupName\":\"${group_name}\",\"members\":[${json_members}],\"initialMessage\":\"${text}\",\"senderId\":\"${sender_id}\"}"
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
