/**
 * Lifecycle transition validator for Specflow documents.
 *
 * Implements ADR-015 (Lifecycle Verb Family) and the transition matrix
 * documented in DDD-008 and ADR-014. This module is deliberately small
 * and pure — no I/O, no filesystem, no git — so that it can be unit
 * tested in isolation and composed by the verb handlers in
 * `commands/doc.ts`.
 *
 * TODO(s5-integration): When S4 lands `ts-src/lib/document-types.ts`
 * with a canonical `Document` entity and `Document.transitionTo`, the
 * verb handlers should switch to call that method and delegate the
 * (from, to) check to the registry's matrix. Until then, this module
 * hosts the matrix and `isValidTransition` so the verb family is
 * unblocked.
 */

import type { DocumentStatus } from './frontmatter';

export type { DocumentStatus } from './frontmatter';

/**
 * Canonical transition matrix. `(from, to)` pairs not listed here are
 * forbidden. Same-status transitions are treated as no-ops by the verb
 * layer (exit 0 with "nothing to do") rather than errors.
 */
const ALLOWED_TRANSITIONS: ReadonlyArray<[DocumentStatus, DocumentStatus]> = [
  ['Draft', 'Accepted'],
  ['Accepted', 'Superseded'],
  ['Accepted', 'Deprecated'],
  ['Deprecated', 'Deprecated'], // re-note allowed (per ADR-015)
  ['Deprecated', 'Accepted'],   // revive
];

export function isValidTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function allowedNextStates(from: DocumentStatus): DocumentStatus[] {
  return ALLOWED_TRANSITIONS
    .filter(([f]) => f === from)
    .map(([, t]) => t);
}

/**
 * Error thrown (or returned in a Result) when a transition is rejected.
 * Matches the shape documented in ADR-014 / DDD-008 so when S4's real
 * `TransitionError` class lands the integration diff is mechanical.
 */
export class TransitionError extends Error {
  constructor(
    public readonly from: DocumentStatus,
    public readonly to: DocumentStatus,
    public readonly kind: 'Forbidden' | 'MissingPrerequisite' | 'NoOp',
    message?: string,
  ) {
    super(
      message ||
      (kind === 'Forbidden'
        ? `Transition ${from} -> ${to} is forbidden`
        : kind === 'NoOp'
          ? `Transition ${from} -> ${to} is a no-op`
          : `Missing prerequisite for transition ${from} -> ${to}`),
    );
    this.name = 'TransitionError';
  }
}
