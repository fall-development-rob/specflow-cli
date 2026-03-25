# Hey Dom — How to Create Journeys That Specflow Can Test

**For:** Product Designers using Figma + Figma MCP in Claude Code
**Why this matters:** Your Figma designs are now the source of truth for journey tests. When you annotate correctly, Claude Code can read your prototype and automatically generate test contracts, surface gaps, and keep the epic up to date — no spreadsheets, no meetings, no drift.

---

## The Core Concept You Need to Know

**Skip is not nothing. Skip is a deferred obligation.**

When a user skips a step, that obligation doesn't disappear — it lands somewhere else in the product. Specflow tracks where it lands (called a **Gate**) and tests that the Gate handles it correctly.

**Example:**
- User skips email verification during signup
- The deferred obligation "email_verification" must be enforced later
- When the user tries to invite a team member → Gate triggers → prompt to verify email first
- Specflow tests: does that gate actually block the right users? Does it recover gracefully?

If you don't label the skip and draw the Gate, the test system has no idea this obligation exists. Users will hit broken states. The team won't know until production.

---

## What You Need to Set Up in Figma

### 1. One File Per Journey Domain

Name your Figma pages so Claude Code can find them:

```
Journey: ONBOARDING
Journey: CHECKOUT
Journey: TEAM_MANAGEMENT
```

The prefix `Journey:` is required — it's what journey:sync looks for.

### 2. Install the SF Component Library

Ask your dev team to give you the SF Specflow component library. Four components:

| Component | What it marks |
|-----------|---------------|
| `SF:Step` | A user-facing screen that's part of a journey |
| `SF:Gate` | A screen where deferred obligations are enforced |
| `SF:Optional` | A step that can be skipped with no deferred obligation |
| `SF:Merge` | Where two paths rejoin |

Place the badge in the top-left corner of each relevant frame.

### 3. Fill in SF:Step Fields

Every step frame needs:

| Field | Example | Notes |
|-------|---------|-------|
| `label` | "Verify Email" | 2-5 words, user-facing language, not dev jargon |
| `persona` | "New User (Email)" | Who is on this path? |
| `status` | "designed" | designed / in-progress / implemented |
| `j_id` | (leave blank) | Auto-filled by journey:sync |

### 4. Fill in SF:Gate Fields

Every gate frame needs:

| Field | Example | Notes |
|-------|---------|-------|
| `gate_id` | "invite_team" | Snake case, unique across the journey |
| `enforces` | "email_verification" | Obligation IDs this gate collects (comma separated) |
| `behavior` | "prompt-and-complete" | See behavior types below |

**Gate behavior types:**
- `prompt-and-complete` — Show the user what they need to do, let them complete it inline, then continue
- `hard-block` — User cannot proceed until obligation is met elsewhere
- `graceful-degrade` — Feature works in reduced mode (e.g., read-only until verified)
- `notify-async` — Send reminder, don't block

### 5. Label Every Prototype Arrow

This is the most important annotation. Every connection between frames in your prototype needs a label:

| Label | Meaning |
|-------|---------|
| `Continue` | Normal progression |
| `Skip` | User defers this step — add `defers: [obligation_id]` note |
| `Back` | User navigates backward |
| `Error: [reason]` | Error path |
| `Alternative: [reason]` | Different way to complete same step |
| `Bypass: [gate_id]` | Already-verified user skips gate |

**For skip arrows specifically:** Add a Figma note to the arrow with `defers: email_verification` (or whatever the obligation is). This tells Specflow what the skip creates.

---

## Drawing a Journey — Step by Step

### Simple linear flow:

```
[Sign Up]  →Continue→  [Verify Email]  →Continue→  [Setup Profile]
```

### Flow with a skip:

```
[Sign Up]  →Continue→  [Verify Email]  →Continue→  [Setup Profile]
                              ↓
                           →Skip (defers: email_verification)→
                              ↓
                        [Setup Profile]
```

### Flow with a Gate later:

```
[Dashboard]  →Click Invite→  [GATE: invite_team]  →Continue (verified)→  [Invite Sent]
                                     ↑
                        enforces: email_verification
                        behavior: prompt-and-complete
```

### Multi-persona split:

Create a **Group** (or Section) named `Persona: New User (Email)` containing all frames for that persona's path. For paths that share frames, let multiple groups reference the same frame.

---

## The Balanced Journey Rule

**Every skip must have exactly one Gate.**
**Every Gate must have a recovery path.**

If you draw a Skip arrow, you must also draw the Gate that enforces it. If you draw a Gate, you must draw what happens when the user completes the obligation (recovery path) and what happens when they can't (graceful degrade or block).

When you run `journey:check`, it will tell you if any skip is unmatched or any Gate has no recovery path. Fix these before handing off to dev.

---

## Checking Your Work

Once your prototype is ready, ask anyone on the team to run:

```bash
journey:sync --figma-file YOUR_FILE_ID
```

This reads your Figma design and produces a readiness report:

```
Journey: ONBOARDING
  Steps: 5 (4 implemented, 1 designed)
  Gates: 2 (2 linked)
  Skips: 3 (3 matched to gates)
  Gaps:
    ⚠️  Frame "Invite Team" missing SF:Gate badge
    ⚠️  Skip arrow on frame 1238 has no defers annotation
  Readiness: 62% (needs 80% for green)
```

Fix the gaps, re-run. When you hit 80%+ readiness the journey becomes visible in the observation deck.

---

## Troubleshooting: The Epic View

Every journey has a GitHub epic. You can always check the current state of the journey by looking at the epic issue. After any sync or CI run, it's automatically updated with:

- The full step sequence (in order, with personas)
- Gate locations and what they enforce
- Which tickets are linked to which steps
- Gaps (steps with no ticket yet)
- Readiness score

If a step is wrong order, a persona is missing, or a Gate isn't connected — you'll see it in the epic. No need to ask a developer.

---

## Quick Reference Card

```
FIGMA SETUP CHECKLIST

Pages:
  ✓ Named "Journey: JOURNEY_NAME"

Frames:
  ✓ SF:Step badge on every journey screen
  ✓ SF:Gate badge on every enforcement screen
  ✓ label field: 2-5 user-facing words
  ✓ persona field: who is on this path

Arrows:
  ✓ Every arrow has a label (Continue / Skip / Back / Error: / Alternative:)
  ✓ Skip arrows have a Figma note: "defers: [obligation_id]"
  ✓ Gate arrows have labels: Continue / Bypass / Recover

Balanced check:
  ✓ Every Skip → has one Gate
  ✓ Every Gate → has a recovery path
  ✓ No user is permanently stuck

Run: journey:check
  Target: 80%+ readiness
```

---

## Why This Matters

Without this annotation, here's what happens:

- Dev implements signup. Skip path is just a button. No one defines what "skipped email verification" means downstream.
- 3 months later: invite-team page lets unverified users invite people. Security hole.
- Or: invite-team blocks everyone with a cryptic error. Churn.
- Or: QA finds it in production during a user test. Expensive.

With this annotation:

- Skip is documented at design time
- Gate is specced before the ticket is written
- Test contract is auto-generated from your Figma
- CI catches the regression if someone removes the gate check
- You can see the whole journey in the epic at any time

You are the only person who can define what the journey is supposed to be. This is your artifact. The tests are just verifying that what gets built matches what you designed.

---

*Questions? Run `journey:check` first — it'll tell you exactly what's missing.*
*For deeper docs: `docs/journeys/` in the Specflow repo.*
