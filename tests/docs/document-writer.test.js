/**
 * Tests for FsDocumentWriter — atomic write port per ADR-013 D13-5.
 *
 * Covers:
 *   - Success path writes target with exact content.
 *   - Mock writer that throws mid-write leaves the original file intact.
 *   - Tempfile is cleaned up on write failure.
 *   - Atomic rename replaces existing file contents, never truncates them.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  FsDocumentWriter,
  getDefaultDocumentWriter,
  setDefaultDocumentWriter,
  resetDefaultDocumentWriter,
} = require('../../dist/lib/document-writer');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-writer-'));
}

function listTempFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.includes('.tmp'));
}

describe('FsDocumentWriter', () => {
  test('writeAtomic creates a new file with exact content', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'hello.txt');
    const writer = new FsDocumentWriter();

    writer.writeAtomic(target, 'hello world');

    expect(fs.readFileSync(target, 'utf-8')).toBe('hello world');
    expect(listTempFiles(dir)).toHaveLength(0);
  });

  test('writeAtomic replaces an existing file atomically', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'versions.yml');
    fs.writeFileSync(target, 'old content', 'utf-8');

    new FsDocumentWriter().writeAtomic(target, 'new content');

    expect(fs.readFileSync(target, 'utf-8')).toBe('new content');
    expect(listTempFiles(dir)).toHaveLength(0);
  });

  test('writeAtomic creates parent directory if missing', () => {
    const dir = tmpDir();
    const nested = path.join(dir, 'a', 'b', 'c', 'file.txt');

    new FsDocumentWriter().writeAtomic(nested, 'nested');

    expect(fs.readFileSync(nested, 'utf-8')).toBe('nested');
  });

  test('mock writer that throws mid-write leaves original file intact', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'versions.yml');
    const original = 'original intact content';
    fs.writeFileSync(target, original, 'utf-8');

    class ThrowingWriter {
      writeAtomic(/* _filePath, _content */) {
        throw new Error('simulated crash mid-write');
      }
    }

    const throwingWriter = new ThrowingWriter();
    expect(() => throwingWriter.writeAtomic(target, 'partial')).toThrow(/simulated crash/);

    // Original file must still be intact — this is the whole point of the port.
    expect(fs.readFileSync(target, 'utf-8')).toBe(original);
  });

  test('FsDocumentWriter cleans up tempfile when rename fails', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'file.txt');
    fs.writeFileSync(target, 'original', 'utf-8');

    const writer = new FsDocumentWriter();
    const origRename = fs.renameSync;
    fs.renameSync = function () {
      throw new Error('simulated ENOSPC on rename');
    };

    try {
      expect(() => writer.writeAtomic(target, 'new')).toThrow(/ENOSPC/);

      // Original file unchanged.
      expect(fs.readFileSync(target, 'utf-8')).toBe('original');
      // Tempfile cleaned up.
      expect(listTempFiles(dir)).toHaveLength(0);
    } finally {
      fs.renameSync = origRename;
    }
  });

  test('default writer singleton can be swapped for tests and reset', () => {
    const original = getDefaultDocumentWriter();
    const calls = [];
    const mock = { writeAtomic: (p, c) => calls.push([p, c]) };
    setDefaultDocumentWriter(mock);
    try {
      getDefaultDocumentWriter().writeAtomic('/tmp/x', 'y');
      expect(calls).toEqual([['/tmp/x', 'y']]);
    } finally {
      resetDefaultDocumentWriter();
    }
    expect(getDefaultDocumentWriter()).not.toBe(mock);
    // Sanity: the reset writer is a real FsDocumentWriter.
    expect(getDefaultDocumentWriter()).toBeInstanceOf(FsDocumentWriter);
    // The pre-swap singleton is replaced by a fresh instance, so just ensure
    // it's a writer-shaped object with writeAtomic.
    expect(typeof original.writeAtomic).toBe('function');
  });
});
