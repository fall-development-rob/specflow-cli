# Specflow CI/CD Integration Guide

> Generate project-specific CI pipelines with the ci-builder agent

## Overview

Instead of copying static YAML templates, Specflow uses the **ci-builder agent** to inspect your project and generate a tailored CI pipeline with contract enforcement built in.

The agent detects your CI platform, package manager, test framework, and project features (Playwright, Rust native modules, Docker) and produces a ready-to-use workflow file.

---

## Quick Start

### View the agent prompt

```bash
specflow agent show ci-builder
```

### Ask Claude Code to generate a pipeline

```
Generate CI pipeline for this project
```

The agent will:
1. Detect your CI platform (or ask)
2. Inspect `package.json`, lockfiles, and project structure
3. Generate a complete workflow with Specflow enforcement
4. Tell you where to save it

---

## Supported Platforms

| Platform | Output File |
|----------|------------|
| GitHub Actions | `.github/workflows/specflow-ci.yml` |
| GitLab CI | `.gitlab-ci.yml` |
| Azure Pipelines | `azure-pipelines.yml` |
| CircleCI | `.circleci/config.yml` |
| Bitbucket Pipelines | `bitbucket-pipelines.yml` |

---

## What the Agent Generates

Every generated pipeline includes these stages:

1. **Checkout** -- clone the repository
2. **Node.js setup** -- version detected from `engines`, `.nvmrc`, or `.node-version`
3. **Install dependencies** -- uses the correct package manager (`npm ci`, `pnpm install --frozen-lockfile`, etc.)
4. **Contract enforcement** -- `specflow enforce --json` as a build gate
5. **Test suite** -- runs your existing test command
6. **Journey tests** -- Playwright E2E tests (if detected)
7. **Compliance report** -- posts `specflow status` as a PR comment
8. **Caching** -- caches `node_modules` and `.specflow/` for speed

---

## Example: GitHub Actions

For a Node.js project with npm, Jest, and Specflow contracts, the agent generates:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  enforce-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      # Contract enforcement gate
      - name: Enforce Specflow contracts
        run: npx specflow enforce --json

      # Full test suite
      - name: Run tests
        run: npm test
```

---

## Branch Protection

After generating your pipeline, configure branch protection to require the CI job to pass before merging:

**GitHub:** Settings > Branches > Branch protection rules > Require status checks

**GitLab:** Settings > Repository > Protected Branches > Pipeline must succeed

---

## Customization

The generated pipeline is a starting point. Common customizations:

- Add deployment steps after tests pass
- Add matrix builds for multiple Node versions
- Add Slack/email notifications on failure
- Add artifact uploads for build outputs

---

## Migration from Static Templates

If you previously used `specflow update --ci` to copy static workflow templates, the `--ci` flag now points you to the ci-builder agent instead. The agent generates better, project-specific pipelines that adapt to your actual setup.

```bash
# Old way (deprecated)
specflow update . --ci

# New way
specflow agent show ci-builder
# Or ask Claude Code: Generate CI pipeline for this project
```
