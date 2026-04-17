/**
 * HtmlReviewSite — renders the full review report as a static site under
 * `.specflow/review/`. Implements the `specflow review --html` half of
 * ADR-016.
 *
 * Design choices:
 *   - Hand-rolled HTML/CSS/SVG. No build step, no npm dev-deps, no CDN pulls
 *     (no integrity headaches, no network dependency in CI).
 *   - One file per view — `index.html` links to sibling tables and the
 *     graph. Keeps each page small and grep-able.
 *   - `data.json` is the same shape `review --json` emits, so the graph
 *     page can reload content without a rebuild.
 *   - All writes go through `DocumentWriter.writeAtomic` (ADR-013 D13-5)
 *     so a crash during generation leaves the previous site intact.
 *   - Re-running is idempotent — we overwrite every known file rather than
 *     leaving stale ones behind.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentRepository } from './document-repository';
import { ReviewItem, ReviewReport, ReviewReporter } from './review-reporter';
import { getDefaultDocumentWriter } from './document-writer';

export interface HtmlSiteOptions {
  /** Project root — the site lives under `<root>/.specflow/review/`. */
  projectRoot: string;
  /** Optional generated-at override for stable tests. */
  now?: Date;
  /** Owner filter, applied before rendering. */
  ownerFilter?: string;
}

export interface HtmlSiteResult {
  outputDir: string;
  files: string[];
}

export function generateHtmlSite(
  repo: DocumentRepository,
  options: HtmlSiteOptions
): HtmlSiteResult {
  const now = options.now || new Date();
  const outputDir = path.join(options.projectRoot, '.specflow', 'review');
  const assetsDir = path.join(outputDir, 'assets');
  ensureDir(outputDir);
  ensureDir(assetsDir);

  const reporter = new ReviewReporter(repo, now);
  const report = reporter.generate();

  let items = report.items;
  if (options.ownerFilter) {
    items = items.filter(i => hasOwner(repo, i, options.ownerFilter!));
  }

  const writer = getDefaultDocumentWriter();
  const written: string[] = [];

  const write = (relPath: string, content: string) => {
    const full = path.join(outputDir, relPath);
    writer.writeAtomic(full, content);
    written.push(full);
  };

  write('assets/style.css', renderCss());
  write('data.json', JSON.stringify({ report, items, generatedAt: now.toISOString() }, null, 2));
  write('index.html', renderIndex(report, items, options));
  write('overdue.html', renderTable('Overdue Docs', 'overdue', items, options.projectRoot));
  write('orphaned.html', renderTable('Orphaned Docs', 'orphaned', items, options.projectRoot));
  write('stale-links.html', renderTable('Docs With Stale Links', 'stale_links', items, options.projectRoot));
  write('graph.html', renderGraph(repo, items));

  return { outputDir, files: written };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function hasOwner(repo: DocumentRepository, item: ReviewItem, owner: string): boolean {
  const doc = repo.get(item.id);
  if (!doc) return false;
  const list = doc.frontmatter.owned_by || [];
  return list.includes(owner);
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// CSS — minimal, responsive, no external dep.
// ---------------------------------------------------------------------------

function renderCss(): string {
  return `:root {
  --bg: #fafafa;
  --fg: #222;
  --dim: #666;
  --accent: #2d6cdf;
  --warn: #d97706;
  --bad: #c0362c;
  --good: #16803c;
  --border: #ddd;
  --card: #fff;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--fg);
  background: var(--bg);
  line-height: 1.5;
}
header {
  background: var(--card);
  border-bottom: 1px solid var(--border);
  padding: 1rem 1.25rem;
}
header h1 { font-size: 1.25rem; margin: 0; }
header .meta { color: var(--dim); font-size: 0.875rem; }
nav {
  padding: 0.5rem 1.25rem;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
nav a {
  color: var(--accent);
  text-decoration: none;
  font-size: 0.9rem;
}
nav a:hover { text-decoration: underline; }
main { padding: 1.25rem; max-width: 1100px; margin: 0 auto; }
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.9rem 1rem;
}
.card .label { color: var(--dim); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
.card .value { font-size: 1.6rem; font-weight: 600; margin-top: 0.25rem; }
.card.bad .value { color: var(--bad); }
.card.warn .value { color: var(--warn); }
.card.good .value { color: var(--good); }
table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border: 1px solid var(--border);
}
th, td {
  text-align: left;
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.9rem;
}
th {
  background: #f3f3f3;
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  color: var(--dim);
}
tr:last-child td { border-bottom: 0; }
.empty {
  padding: 1.5rem;
  color: var(--dim);
  font-style: italic;
  text-align: center;
}
svg.graph { width: 100%; height: 560px; background: var(--card); border: 1px solid var(--border); border-radius: 6px; }
svg.graph circle { stroke: var(--border); stroke-width: 1; }
svg.graph line { stroke: #bbb; stroke-width: 1; }
svg.graph text { font-size: 10px; fill: var(--fg); }
@media (max-width: 640px) {
  main { padding: 0.75rem; }
  nav { padding: 0.5rem 0.75rem; }
  header { padding: 0.75rem 1rem; }
  th, td { padding: 0.4rem 0.5rem; font-size: 0.82rem; }
}
`;
}

// ---------------------------------------------------------------------------
// Page renderers
// ---------------------------------------------------------------------------

function renderShell(title: string, bodyHtml: string, report?: ReviewReport): string {
  const meta = report ? `Generated ${esc(report.generatedAt)}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} — Specflow Review</title>
<link rel="stylesheet" href="assets/style.css"/>
</head>
<body>
<header>
  <h1>Specflow Review</h1>
  <div class="meta">${meta}</div>
</header>
<nav>
  <a href="index.html">Summary</a>
  <a href="overdue.html">Overdue</a>
  <a href="orphaned.html">Orphaned</a>
  <a href="stale-links.html">Stale links</a>
  <a href="graph.html">Graph</a>
</nav>
<main>
${bodyHtml}
</main>
</body>
</html>
`;
}

function renderIndex(report: ReviewReport, items: ReviewItem[], options: HtmlSiteOptions): string {
  const c = report.counts;
  const cards = [
    card('Accepted', c.accepted, 'good'),
    card('Current', c.current, 'good'),
    card('Overdue', c.overdue, c.overdue > 0 ? 'warn' : 'good'),
    card('Orphaned', c.orphaned, c.orphaned > 0 ? 'warn' : 'good'),
    card('Stale links', c.staleLinks, c.staleLinks > 0 ? 'warn' : 'good'),
    card('Soft-deleted', c.softDeleted, ''),
  ].join('\n');

  const ownerNote = options.ownerFilter
    ? `<p class="meta">Filtered to owner <strong>${esc(options.ownerFilter)}</strong> (${items.length} docs).</p>`
    : '';

  const body = `
<section>
  <h2>Counts</h2>
  <div class="cards">
${cards}
  </div>
</section>
${ownerNote}
<section>
  <h2>All docs</h2>
  ${renderItemsTable(items, options.projectRoot)}
</section>
`;
  return renderShell('Summary', body, report);
}

function card(label: string, value: number, mood: string): string {
  return `    <div class="card ${mood}">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
    </div>`;
}

function renderTable(title: string, classification: string, items: ReviewItem[], projectRoot: string): string {
  const filtered = items.filter(i => i.classification === classification);
  const body = filtered.length === 0
    ? `<div class="empty">No docs in this state.</div>`
    : renderItemsTable(filtered, projectRoot);
  return renderShell(title, `<h2>${esc(title)}</h2>${body}`);
}

function renderItemsTable(items: ReviewItem[], projectRoot: string): string {
  const rows = items.map(i => {
    const rel = path.relative(projectRoot, i.filePath).replace(/\\/g, '/');
    return `      <tr>
        <td><strong>${esc(i.id)}</strong></td>
        <td>${esc(i.status)}</td>
        <td>${esc(i.classification)}</td>
        <td>${esc(i.last_reviewed)}</td>
        <td>${esc(i.ageDays)}</td>
        <td><code>${esc(rel)}</code></td>
      </tr>`;
  }).join('\n');
  return `<table>
  <thead>
    <tr><th>ID</th><th>Status</th><th>Bucket</th><th>Last reviewed</th><th>Age (d)</th><th>Path</th></tr>
  </thead>
  <tbody>
${rows || `      <tr><td colspan="6" class="empty">None.</td></tr>`}
  </tbody>
</table>`;
}

// ---------------------------------------------------------------------------
// Graph renderer — hand-rolled deterministic SVG force layout. We don't need a
// true force-directed solve; an annular arrangement keyed by doc type is more
// legible and, crucially, deterministic (tests can diff the output).
// ---------------------------------------------------------------------------

function renderGraph(repo: DocumentRepository, items: ReviewItem[]): string {
  const docs = repo.all();
  const width = 960;
  const height = 560;
  const cx = width / 2;
  const cy = height / 2;

  // Cluster nodes by type so the layout is stable; radius per ring by type.
  const ringByType: Record<string, number> = { ADR: 220, PRD: 140, DDD: 280 };
  const ringCounts: Record<string, number> = {};
  for (const d of docs) ringCounts[d.frontmatter.type] = (ringCounts[d.frontmatter.type] || 0) + 1;

  const positions = new Map<string, { x: number; y: number; fill: string }>();
  const ringIdx: Record<string, number> = {};
  for (const doc of docs.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const type = doc.frontmatter.type;
    const r = ringByType[type] || 180;
    const total = ringCounts[type] || 1;
    const idx = (ringIdx[type] = (ringIdx[type] || 0) + 1) - 1;
    const angle = (idx / Math.max(total, 1)) * Math.PI * 2;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    const fill = colourFor(doc.frontmatter.status);
    positions.set(doc.id, { x, y, fill });
  }

  const edges: string[] = [];
  for (const doc of docs) {
    const from = positions.get(doc.id);
    if (!from) continue;
    for (const targetId of doc.frontmatter.implements || []) {
      const to = positions.get(targetId);
      if (!to) continue;
      edges.push(`<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}"/>`);
    }
  }

  const nodes = docs.map(doc => {
    const p = positions.get(doc.id);
    if (!p) return '';
    return `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="9" fill="${p.fill}"/>` +
      `<text x="${(p.x + 11).toFixed(1)}" y="${(p.y + 4).toFixed(1)}">${esc(doc.id)}</text></g>`;
  }).join('\n');

  const legend = `
    <g transform="translate(16,16)">
      <rect width="160" height="88" fill="#fff" stroke="#ddd"/>
      <text x="10" y="20" font-weight="bold">Legend</text>
      <circle cx="18" cy="38" r="6" fill="${colourFor('Accepted')}"/><text x="32" y="42">Accepted</text>
      <circle cx="18" cy="56" r="6" fill="${colourFor('Draft')}"/><text x="32" y="60">Draft</text>
      <circle cx="18" cy="74" r="6" fill="${colourFor('Superseded')}"/><text x="32" y="78">Superseded / Deprecated</text>
    </g>
  `;

  const svg = `<svg class="graph" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Specflow document link graph">
${edges.join('\n')}
${nodes}
${legend}
</svg>`;

  const body = `<h2>Document link graph</h2>
<p class="meta">Edges follow the <code>implements</code> relation; node colour encodes status. Full data in <a href="data.json"><code>data.json</code></a>.</p>
${svg}
<p class="meta">Showing ${esc(docs.length)} docs across ${esc(items.length)} review rows.</p>`;
  return renderShell('Graph', body);
}

function colourFor(status: string): string {
  switch (status) {
    case 'Accepted':
      return '#2d6cdf';
    case 'Draft':
      return '#16803c';
    case 'Superseded':
    case 'Deprecated':
      return '#9ca3af';
    default:
      return '#c0362c';
  }
}
