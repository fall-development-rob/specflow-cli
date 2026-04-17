/**
 * DocumentTypeRegistry — the single allowlist and state machine for
 * Specflow documents. Implements ADR-014 (central type registry) and the
 * lifecycle decisions from ADR-011 / DDD-008.
 *
 * Everything the rest of the codebase knows about DocumentType, DocumentStatus,
 * id shape, architecture-doc file shape, or the legal transition matrix is
 * exported from this one module. Adding a new type (e.g. `RFC`) or status
 * (e.g. `Approved`) is a one-file change here — every consumer picks it up
 * automatically via the imports below.
 */

// ---------------------------------------------------------------------------
// Type vocabulary
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = ['ADR', 'PRD', 'DDD'] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

export const DOCUMENT_STATUSES = ['Draft', 'Accepted', 'Superseded', 'Deprecated'] as const;
export type DocumentStatus = typeof DOCUMENT_STATUSES[number];

// ---------------------------------------------------------------------------
// Id / filename patterns, derived from DOCUMENT_TYPES so adding `RFC` does
// not require touching any other file.
// ---------------------------------------------------------------------------

const TYPE_ALT = DOCUMENT_TYPES.join('|');

/** Matches a bare id like `ADR-014` (anchored). */
export const ID_PATTERN = new RegExp(`^(?:${TYPE_ALT})-\\d{3}$`);

/** Matches a bare id anywhere inside a larger string, non-capturing. */
export const ID_PATTERN_INLINE = new RegExp(`\\b(?:${TYPE_ALT})-\\d{3}\\b`, 'g');

/** Matches a doc filename like `ADR-014-some-slug.md`. */
export const ARCH_DOC_FILE_PATTERN = new RegExp(`(?:${TYPE_ALT})-\\d{3}`);

/** Matches a bare id anywhere, with the TYPE in capturing group 1. */
export const ID_PATTERN_CAPTURING = new RegExp(`(${TYPE_ALT})-\\d{3}`);

/** Matches a bare id globally, with the TYPE in capturing group 1. */
export const ID_PATTERN_CAPTURING_GLOBAL = new RegExp(`(${TYPE_ALT})-\\d{3}`, 'g');

// ---------------------------------------------------------------------------
// Lifecycle transition matrix (single source of truth, consumed by
// Document.transitionTo and by specflow doctor --docs).
//
// Rules (ADR-011 E11-6, DDD-008):
//   Draft       -> Accepted                  allowed
//   Accepted    -> Superseded                allowed
//   Accepted    -> Deprecated                allowed
//   Deprecated  -> Accepted                  allowed (revival)
//   Superseded  -> *                         FORBIDDEN (write a new doc instead)
//   any         -> same status               FORBIDDEN (no-op rejected)
//
// Any pair not listed in LIFECYCLE_TRANSITIONS is forbidden by default.
// ---------------------------------------------------------------------------

export const LIFECYCLE_TRANSITIONS: Record<DocumentStatus, DocumentStatus[]> = {
  Draft: ['Accepted'],
  Accepted: ['Superseded', 'Deprecated'],
  Superseded: [], // terminal; no revival allowed — write a new doc instead
  Deprecated: ['Accepted'],
};

/** Per-status required-fields hint (used by validate/hydrate). */
export const REQUIRED_FIELDS_PER_STATUS: Record<DocumentStatus, readonly string[]> = {
  Draft: [],
  Accepted: [],
  Superseded: ['superseded_by'],
  Deprecated: ['deprecation_note'],
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isValidType(s: unknown): s is DocumentType {
  return typeof s === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(s);
}

export function isValidStatus(s: unknown): s is DocumentStatus {
  return typeof s === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(s);
}

export function isValidTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  if (from === to) return false;
  const allowed = LIFECYCLE_TRANSITIONS[from];
  return !!allowed && allowed.includes(to);
}

/**
 * True if the file looks like an architecture doc (ADR/PRD/DDD-NNN-*).
 * Works on either absolute paths or bare basenames.
 */
export function isArchitectureDocFile(filePath: string): boolean {
  // We only care about the basename segment of the path, but extracting it
  // here keeps the helper usable with either a full path or a plain filename.
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const basename = lastSep >= 0 ? filePath.slice(lastSep + 1) : filePath;
  return ARCH_DOC_FILE_PATTERN.test(basename);
}

// ---------------------------------------------------------------------------
// TransitionError — thrown by Document.transitionTo on a forbidden transition.
// Captures enough context to render a useful CLI error and to be caught and
// translated by callers (LifecycleOrchestrator in S5).
// ---------------------------------------------------------------------------

export type TransitionErrorCode = 'forbidden' | 'no-op' | 'unknown-status';

export class TransitionError extends Error {
  public readonly from: DocumentStatus;
  public readonly to: DocumentStatus;
  public readonly code: TransitionErrorCode;
  public readonly reason: string;

  constructor(
    from: DocumentStatus,
    to: DocumentStatus,
    reason: string,
    code: TransitionErrorCode = 'forbidden'
  ) {
    super(`Transition ${from} -> ${to} ${code === 'no-op' ? 'is a no-op' : 'is forbidden'}: ${reason}`);
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
    this.code = code;
    this.reason = reason;
  }
}
