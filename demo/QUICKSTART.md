# Specflow Demo - Quick Start

> **See it in action:** Watch contracts catch violations that tests miss

---

## What This Demonstrates

**The Problem:** LLMs write code that passes tests but violates spec requirements.

**The Demo:** Shows a realistic scenario where:
1. ✅ Code works and meets spec (baseline)
2. 🤖 LLM "optimizes" code (localStorage for "10x performance")
3. ✅ Unit tests still pass (the trap!)
4. ❌ Contract tests fail (caught!)

---

## Quick Start (2 minutes)

```bash
# 1. Install
cd demo
npm install

# 2. Run automated demo
npm run demo
```

**You'll see:**
- Initial working state (store with TTL)
- LLM "optimization" (localStorage)
- Unit tests passing in both states
- Contract tests catching the violation
- Side-by-side comparison

---

## Step-by-Step Mode

Want to explore manually?

```bash
# Step 1: See working baseline
npm run demo:working
# Output: ✅ All tests pass, spec met

# Step 2: Apply LLM "optimization"
npm run demo:broken
# Output: Code changed to localStorage

# Step 3: See tests pass but contract fails
npm run demo:compare
# Output: Unit tests ✅ pass, Contract ❌ fails

# Step 4: Reset to try again
npm run demo:reset
```

---

## What's Happening Behind the Scenes

### The Files

- `src/auth.js` - Authentication module (swappable)
- `states/safe.js` - Uses store with TTL (✅ compliant)
- `states/trap.js` - Uses localStorage (❌ violation)
- `docs/spec.md` - AUTH-001 requirement
- `docs/contract.yml` - Contract mapping AUTH-001 → rules

### The Tests

**Unit Tests** (`src/__tests__/auth.test.js`)
- Test: creates/retrieves/deletes sessions
- Pass in BOTH states (safe and trap)
- Why: Validate implementation works, not spec compliance

**Contract Tests** (`src/__tests__/contracts.test.js`)
- Scans source code for forbidden patterns
- Passes in safe state, FAILS in trap state
- Why: Validates spec requirements are met

### The Swap

`demo.js` swaps `src/auth.js` between states:
- Safe → trap → compare results → reset

---

## Key Insight

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│  Unit Tests:      Validate implementation works             │
│  Contract Tests:  Validate spec requirements met            │
│                                                              │
│  You need BOTH!                                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Example from demo:**

| Check | Without Contracts | With Contracts |
|-------|-------------------|----------------|
| Unit tests | ✅ Pass | ✅ Pass |
| Spec met | ❌ No | ✅ Yes (enforced) |
| Build | ✅ Success | ❌ Blocked |
| Deploy | 🚀 Deployed | 🛑 Stopped |
| Production | 💥 Crash | ✅ Safe |

---

## Understanding AUTH-001

**Requirement:** Session storage MUST use Redis with TTL, not localStorage.

**Why this rule exists:**
- localStorage can be disabled (enterprise policies)
- localStorage doesn't expire automatically (security risk)
- localStorage unavailable in service workers (Chrome MV3)

**Real-world context:**
This requirement came from a real TabStax production incident where an LLM "optimized" auth by switching to localStorage, breaking the extension for enterprise users.

---

## Try Modifying the Contract

Want to experiment?

1. Edit `docs/contract.yml` - comment out the forbidden_patterns
2. Run `npm test -- contracts` - now passes even with localStorage!
3. Uncomment - now catches violation again

This shows contracts are enforceable guards, not just comments.

---

## Next Steps

### Use in Your Project

```bash
# 1. Install Specflow CLI
cargo install --git https://github.com/Hulupeep/Specflow.git specflow

# 2. Initialize in your project
specflow init .

# 3. Check setup
specflow doctor .

# 4. Run contract enforcement
specflow enforce .

# 5. Run contract tests
npm test -- contracts

# 6. Add to CI
specflow update . --ci
```

### Learn More

- **[Main Specflow Docs](../README.md)** - Full system overview
- **[Contract Schema](../CONTRACT-SCHEMA.md)** - YAML format details
- **[Agent Library](../agents/README.md)** - 26 agents for orchestration
- **[Getting Started](../docs/getting-started.md)** - Detailed setup guide

---

## FAQ

**Q: Why mock localStorage in unit tests?**
A: So tests can pass in both states. That's the whole point - showing tests aren't enough.

**Q: Would this catch real LLM mistakes?**
A: Yes! Based on real TabStax incident. LLMs optimize without understanding runtime constraints.

**Q: Can I change the requirement?**
A: Absolutely! Edit spec.md → update contract.yml → update tests. Contract enforces whatever you specify.

**Q: Do I need this for my project?**
A: If you:
- Work with LLMs that modify code
- Have critical architectural requirements (storage, auth, perf)
- Want protection beyond TypeScript/ESLint

Then yes, contracts add a safety layer tests can't provide.

---

*Demo created for Specflow v1.0*
*Based on real production incident from TabStax MV3 extension*
