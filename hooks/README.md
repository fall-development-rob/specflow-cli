# Specflow Hook Templates

Templates that `specflow init` and `specflow update` copy into target projects.

## Files

| File | Purpose |
|------|---------|
| `commit-msg` | Git hook template — enforces issue numbers in commit messages |
| `settings.json` | Claude Code hook wiring template (PostToolUse entries) |

## TypeScript Implementations

The hook logic lives in `ts-src/hooks/`:

| File | Purpose |
|------|---------|
| `post-build-check.ts` | Detects build/commit commands, triggers journey tests |
| `run-journey-tests.ts` | Finds issues → journeys → runs relevant e2e tests |
| `check-compliance.ts` | Checks written/edited files against contract patterns |

## Additional Templates

`templates/hooks/post-push-ci.sh` — polls GitHub Actions CI status after `git push` (advisory, non-blocking).

## Installation

```bash
specflow init .     # scaffold hooks into a project
specflow update .   # update existing hooks
```

## Deferring Tests

**Per-journey deferral (recommended):** Add entries to `.claude/.defer-journal`:

```
J-SIGNUP-FLOW: blocked by auth refactor (#42)
```

**Global deferral:** `touch .claude/.defer-tests`

## Commit Format

Include issue numbers in commits:

```
feat: add signup validation (#375)
fix: handle edge case (#375, #376)
```
