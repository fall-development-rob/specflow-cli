#!/bin/bash
# PostToolUse hook for Bash commands
# Detects build commands and triggers journey tests
#
# Input: JSON with "inputs" (command args) and "response" (output)
# Exit 0 = continue silently
# Exit 2 = show stderr to model (for test failures)

# Read the JSON input from stdin
INPUT=$(cat)

# Extract the command that was run (pure bash, no jq dependency)
extract_json_field() {
    # Simple JSON field extraction using grep/sed — handles "inputs":{"command":"value"}
    echo "$1" | grep -oP "\"$2\"\s*:\s*\"[^\"]*\"" | head -1 | sed 's/.*:\s*"\(.*\)"/\1/'
}

# Try node for robust parsing, fall back to regex
if command -v node >/dev/null 2>&1; then
    COMMAND=$(echo "$INPUT" | node -e "
        let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
            try{const j=JSON.parse(d);process.stdout.write(j.inputs?.command||'')}catch{}
        })
    " 2>/dev/null)
else
    COMMAND=$(extract_json_field "$INPUT" "command")
fi

if [ -z "$COMMAND" ]; then
    exit 0
fi

# Check if this was a build command
is_build_command() {
    local cmd="$1"
    # Match common build commands (multi-word patterns + single-word with -w for word boundaries)
    echo "$cmd" | grep -qE '(npm run build|pnpm( run)? build|yarn build|npm build|vite build|next build|turbo( run)? build|make build|cargo build|go build|gradle build|mvn (package|compile))' \
    || echo "$cmd" | grep -qwE '(make|tsc|webpack)'
}

# Check if this was a commit command
is_commit_command() {
    local cmd="$1"
    echo "$cmd" | grep -qE 'git commit'
}

# Check if build/commit was successful (exit code 0 in response)
was_successful() {
    local exit_code
    if command -v node >/dev/null 2>&1; then
        exit_code=$(echo "$INPUT" | node -e "
            let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
                try{const j=JSON.parse(d);const r=j.response;process.stdout.write(String(r?.exit_code??r?.exitCode?? ''))}catch{}
            })
        " 2>/dev/null)
    else
        # Regex fallback: try exit_code then exitCode
        exit_code=$(echo "$INPUT" | grep -oP '"exit_code"\s*:\s*\d+' | head -1 | grep -oP '\d+')
        if [ -z "$exit_code" ]; then
            exit_code=$(echo "$INPUT" | grep -oP '"exitCode"\s*:\s*\d+' | head -1 | grep -oP '\d+')
        fi
    fi
    if [ -z "$exit_code" ]; then
        echo "Warning: could not determine build exit code — skipping tests" >&2
        return 1
    fi
    [ "$exit_code" = "0" ]
}

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
HOOK_DIR="$PROJECT_DIR/.claude/hooks"

# Only run tests after successful build or commit
if is_build_command "$COMMAND" || is_commit_command "$COMMAND"; then
    if was_successful; then
        echo "Build/commit detected. Running journey tests..." >&2

        # Run the journey test script
        if [ -x "$HOOK_DIR/run-journey-tests.sh" ]; then
            "$HOOK_DIR/run-journey-tests.sh"
            exit $?
        elif [ -f "$HOOK_DIR/run-journey-tests.sh" ]; then
            echo "❌ run-journey-tests.sh exists but is not executable" >&2
            echo "   Fix: chmod +x $HOOK_DIR/run-journey-tests.sh" >&2
            echo "   Skip: touch $PROJECT_DIR/.claude/.defer-tests" >&2
            exit 2
        else
            echo "Warning: run-journey-tests.sh not found — skipping journey tests" >&2
            exit 0
        fi
    fi
fi

# Not a build command or not successful - continue silently
exit 0
