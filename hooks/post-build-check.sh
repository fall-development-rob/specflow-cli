#!/bin/bash
# PostToolUse hook for Bash commands
# Detects build commands and triggers journey tests
#
# Input: JSON with "inputs" (command args) and "response" (output)
# Exit 0 = continue silently
# Exit 2 = show stderr to model (for test failures)

# Read the JSON input from stdin
INPUT=$(cat)

# Extract the command that was run
COMMAND=$(echo "$INPUT" | jq -r '.inputs.command // empty' 2>/dev/null)

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
    local exit_code=$(echo "$INPUT" | jq -r '.response.exit_code // .response.exitCode // empty' 2>/dev/null)
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
