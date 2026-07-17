import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applyTextSequencePatch,
    buildTextSequencePatch,
    journalRebaseDecision,
} from '../journal-patch.js';

test('a small edit inside a large block stays small and reconstructs exactly', () => {
    const stableLines = Array.from({ length: 4_000 }, (_, index) => `stable rule ${index}: keep this value\n`);
    const previous = stableLines.join('');
    const currentLines = [...stableLines];
    currentLines[1_000] = 'stable rule 1000: updated live state A\n';
    currentLines[2_000] = 'stable rule 2000: updated live state B\n';
    currentLines[3_000] = 'stable rule 3000: updated live state C\n';
    const current = currentLines.join('');

    const patch = buildTextSequencePatch([previous], [current]);

    assert.deepEqual(applyTextSequencePatch([previous], patch.operations), [current]);
    assert.equal(patch.patched_blocks, 1);
    assert.ok(patch.serialized_chars < current.length * 0.02);
});

test('inserted and removed blocks do not force unchanged blocks into the patch', () => {
    const previous = ['alpha'.repeat(1_000), 'stable'.repeat(1_000), 'removed'.repeat(1_000)];
    const current = ['new'.repeat(500), previous[0], previous[1]];

    const patch = buildTextSequencePatch(previous, current);

    assert.deepEqual(applyTextSequencePatch(previous, patch.operations), current);
    assert.equal(patch.reused_blocks, 2);
    assert.ok(patch.serialized_chars < JSON.stringify(current).length / 2);
});

test('many dynamic blocks with small per-line changes use patches instead of full snapshots', () => {
    const previous = Array.from({ length: 12 }, (_, blockIndex) => (
        Array.from({ length: 300 }, (_, lineIndex) => `block=${blockIndex} field=${lineIndex} value=stable\n`).join('')
    ));
    const current = previous.map((text, blockIndex) => (
        text.replace(`block=${blockIndex} field=150 value=stable`, `block=${blockIndex} field=150 value=turn-2`)
    ));

    const patch = buildTextSequencePatch(previous, current);

    assert.deepEqual(applyTextSequencePatch(previous, patch.operations), current);
    assert.equal(patch.patched_blocks, 12);
    assert.equal(patch.replaced_blocks, 0);
    assert.ok(patch.serialized_chars < JSON.stringify(current).length * 0.08);
});

test('wholesale replacement falls back to a full replacement operation', () => {
    const previous = ['a'.repeat(20_000)];
    const current = ['z'.repeat(20_000)];
    const patch = buildTextSequencePatch(previous, current);

    assert.deepEqual(applyTextSequencePatch(previous, patch.operations), current);
    assert.equal(patch.replaced_blocks, 1);
});

test('adaptive rebase keeps small patches and rejects pathological revisions', () => {
    assert.deepEqual(journalRebaseDecision({
        currentChars: 250_000,
        appendedChars: 2_000,
        accumulatedChars: 20_000,
        hardLimitChars: 600_000,
        maxRevisionChars: 80_000,
    }), { rebase: false, reason: '' });

    assert.deepEqual(journalRebaseDecision({
        currentChars: 250_000,
        appendedChars: 180_000,
        accumulatedChars: 180_000,
        hardLimitChars: 600_000,
        maxRevisionChars: 80_000,
    }), { rebase: true, reason: 'large-revision' });
});

test('sequence patches reconstruct deterministic insert, delete, edit, and reorder cases', () => {
    let state = 0x5eed1234;
    const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };

    for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
        const previous = Array.from({ length: 2 + Math.floor(random() * 7) }, (_, blockIndex) => (
            Array.from({ length: 3 + Math.floor(random() * 8) }, (_, lineIndex) => (
                `case=${caseIndex} block=${blockIndex} line=${lineIndex} value=stable\n`
            )).join('')
        ));
        const current = [...previous];
        const mutationCount = 1 + Math.floor(random() * 5);
        for (let mutation = 0; mutation < mutationCount; mutation++) {
            const action = Math.floor(random() * 4);
            if (action === 0 || !current.length) {
                const index = Math.floor(random() * (current.length + 1));
                current.splice(index, 0, `inserted case=${caseIndex} mutation=${mutation}\n`);
            } else if (action === 1 && current.length > 1) {
                current.splice(Math.floor(random() * current.length), 1);
            } else if (action === 2) {
                const index = Math.floor(random() * current.length);
                current[index] = current[index].replace('value=stable', `value=changed-${mutation}`);
            } else if (current.length > 1) {
                const from = Math.floor(random() * current.length);
                const [moved] = current.splice(from, 1);
                current.splice(Math.floor(random() * (current.length + 1)), 0, moved);
            }
        }

        const patch = buildTextSequencePatch(previous, current);
        assert.deepEqual(applyTextSequencePatch(previous, patch.operations), current, `case ${caseIndex}`);
    }
});
