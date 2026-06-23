#!/bin/bash

verify_health_json() {
    local json="$1"
    local search_root="$2"
    # Try Node.js first (preferred, standard in VS Code env)
    if command -v node >/dev/null 2>&1; then
        node -e '
            try {
                const res = JSON.parse(process.argv[1]);
                const root = process.argv[2];
                if (res.status === "ok" && Array.isArray(res.roots) && res.roots.includes(root)) {
                    process.exit(0);
                }
            } catch (e) {}
            process.exit(1);
        ' "$json" "$search_root" 2>/dev/null && return 0
    # Try Python next
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c '
import sys, json
try:
    res = json.loads(sys.argv[1])
    if res.get("status") == "ok" and sys.argv[2] in res.get("roots", []):
        sys.exit(0)
except Exception:
    pass
sys.exit(1)
' "$json" "$search_root" 2>/dev/null && return 0
    # Try Python 2
    elif command -v python >/dev/null 2>&1; then
        python -c '
import sys, json
try:
    res = json.loads(sys.argv[1])
    if res.get("status") == "ok" and sys.argv[2] in res.get("roots", []):
        sys.exit(0)
except Exception:
    pass
sys.exit(1)
' "$json" "$search_root" 2>/dev/null && return 0
    # Try JQ
    elif command -v jq >/dev/null 2>&1; then
        echo "$json" | jq -e ".status == \"ok\" and (.roots | index(\"$search_root\"))" >/dev/null 2>&1 && return 0
    # Fallback to simple bash substring match
    else
        if [[ "$json" == *"\"status\""*"\"ok\""* ]] && [[ "$json" == *"$search_root"* ]]; then
            return 0
        fi
    fi
    return 1
}

sb_api_call() {
    local METHOD="$1"
    local PATH_NAME="$2"
    shift 2

    local CUR="$PWD"
    local SB_ROOT=""
    while [ "$CUR" != "/" ]; do
        if [ -f "$CUR/.switchboard/api-server-port.txt" ]; then
            SB_ROOT="$CUR"
            break
        fi
        local NEXT=$(dirname "$CUR")
        if [ "$NEXT" = "$CUR" ]; then
            break
        fi
        CUR="$NEXT"
    done

    if [ -z "$SB_ROOT" ]; then
        echo '{"error":"Switchboard API server port file not found. Ensure the Switchboard extension is active in a VS Code window opened on this folder."}' >&2
        return 1
    fi

    local PORT=""
    local ATTEMPT=0
    local MAX_ATTEMPTS=5
    local HEALTH_OK=0

    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        PORT=$(cat "$SB_ROOT/.switchboard/api-server-port.txt" 2>/dev/null)
        if [ -n "$PORT" ]; then
            local HEALTH_RESPONSE
            HEALTH_RESPONSE=$(curl -s -f --max-time 2 "http://localhost:$PORT/health" 2>/dev/null)
            if [ $? -eq 0 ]; then
                if verify_health_json "$HEALTH_RESPONSE" "$SB_ROOT"; then
                    HEALTH_OK=1
                    break
                fi
            fi
        fi

        # Bounded exponential backoff + jitter: min(2^attempt, 5)s + (0 to 0.499)s
        local BASE_BACKOFF=$(( 2 ** ATTEMPT ))
        if [ $BASE_BACKOFF -gt 5 ]; then
            BASE_BACKOFF=5
        fi
        local JITTER_MS=$(( RANDOM % 500 ))
        local JITTER_PAD=$(printf "%03d" $JITTER_MS)
        local SLEEP_TIME="${BASE_BACKOFF}.${JITTER_PAD}"
        
        sleep "$SLEEP_TIME"
        ATTEMPT=$(( ATTEMPT + 1 ))
    done

    if [ $HEALTH_OK -ne 1 ]; then
        echo '{"error":"Switchboard API server not reachable for this workspace. Ensure the Switchboard extension is active in a VS Code window opened on this folder."}' >&2
        return 1
    fi

    local TEMP_BODY
    TEMP_BODY=$(mktemp /tmp/sb_api_body.XXXXXX 2>/dev/null || echo "/tmp/sb_api_body.$$")
    
    local HTTP_STATUS
    HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_BODY" -X "$METHOD" "http://localhost:$PORT$PATH_NAME" "$@")
    local EXIT_CODE=$?
    
    # Retry once on transient connection failure or 5xx
    if [ $EXIT_CODE -ne 0 ] || { [ "$HTTP_STATUS" -ge 500 ] && [ "$HTTP_STATUS" -le 599 ]; }; then
        sleep 1
        HTTP_STATUS=$(curl -s -w "%{http_code}" -o "$TEMP_BODY" -X "$METHOD" "http://localhost:$PORT$PATH_NAME" "$@")
        EXIT_CODE=$?
    fi
    
    local RESPONSE_BODY
    RESPONSE_BODY=$(cat "$TEMP_BODY" 2>/dev/null)
    rm -f "$TEMP_BODY"
    
    if [ $EXIT_CODE -ne 0 ]; then
        echo '{"error":"Switchboard API server not reachable for this workspace. Ensure the Switchboard extension is active in a VS Code window opened on this folder."}' >&2
        return 1
    fi
    
    echo "$RESPONSE_BODY"
    if [ "$HTTP_STATUS" -ge 400 ]; then
        return 1
    fi
    return 0
}
