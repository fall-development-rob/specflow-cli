# Specflow Hook Templates

Hook templates for Claude Code that provide automated feedback during development.

Copy these to your project's `.claude/hooks/` directory via `specflow init .` or `specflow update .`.

## Available Templates

| Hook | Trigger | Blocking | Purpose |
|------|---------|----------|---------|
| `post-push-ci.sh` | `git push` | No (advisory) | Check CI status after push, report pass/fail |

## Installation

```bash
# From your project root
specflow init .      # full scaffold
specflow update .    # update hooks only

# Or manually
mkdir -p .claude/hooks
cp /path/to/Specflow/templates/hooks/post-push-ci.sh .claude/hooks/
chmod +x .claude/hooks/*.sh
```

Then add hook entries to `.claude/settings.json` (see Settings Configuration below).

## post-push-ci.sh

Checks GitHub Actions CI status after `git push`. Polls the latest workflow run up to 5 times (10-second intervals) and reports results.

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SPECFLOW_CI_POLL_INTERVAL` | `10` | Seconds between status polls |
| `SPECFLOW_CI_MAX_RETRIES` | `5` | Maximum number of poll attempts |

**Defer:** `touch .claude/.defer-ci-check`

**Graceful handling of edge cases:**
- `gh` CLI not installed — warns and skips
- `gh` not authenticated — warns and skips
- No git remote configured — warns and skips
- No CI workflows on the repo — reports and exits cleanly

## Settings Configuration

For manual setup, ensure your `.claude/settings.json` includes:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/post-push-ci.sh"
          }
        ]
      }
    ]
  }
}
```

## Disabling Hooks

```bash
touch .claude/.defer-ci-check    # Skip CI status check
rm .claude/.defer-ci-check       # Re-enable
```

Or disable all hooks:

```bash
mv .claude/settings.json .claude/settings.json.disabled
```
