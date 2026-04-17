/**
 * body-consistency — detects drift between a doc's YAML frontmatter and
 * the legacy header-block lines in its body.  Implements ADR-017 rule 4
 * and the DOC-001 / DOC-002 / DOC-003 invariants from
 * `.specflow/contracts/doc_body_consistency.yml`.
 *
 * The check runs after frontmatter parsing in `specflow doctor --docs`
 * and closes the loop that the v1 toolkit left open: ADR-010's own body
 * carried `**Status:** Proposed` while its frontmatter declared
 * `status: Accepted`, and nothing caught it.
 *
 * Findings are typed by severity:
 *   - `status_drift`    — hard error (body disagrees with frontmatter)
 *   - `date_drift`      — hard error (body date disagrees)
 *   - `date_redundant`  — warning (body date equals frontmatter)
 *   - `depends_legacy`  — warning (legacy `**Depends on:**` still present
 *                         after implements: has been populated)
 *
 * Fenced code blocks (``` and ~~~) are skipped per ADR-017 E17-3 / E17-5
 * so docs that quote the legacy format inside an example block do not
 * false-alarm.
 */

import * as fs from 'fs';
import { Document } from './document-repository';

export type BodyFindingType =
  | 'status_drift'
  | 'date_drift'
  | 'date_redundant'
  | 'depends_legacy';

export interface BodyFinding {
  filePath: string;
  docId: string;
  type: BodyFindingType;
  severity: 'error' | 'warn';
  line: number;
  message: string;
}

const STATUS_RE =
  /^\*\*Status:\*\*\s+(Draft|Accepted|Superseded|Deprecated|Proposed)\b/;
const DATE_RE = /^\*\*Date:\*\*\s+(\d{4}-\d{2}-\d{2})\b/;
const DEPENDS_RE = /^\*\*Depends on:\*\*/;

/**
 * Walk a markdown body line by line, respecting fenced code blocks
 * (``` and ~~~).  Yields `{ line, text }` for every logical (non-fenced)
 * body line so legacy-header detection cannot false-alarm on sample
 * content inside a fence.
 */
function* nonFencedLines(body: string): Generator<{ lineNum: number; text: string }, void, unknown> {
  const lines = body.split(/\r?\n/);
  let fence: '' | '```' | '~~~' = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (fence) {
      // Inside a fence — skip, but watch for the closing marker.
      if (trimmed.startsWith(fence)) fence = '';
      continue;
    }
    // Not in a fence — check for a fence opener.
    if (trimmed.startsWith('```')) { fence = '```'; continue; }
    if (trimmed.startsWith('~~~')) { fence = '~~~'; continue; }
    yield { lineNum: i + 1, text: line };
  }
}

export interface DocForConsistency {
  id: string;
  filePath: string;
  frontmatter: { status: string; date: string; implements: string[] };
  body: string;
}

/**
 * Scan one doc's body for frontmatter-disagreeing header lines.
 * Returns an empty array when the body is consistent.
 */
export function checkDocument(doc: DocForConsistency): BodyFinding[] {
  const findings: BodyFinding[] = [];
  const fm = doc.frontmatter;

  for (const { lineNum, text } of nonFencedLines(doc.body)) {
    // Status drift
    const statusMatch = text.match(STATUS_RE);
    if (statusMatch) {
      const bodyStatus = statusMatch[1];
      // "Proposed" is the legacy pre-accepted marker; it disagrees with
      // any frontmatter.status that is not itself "Proposed".
      if (bodyStatus !== fm.status) {
        findings.push({
          filePath: doc.filePath,
          docId: doc.id,
          type: 'status_drift',
          severity: 'error',
          line: lineNum,
          message:
            `body '**Status:** ${bodyStatus}' disagrees with frontmatter 'status: ${fm.status}'`,
        });
      }
      // No else: if body matches frontmatter, we still prefer the body
      // line removed (it's redundant), but that's a style nit handled
      // separately via date_redundant for Date.
    }

    // Date drift / redundancy
    const dateMatch = text.match(DATE_RE);
    if (dateMatch) {
      const bodyDate = dateMatch[1];
      if (bodyDate !== fm.date) {
        findings.push({
          filePath: doc.filePath,
          docId: doc.id,
          type: 'date_drift',
          severity: 'error',
          line: lineNum,
          message:
            `body '**Date:** ${bodyDate}' disagrees with frontmatter 'date: ${fm.date}'`,
        });
      } else {
        findings.push({
          filePath: doc.filePath,
          docId: doc.id,
          type: 'date_redundant',
          severity: 'warn',
          line: lineNum,
          message:
            `body '**Date:**' duplicates frontmatter — remove the body line (frontmatter is canonical)`,
        });
      }
    }

    // Legacy "Depends on:" left over after implements: was populated.
    if (DEPENDS_RE.test(text) && fm.implements.length > 0) {
      findings.push({
        filePath: doc.filePath,
        docId: doc.id,
        type: 'depends_legacy',
        severity: 'warn',
        line: lineNum,
        message:
          `body '**Depends on:**' is a legacy header — frontmatter 'implements' is canonical, remove the body line`,
      });
    }
  }

  return findings;
}

/**
 * Convenience wrapper for documents loaded via DocumentRepository.
 * Reads the on-disk file so we have the exact byte positions needed
 * for accurate line numbers.
 */
export function checkLoadedDocument(doc: Document): BodyFinding[] {
  // Re-read the file so line numbers match the on-disk content.  The
  // Document entity carries body text but not frontmatter line offsets;
  // recomputing from disk is cheap (architecture docs are small) and
  // keeps the line numbers reported to humans correct.
  let raw: string;
  try {
    raw = fs.readFileSync(doc.filePath, 'utf-8');
  } catch {
    return [];
  }
  const body = extractBody(raw);
  return checkDocument({
    id: doc.id,
    filePath: doc.filePath,
    frontmatter: {
      status: doc.frontmatter.status,
      date: doc.frontmatter.date,
      implements: doc.frontmatter.implements,
    },
    body,
  });
}

function extractBody(raw: string): string {
  // Strip YAML frontmatter if present.  Line numbers reported by
  // `checkDocument` are relative to the body; callers that want
  // absolute line numbers can add the frontmatter's line count.
  if (!/^---\s*\r?\n/.test(raw)) return raw;
  const afterOpen = raw.replace(/^---\s*\r?\n/, '');
  const closeIdx = afterOpen.search(/\r?\n---\s*(\r?\n|$)/);
  if (closeIdx < 0) return raw;
  const afterClose = afterOpen
    .slice(closeIdx)
    .replace(/^\r?\n---\s*(\r?\n|$)/, '');
  return afterClose;
}
