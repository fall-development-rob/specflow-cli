/**
 * DocumentWriter — atomic write port for all doc-writing code paths.
 *
 * Implements ADR-013 D13-5 (atomic writes) and ADR-011 E11-8 (atomic writes
 * required). The port exposes `writeAtomic`; the default `FsDocumentWriter`
 * implementation writes to a sibling tempfile, fsyncs, and renames.
 *
 * Tests may substitute a mock writer via `setDefaultDocumentWriter`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Port for atomic document writes.
 *
 * An atomic write guarantees that after the call returns, either:
 *   (a) the target file contains the full new content, or
 *   (b) the target file is unchanged.
 *
 * A crash, SIGTERM, disk-full, or concurrent writer mid-write must never
 * leave the target truncated or partially written.
 */
export interface DocumentWriter {
  writeAtomic(filePath: string, content: string): void;
}

/**
 * Filesystem-backed atomic writer.
 *
 * Algorithm:
 *   1. Ensure parent dir exists.
 *   2. Write content to a sibling tempfile with a random suffix.
 *   3. fsync the tempfile so bytes hit the disk before rename.
 *   4. rename(tmp, target) — POSIX guarantees this is atomic on the same FS.
 *   5. On error, unlink the tempfile best-effort.
 */
export class FsDocumentWriter implements DocumentWriter {
  writeAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const suffix = crypto.randomBytes(6).toString('hex');
    const base = path.basename(filePath);
    const tmpPath = path.join(dir, `.${base}.${suffix}.tmp`);

    let fd: number | null = null;
    try {
      // Open-and-write so we can fsync the fd before rename.
      fd = fs.openSync(tmpPath, 'w', 0o644);
      fs.writeFileSync(fd, content, { encoding: 'utf-8' });
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync is best-effort on some filesystems (e.g. tmpfs on some kernels).
        // Ignore; rename still provides the atomic swap.
      }
      fs.closeSync(fd);
      fd = null;

      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      // Best-effort cleanup — tempfile must not leak on failure.
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level default writer — a lightweight service-locator pattern so
// production code can call `getDefaultDocumentWriter().writeAtomic(...)`
// and tests can swap in a mock via `setDefaultDocumentWriter(...)`.
// No DI framework; just a swappable global.
// ---------------------------------------------------------------------------

let defaultWriter: DocumentWriter = new FsDocumentWriter();

export function getDefaultDocumentWriter(): DocumentWriter {
  return defaultWriter;
}

export function setDefaultDocumentWriter(writer: DocumentWriter): void {
  defaultWriter = writer;
}

export function resetDefaultDocumentWriter(): void {
  defaultWriter = new FsDocumentWriter();
}
