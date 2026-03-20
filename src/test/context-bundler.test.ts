import * as assert from 'assert';

/**
 * Unit tests for the rolling size-based chunking logic introduced in ContextBundler.
 *
 * The bundler is I/O-heavy, so these tests reimplement the pure chunk-assignment
 * algorithm inline — the same pattern used throughout this test suite — and verify
 * the invariants independently of the file system or docx library.
 */

/**
 * Pure reimplementation of the chunk assignment logic from bundleWorkspaceContext.
 * Returns an array where each element is the 1-based chunk index the corresponding
 * input file was assigned to.
 */
function simulateChunkAssignment(fileSizes: number[], chunkLimit: number): number[] {
    const assignments: number[] = [];
    let chunkIndex = 1;
    let currentBytes = 0;

    for (const sizeBytes of fileSizes) {
        if (sizeBytes > chunkLimit) {
            // Large file: flush current buffer first, then give this file its own chunk.
            if (currentBytes > 0) {
                chunkIndex++;
                currentBytes = 0;
            }
            assignments.push(chunkIndex);
            chunkIndex++;
            // Next file starts a fresh chunk (currentBytes stays 0).
        } else {
            // Normal file: flush if adding would exceed limit.
            if (currentBytes > 0 && currentBytes + sizeBytes > chunkLimit) {
                chunkIndex++;
                currentBytes = 0;
            }
            assignments.push(chunkIndex);
            currentBytes += sizeBytes;
        }
    }

    return assignments;
}

suite('ContextBundler — rolling chunk assignment', () => {

    test('All small files that fit in one chunk stay in chunk 1', () => {
        const sizes = [100, 200, 100]; // total 400 < 500 limit
        const result = simulateChunkAssignment(sizes, 500);
        assert.deepStrictEqual(result, [1, 1, 1]);
    });

    test('Files that together exceed the limit split across two chunks', () => {
        const sizes = [300, 300]; // 300 < 500, but 300+300=600 > 500
        const result = simulateChunkAssignment(sizes, 500);
        assert.strictEqual(result[0], 1);
        assert.strictEqual(result[1], 2);
    });

    test('Exactly at the limit does NOT trigger a flush (uses >, not >=)', () => {
        // 300 + 200 = 500, which is NOT > 500, so they should stay in one chunk.
        const sizes = [300, 200];
        const result = simulateChunkAssignment(sizes, 500);
        assert.deepStrictEqual(result, [1, 1]);
    });

    test('One byte over the limit triggers a flush', () => {
        // 300 + 201 = 501 > 500, so second file spills to chunk 2.
        const sizes = [300, 201];
        const result = simulateChunkAssignment(sizes, 500);
        assert.strictEqual(result[0], 1);
        assert.strictEqual(result[1], 2);
    });

    test('Large file (> limit) as the first and only file goes into chunk 1', () => {
        const sizes = [600]; // > 500 limit
        const result = simulateChunkAssignment(sizes, 500);
        assert.deepStrictEqual(result, [1]);
    });

    test('Large file mid-stream: preceding buffer is flushed to its own chunk first', () => {
        // A(300) → chunk1, B(600, large) → flushes chunk1, gets chunk2, C(200) → chunk3
        const sizes = [300, 600, 200];
        const result = simulateChunkAssignment(sizes, 500);
        assert.strictEqual(result[0], 1, 'A should be in chunk 1');
        assert.strictEqual(result[1], 2, 'B (large) should be in dedicated chunk 2');
        assert.strictEqual(result[2], 3, 'C should start fresh in chunk 3');
    });

    test('Large file when buffer is empty does not produce an empty phantom chunk', () => {
        // Buffer is empty → no flush needed before the large file → it goes in chunk 1.
        const sizes = [600, 200];
        const result = simulateChunkAssignment(sizes, 500);
        assert.strictEqual(result[0], 1, 'Large file should be chunk 1 when buffer is empty');
        assert.strictEqual(result[1], 2, 'Next file starts chunk 2 after the dedicated chunk');
    });

    test('Multiple large files each get their own dedicated chunk', () => {
        const sizes = [600, 700, 800]; // all > 500 limit
        const result = simulateChunkAssignment(sizes, 500);
        assert.deepStrictEqual(result, [1, 2, 3]);
    });

    test('Files pack tightly: no premature splits when bytes accumulate exactly to limit', () => {
        // 5 files of 100 bytes each into a 500-byte limit — all fit in chunk 1.
        const sizes = [100, 100, 100, 100, 100];
        const result = simulateChunkAssignment(sizes, 500);
        assert.ok(result.every(i => i === 1), 'All five 100-byte files should fit in chunk 1');
    });

    test('6th file spills to chunk 2 when chunk 1 is exactly full', () => {
        // First 5 files fill chunk 1 to exactly 500. 6th file (any size) spills.
        const sizes = [100, 100, 100, 100, 100, 50];
        const result = simulateChunkAssignment(sizes, 500);
        assert.ok(result.slice(0, 5).every(i => i === 1), 'Files 1-5 should be in chunk 1');
        assert.strictEqual(result[5], 2, 'File 6 should spill to chunk 2');
    });

    test('Empty file list produces no assignments', () => {
        const result = simulateChunkAssignment([], 500);
        assert.deepStrictEqual(result, []);
    });

    test('Mixed: small files, a large file, then more small files', () => {
        // A(200), B(250) → fit in chunk 1 (total 450 < 500)
        // C(600, large) → flush chunk 1, dedicated chunk 2
        // D(100), E(300) → fit in chunk 3 (total 400 < 500)
        const sizes = [200, 250, 600, 100, 300];
        const result = simulateChunkAssignment(sizes, 500);
        assert.strictEqual(result[0], 1, 'A → chunk 1');
        assert.strictEqual(result[1], 1, 'B → chunk 1');
        assert.strictEqual(result[2], 2, 'C (large) → dedicated chunk 2');
        assert.strictEqual(result[3], 3, 'D → chunk 3');
        assert.strictEqual(result[4], 3, 'E → chunk 3');
    });

    test('No files are dropped — total file count matches total assignments', () => {
        const sizes = [300, 600, 200, 700, 100, 400, 800, 50];
        const result = simulateChunkAssignment(sizes, 500);
        assert.strictEqual(result.length, sizes.length, 'Every file must have a chunk assignment');
    });
});
