---
id: PRD-008
title: Contract Creation (`specflow contract create`)
type: PRD
status: Accepted
version: 1
date: '2026-04-05'
last_reviewed: '2026-04-17'
---

# PRD-008: Contract Creation (`specflow contract create`)

**Phase:** 11c

---

## Overview

Enable developers to create new contracts from pre-built templates or AI-generated descriptions. The command supports two modes: `--template` (no external dependencies) and `--ai` (requires Claude CLI). All generated contracts are validated before saving.

---

## Goals

1. **Lower the barrier** to creating custom contracts — no YAML expertise required
2. **Provide starter templates** for common patterns (no-console-log, no-any, etc.)
3. **Validate generated contracts** — regex compiles, scope matches files, examples pass against patterns
4. **Interactive review** — show the contract, let the user approve before saving

## Non-Goals

1. **Replace manual YAML editing** — power users will still edit contracts directly
2. **Auto-detect what contracts are needed** — the user specifies intent
3. **Require AI for basic usage** — template mode works offline with no API keys

---

## Feature Specification

### Command

```bash
# Template mode (default, no LLM required)
specflow contract create --template no-console-log
specflow contract create --template          # Interactive template selection

# AI mode (requires Claude CLI)
specflow contract create --ai "no hardcoded API keys in source files"
specflow contract create --ai               # Interactive prompt
```

### Mode A: `--template` (Default)

Pre-built contract templates with fill-in-the-blank scope configuration.

**Flow:**
1. If no template name given, show interactive picker listing all available templates.
2. Load template definition (rule ID, patterns, description, default scope).
3. Ask user to confirm or customize scope glob.
4. Generate YAML contract with template's patterns and user's scope.
5. Validate: regex compiles, `example_violation` matches pattern, `example_compliant` does not.
6. Show generated contract, ask "Save? (y/n/edit)".
7. If yes: save to `.specflow/contracts/custom_<slug>.yml`.
8. Run `specflow enforce --contract <id>` to show what it catches.

**Pre-built Templates:**

| Template ID | Description | Pattern |
|------------|-------------|---------|
| `no-console-log` | Forbid console.log statements | `console\\.log\\(` |
| `no-any-type` | Forbid TypeScript `any` type | `:\\s*any[\\s;,)]` |
| `api-auth-required` | Require auth middleware on API routes | Negative: must contain `authenticate` |
| `no-todo-comments` | Forbid TODO/FIXME/HACK comments | `//\\s*(TODO|FIXME|HACK)` |
| `env-vars-only` | Forbid hardcoded config values | `(API_KEY|SECRET|PASSWORD)\\s*=\\s*['"]` |
| `no-inline-styles` | Forbid inline style attributes in JSX/HTML | `style\\s*=\\s*\\{\\{` |

### Mode B: `--ai` (Requires Claude CLI)

AI-generated contracts from natural language descriptions.

**Flow:**
1. Check Claude CLI is available (`claude --version`). If not, suggest `--template` mode.
2. Send description to Claude with the contract YAML schema as context.
3. Parse the returned YAML.
4. Validate: regex compiles, scope glob is syntactically valid.
5. Test `example_violation` against pattern (must match). Test `example_compliant` (must not match).
6. If validation fails (e.g., bad regex): show error, ask user to refine description.
7. Show generated contract, ask "Save? (y/n/edit)".
8. If yes: save to `.specflow/contracts/custom_<slug>.yml`.
9. Run `specflow enforce --contract <id>` to show what it catches.

### Contract ID Generation

- Format: `CUSTOM-NNN` where NNN is auto-incremented.
- Check `.specflow/contracts/` for existing `CUSTOM-*` IDs to avoid conflicts.
- User can override with `--id MY-RULE-001`.

### Output File

- Path: `.specflow/contracts/custom_<slug>.yml`
- Slug derived from template ID or first 3 words of AI description, kebab-cased.
- Example: `custom_no-console-log.yml`, `custom_no-hardcoded-api.yml`

---

## Validation Pipeline

Every generated contract passes through this pipeline before saving:

```
Step 1: YAML Syntax       — Parse as YAML, reject if malformed
Step 2: Schema Validation  — Check required fields: id, description, scope, rules[]
Step 3: Regex Compilation  — Compile each rule's pattern, reject if invalid
Step 4: Scope Resolution   — Glob scope against project files, warn if zero matches
Step 5: Example Testing    — example_violation must match pattern
                           — example_compliant must NOT match pattern
Step 6: ID Uniqueness      — Check rule ID doesn't conflict with existing contracts
```

If any step fails, the contract is NOT saved. The error is shown with a specific fix suggestion.

---

## Interactive Review

After generation and validation, the user sees:

```
Generated contract:
───────────────────
id: CUSTOM-001
description: Forbid console.log statements
scope: "src/**/*.{ts,tsx}"
rules:
  - id: CUSTOM-001
    pattern: "console\\.log\\("
    message: "Remove console.log — use the logger service instead"
    severity: warning
example_violation: 'console.log("debug")'
example_compliant: 'logger.info("debug")'
───────────────────

Save this contract? (y/n/edit)
> y

✓ Saved to .specflow/contracts/custom_no-console-log.yml
Running enforcement...
  src/utils/debug.ts:14  CUSTOM-001  Remove console.log — use the logger service instead
  src/api/health.ts:8    CUSTOM-001  Remove console.log — use the logger service instead

2 violations found in 2 files.
```

If user chooses "edit", open the YAML in `$EDITOR` (or show inline editor prompt).

---

## Edge Cases and Resolutions

| ID | Edge Case | Resolution |
|----|-----------|------------|
| E3-1 | No API key for AI mode | Check for Claude CLI first. Default to `--template`. Show: "For AI-generated contracts, install Claude CLI: `npm i -g @anthropic-ai/claude-code`" |
| E3-2 | Generated regex doesn't compile | Validation step 3 catches it. Show the regex and the compilation error. In AI mode, ask user to refine description. |
| E3-3 | Scope matches no files | Warning (not error): "Scope 'test/**/*.py' matches 0 files in this project. The contract will be saved but won't enforce anything until matching files exist." |
| E3-4 | Contract ID conflicts | Auto-generate `CUSTOM-NNN`, incrementing until unique. Check all sources: user contracts, package contracts. |
| E3-5 | Save location | Always `.specflow/contracts/custom_<slug>.yml`. Never save to templates or packages. |
| E3-6 | Immediate enforcement | After saving, run `specflow enforce --contract <id>` and show results. If no violations: "No violations found — this contract is currently satisfied." |
| E3-7 | Vague AI description | AI returns low-quality contract. Validation catches bad regex/examples. Show validation errors and suggest refining the description with more specific terms. |
| E3-8 | Interactive review | Always show generated YAML before saving. Options: y (save), n (discard), edit (open in editor). Non-interactive mode (`--yes` flag) skips review. |
| E3-9 | Example testing | Both `example_violation` and `example_compliant` are tested against the pattern before saving. If examples fail: "example_violation does not match pattern — check the regex." |
| E3-10 | Template library | Ship 6 templates (see table above). Templates stored in `templates/contract-templates/` as YAML. Extensible: users can add custom templates to `.specflow/templates/`. |

---

## Acceptance Criteria

- [ ] `specflow contract create --template no-console-log` generates and saves a valid contract
- [ ] `specflow contract create --template` (no arg) shows interactive template picker
- [ ] `specflow contract create --ai "description"` generates a contract via Claude CLI
- [ ] `specflow contract create --ai` without Claude CLI installed shows helpful error
- [ ] Generated regex is validated before saving — invalid regex blocks save
- [ ] Scope glob is resolved against project — zero matches triggers warning
- [ ] `example_violation` and `example_compliant` are tested against the pattern
- [ ] Interactive review shows YAML and asks "Save? (y/n/edit)"
- [ ] `--yes` flag skips interactive review
- [ ] Contract ID auto-generated as `CUSTOM-NNN`, checked for uniqueness
- [ ] Saved contract is immediately enforced and results shown
- [ ] All 6 pre-built templates generate valid, working contracts

---

## Implementation Notes

- Template definitions in `templates/contract-templates/*.yml` — each defines: id, description, pattern, default_scope, example_violation, example_compliant, message.
- AI mode sends the full contract YAML schema as system context to Claude.
- The validation pipeline is reusable — also used by `specflow enforce` to validate contracts at load time.
