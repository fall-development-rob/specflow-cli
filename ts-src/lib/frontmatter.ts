/**
 * FrontmatterParser — parses and validates YAML frontmatter on Specflow docs.
 * Implements DDD-007 FrontmatterParser service and ADR-011 schema.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DOCUMENT_TYPES,
  DOCUMENT_STATUSES,
  DocumentType,
  DocumentStatus,
  ID_PATTERN,
  ID_PATTERN_CAPTURING,
  ID_PATTERN_CAPTURING_GLOBAL,
  isValidStatus,
  isValidType,
} from './document-types';

const yaml = require('js-yaml');

// Re-export the type aliases so existing `from './frontmatter'` imports keep
// working during the S4 refactor. New code should import from './document-types'.
export { DocumentType, DocumentStatus };

export interface DocumentFrontmatter {
  id: string;
  title: string;
  type: DocumentType;
  status: DocumentStatus;
  version: number;
  date: string;
  last_reviewed: string;
  implements: string[];
  implemented_by: string[];
  superseded_by?: string;
  deprecation_note?: string;
  references?: string[];
}

export interface ParseSuccess {
  ok: true;
  frontmatter: DocumentFrontmatter;
  body: string;
  raw: string;
}

export interface ParseFailure {
  ok: false;
  error: string;
  errors?: string[];
}

export type ParseResult = ParseSuccess | ParseFailure;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FRONTMATTER_OPEN = /^---\s*\r?\n/;
const FRONTMATTER_CLOSE_RE = /\r?\n---\s*(\r?\n|$)/;

export function hasFrontmatter(content: string): boolean {
  return FRONTMATTER_OPEN.test(content);
}

export function extractFrontmatterBlock(content: string): { yaml: string; body: string } | null {
  const openMatch = content.match(FRONTMATTER_OPEN);
  if (!openMatch) return null;
  const afterOpen = content.slice(openMatch[0].length);
  const closeMatch = afterOpen.match(FRONTMATTER_CLOSE_RE);
  if (!closeMatch || closeMatch.index === undefined) return null;
  const yamlBlock = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { yaml: yamlBlock, body };
}

export function parseString(content: string): ParseResult {
  const block = extractFrontmatterBlock(content);
  if (!block) {
    return { ok: false, error: 'No YAML frontmatter block found' };
  }

  let parsed: any;
  try {
    parsed = yaml.load(block.yaml);
  } catch (e: any) {
    return { ok: false, error: `YAML parse error: ${e.message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Frontmatter did not parse to an object' };
  }

  const normalised = normalise(parsed);
  const errors = validate(normalised);
  if (errors.length > 0) {
    return { ok: false, error: errors[0], errors };
  }

  return { ok: true, frontmatter: normalised, body: block.body, raw: block.yaml };
}

export function parseFile(filePath: string): ParseResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e: any) {
    return { ok: false, error: `Read error: ${e.message}` };
  }
  return parseString(content);
}

function coerceDate(v: any): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function normalise(raw: any): DocumentFrontmatter {
  return {
    id: String(raw.id || ''),
    title: String(raw.title || ''),
    type: raw.type as DocumentType,
    status: raw.status as DocumentStatus,
    version: typeof raw.version === 'number' ? raw.version : parseInt(String(raw.version || 0), 10),
    date: coerceDate(raw.date),
    last_reviewed: coerceDate(raw.last_reviewed),
    implements: Array.isArray(raw.implements) ? raw.implements.map(String) : [],
    implemented_by: Array.isArray(raw.implemented_by) ? raw.implemented_by.map(String) : [],
    superseded_by: raw.superseded_by ? String(raw.superseded_by) : undefined,
    deprecation_note: raw.deprecation_note ? String(raw.deprecation_note) : undefined,
    references: Array.isArray(raw.references) ? raw.references.map(String) : undefined,
  };
}

export function validate(fm: DocumentFrontmatter): string[] {
  const errors: string[] = [];
  const idShape = `(${DOCUMENT_TYPES.join('|')})-NNN`;

  if (!fm.id) errors.push('Missing required field: id');
  else if (!ID_PATTERN.test(fm.id)) errors.push(`Invalid id "${fm.id}" — must match ${idShape}`);

  if (!fm.title) errors.push('Missing required field: title');

  if (!fm.type) errors.push('Missing required field: type');
  else if (!isValidType(fm.type)) errors.push(`Invalid type "${fm.type}" — must be one of ${DOCUMENT_TYPES.join(', ')}`);

  if (!fm.status) errors.push('Missing required field: status');
  else if (!isValidStatus(fm.status)) {
    errors.push(`Invalid status "${fm.status}" — must be one of ${DOCUMENT_STATUSES.join(', ')}`);
  }

  if (!fm.version || fm.version < 1) errors.push('Field version must be >= 1');

  if (!fm.date) errors.push('Missing required field: date');
  else if (!DATE_PATTERN.test(fm.date)) errors.push(`Invalid date "${fm.date}" — must be YYYY-MM-DD`);

  if (!fm.last_reviewed) errors.push('Missing required field: last_reviewed');
  else if (!DATE_PATTERN.test(fm.last_reviewed)) errors.push(`Invalid last_reviewed "${fm.last_reviewed}"`);
  else if (fm.date && fm.last_reviewed < fm.date) {
    errors.push('last_reviewed must be on or after date');
  }

  if (fm.status === 'Superseded' && !fm.superseded_by) {
    errors.push('Status Superseded requires superseded_by field');
  }
  if (fm.status === 'Deprecated' && !fm.deprecation_note) {
    errors.push('Status Deprecated requires deprecation_note field');
  }
  if (fm.superseded_by && !ID_PATTERN.test(fm.superseded_by)) {
    errors.push(`superseded_by "${fm.superseded_by}" must match ${idShape}`);
  }

  for (const ref of fm.implements) {
    if (!ID_PATTERN.test(ref)) errors.push(`implements entry "${ref}" must match ${idShape}`);
  }
  for (const ref of fm.implemented_by) {
    if (!ID_PATTERN.test(ref)) errors.push(`implemented_by entry "${ref}" must match ${idShape}`);
  }

  return errors;
}

export function serialize(fm: DocumentFrontmatter): string {
  const ordered: any = {
    id: fm.id,
    title: fm.title,
    type: fm.type,
    status: fm.status,
    version: fm.version,
    date: fm.date,
    last_reviewed: fm.last_reviewed,
  };
  if (fm.implements.length > 0) ordered.implements = fm.implements;
  if (fm.implemented_by.length > 0) ordered.implemented_by = fm.implemented_by;
  if (fm.superseded_by) ordered.superseded_by = fm.superseded_by;
  if (fm.deprecation_note) ordered.deprecation_note = fm.deprecation_note;
  if (fm.references && fm.references.length > 0) ordered.references = fm.references;

  const yamlText = yaml.dump(ordered, { lineWidth: 120, noRefs: true });
  return `---\n${yamlText}---\n`;
}

export function writeFrontmatter(filePath: string, fm: DocumentFrontmatter, body: string): void {
  const out = serialize(fm) + (body.startsWith('\n') ? body : '\n' + body);
  fs.writeFileSync(filePath, out, 'utf-8');
}

const LEGACY_STATUS_RE = /\*\*Status:\*\*\s*(.+)/;
const LEGACY_DATE_RE = /\*\*Date:\*\*\s*(.+)/;
const LEGACY_DEPENDS_RE = /\*\*Depends on:\*\*\s*(.+)/;
// Title regex built from the central DOCUMENT_TYPES so new types (e.g. RFC)
// pick it up automatically. Groups: 1 = full id, 2 = type.
const LEGACY_TITLE_RE = new RegExp(
  `^#\\s+((${DOCUMENT_TYPES.join('|')})-\\d{3}):?\\s*(.+)`,
  'm'
);
const INLINE_ID_RE = ID_PATTERN_CAPTURING_GLOBAL;

export interface LegacyHeader {
  id?: string;
  title?: string;
  type?: DocumentType;
  status?: DocumentStatus;
  date?: string;
  implementsIds: string[];
}

export function parseLegacyHeader(content: string): LegacyHeader {
  const header: LegacyHeader = { implementsIds: [] };

  const titleMatch = content.match(LEGACY_TITLE_RE);
  if (titleMatch) {
    header.id = titleMatch[1];
    header.type = titleMatch[2] as DocumentType;
    header.title = titleMatch[3].trim();
  }

  const statusMatch = content.match(LEGACY_STATUS_RE);
  if (statusMatch) {
    const s = statusMatch[1].trim();
    if (isValidStatus(s)) {
      header.status = s;
    } else {
      // "Proposed" and any unknown legacy status coerce to Accepted.
      header.status = 'Accepted';
    }
  }

  const dateMatch = content.match(LEGACY_DATE_RE);
  if (dateMatch && DATE_PATTERN.test(dateMatch[1].trim())) {
    header.date = dateMatch[1].trim();
  }

  const dependsMatch = content.match(LEGACY_DEPENDS_RE);
  if (dependsMatch) {
    const ids = dependsMatch[1].match(INLINE_ID_RE) || [];
    header.implementsIds = Array.from(new Set(ids));
  }

  return header;
}

export function buildFrontmatterFromLegacy(
  content: string,
  filePath: string,
  today: string
): DocumentFrontmatter | null {
  const legacy = parseLegacyHeader(content);
  const basename = path.basename(filePath);
  const idFromName = basename.match(ID_PATTERN_CAPTURING);

  const id = legacy.id || (idFromName ? idFromName[0] : '');
  if (!id) return null;
  const type = (legacy.type || (idFromName ? idFromName[1] : 'ADR')) as DocumentType;

  return {
    id,
    title: legacy.title || id,
    type,
    status: legacy.status || 'Accepted',
    version: 1,
    date: legacy.date || today,
    last_reviewed: today,
    implements: legacy.implementsIds,
    implemented_by: [],
  };
}

export function injectFrontmatter(content: string, fm: DocumentFrontmatter): string {
  if (hasFrontmatter(content)) return content;
  return serialize(fm) + '\n' + content;
}
