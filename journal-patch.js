const DEFAULT_MAX_DIFF_CELLS = 250_000;
const PATCH_CONTEXT_CHARS = 64;
const INLINE_REMOVED_TEXT_CHARS = 160;

export function hashJournalText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function fallbackMatches(previous, current) {
    const matches = [];
    const limit = Math.min(previous.length, current.length);
    let prefix = 0;
    while (prefix < limit && previous[prefix] === current[prefix]) {
        matches.push([prefix, prefix]);
        prefix++;
    }

    const suffix = [];
    let previousIndex = previous.length - 1;
    let currentIndex = current.length - 1;
    while (previousIndex >= prefix && currentIndex >= prefix && previous[previousIndex] === current[currentIndex]) {
        suffix.push([previousIndex, currentIndex]);
        previousIndex--;
        currentIndex--;
    }
    return [...matches, ...suffix.reverse()];
}

function uniqueTokenIndexes(values) {
    const entries = new Map();
    for (let index = 0; index < values.length; index++) {
        const value = values[index];
        const entry = entries.get(value);
        if (entry) entry.count++;
        else entries.set(value, { count: 1, index });
    }
    return entries;
}

function longestIncreasingPairs(pairs) {
    const tailValues = [];
    const tailPairIndexes = [];
    const predecessors = new Int32Array(pairs.length).fill(-1);
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
        const currentIndex = pairs[pairIndex][1];
        let low = 0;
        let high = tailValues.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (tailValues[middle] < currentIndex) low = middle + 1;
            else high = middle;
        }
        if (low > 0) predecessors[pairIndex] = tailPairIndexes[low - 1];
        tailValues[low] = currentIndex;
        tailPairIndexes[low] = pairIndex;
    }

    const matches = [];
    let pairIndex = tailPairIndexes[tailPairIndexes.length - 1] ?? -1;
    while (pairIndex >= 0) {
        matches.push(pairs[pairIndex]);
        pairIndex = predecessors[pairIndex];
    }
    return matches.reverse();
}

function patienceMatches(previous, current) {
    const previousEntries = uniqueTokenIndexes(previous);
    const currentEntries = uniqueTokenIndexes(current);
    const uniquePairs = [];
    for (const [value, previousEntry] of previousEntries) {
        const currentEntry = currentEntries.get(value);
        if (previousEntry.count === 1 && currentEntry?.count === 1) {
            uniquePairs.push([previousEntry.index, currentEntry.index]);
        }
    }
    uniquePairs.sort((left, right) => left[0] - right[0]);
    const anchors = longestIncreasingPairs(uniquePairs);
    if (!anchors.length) return fallbackMatches(previous, current);

    const matches = [];
    let previousCursor = 0;
    let currentCursor = 0;
    for (const [previousAnchor, currentAnchor] of [...anchors, [previous.length, current.length]]) {
        const gapMatches = fallbackMatches(
            previous.slice(previousCursor, previousAnchor),
            current.slice(currentCursor, currentAnchor),
        );
        matches.push(...gapMatches.map(([previousIndex, currentIndex]) => (
            [previousCursor + previousIndex, currentCursor + currentIndex]
        )));
        if (previousAnchor < previous.length && currentAnchor < current.length) {
            matches.push([previousAnchor, currentAnchor]);
        }
        previousCursor = previousAnchor + 1;
        currentCursor = currentAnchor + 1;
    }
    return matches;
}

function exactLcsMatches(previous, current, maxCells = DEFAULT_MAX_DIFF_CELLS) {
    if (previous.length * current.length > maxCells) return patienceMatches(previous, current);

    const rows = Array.from({ length: previous.length + 1 }, () => new Uint32Array(current.length + 1));
    for (let previousIndex = previous.length - 1; previousIndex >= 0; previousIndex--) {
        for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex--) {
            rows[previousIndex][currentIndex] = previous[previousIndex] === current[currentIndex]
                ? rows[previousIndex + 1][currentIndex + 1] + 1
                : Math.max(rows[previousIndex + 1][currentIndex], rows[previousIndex][currentIndex + 1]);
        }
    }

    const matches = [];
    let previousIndex = 0;
    let currentIndex = 0;
    while (previousIndex < previous.length && currentIndex < current.length) {
        if (previous[previousIndex] === current[currentIndex]) {
            matches.push([previousIndex, currentIndex]);
            previousIndex++;
            currentIndex++;
        } else if (rows[previousIndex + 1][currentIndex] >= rows[previousIndex][currentIndex + 1]) {
            previousIndex++;
        } else {
            currentIndex++;
        }
    }
    return matches;
}

function splitLinesWithEndings(text) {
    return String(text ?? '').match(/[^\n]*\n|[^\n]+$/g) || [];
}

function tokenOffsets(tokens) {
    const offsets = new Uint32Array(tokens.length + 1);
    for (let index = 0; index < tokens.length; index++) offsets[index + 1] = offsets[index] + tokens[index].length;
    return offsets;
}

function makeTextEdit(previous, start, deleteCount, insertText) {
    const removedText = previous.slice(start, start + deleteCount);
    const edit = {
        start,
        delete_count: deleteCount,
        insert_text: insertText,
        before_context: previous.slice(Math.max(0, start - PATCH_CONTEXT_CHARS), start),
        after_context: previous.slice(start + deleteCount, start + deleteCount + PATCH_CONTEXT_CHARS),
    };
    if (removedText.length <= INLINE_REMOVED_TEXT_CHARS) edit.removed_text = removedText;
    return edit;
}

function commonAffixEdit(previous, current) {
    const limit = Math.min(previous.length, current.length);
    let prefix = 0;
    while (prefix < limit && previous[prefix] === current[prefix]) prefix++;

    let previousSuffix = previous.length;
    let currentSuffix = current.length;
    while (previousSuffix > prefix && currentSuffix > prefix
        && previous[previousSuffix - 1] === current[currentSuffix - 1]) {
        previousSuffix--;
        currentSuffix--;
    }
    return [makeTextEdit(
        previous,
        prefix,
        previousSuffix - prefix,
        current.slice(prefix, currentSuffix),
    )];
}

function linePatchEdits(previous, current, maxCells) {
    const previousLines = splitLinesWithEndings(previous);
    const currentLines = splitLinesWithEndings(current);
    if (!previousLines.length || !currentLines.length) return commonAffixEdit(previous, current);

    const matches = exactLcsMatches(previousLines, currentLines, maxCells);
    if (!matches.length) return commonAffixEdit(previous, current);

    const previousOffsets = tokenOffsets(previousLines);
    const edits = [];
    let previousCursor = 0;
    let currentCursor = 0;
    for (const [previousMatch, currentMatch] of [...matches, [previousLines.length, currentLines.length]]) {
        if (previousMatch > previousCursor || currentMatch > currentCursor) {
            const start = previousOffsets[previousCursor];
            const deleteCount = previousOffsets[previousMatch] - start;
            const insertText = currentLines.slice(currentCursor, currentMatch).join('');
            edits.push(makeTextEdit(previous, start, deleteCount, insertText));
        }
        previousCursor = previousMatch + 1;
        currentCursor = currentMatch + 1;
    }
    return edits.reverse();
}

export function buildTextEdits(previousValue, currentValue, { maxCells = DEFAULT_MAX_DIFF_CELLS } = {}) {
    const previous = String(previousValue ?? '');
    const current = String(currentValue ?? '');
    if (previous === current) return [];

    const byLines = linePatchEdits(previous, current, maxCells);
    const byAffix = commonAffixEdit(previous, current);
    return JSON.stringify(byLines).length <= JSON.stringify(byAffix).length ? byLines : byAffix;
}

export function applyTextEdits(baseValue, edits) {
    let text = String(baseValue ?? '');
    const ordered = [...(Array.isArray(edits) ? edits : [])]
        .sort((left, right) => Number(right?.start || 0) - Number(left?.start || 0));
    for (const edit of ordered) {
        const start = Number(edit?.start || 0);
        const deleteCount = Number(edit?.delete_count || 0);
        text = text.slice(0, start) + String(edit?.insert_text ?? '') + text.slice(start + deleteCount);
    }
    return text;
}

function buildBlockChange(previous, current, baseBlockIndex) {
    const edits = buildTextEdits(previous, current);
    const patch = {
        type: 'patch_block_text',
        base_block_index: baseBlockIndex,
        base_text_digest: hashJournalText(previous),
        current_text_digest: hashJournalText(current),
        edits,
    };
    const replacement = {
        type: 'replace_block',
        base_block_index: baseBlockIndex,
        current_text: current,
    };
    return JSON.stringify(patch).length < JSON.stringify(replacement).length * 0.8 ? patch : replacement;
}

function operationBaseIndex(operation) {
    return operation.type === 'splice_blocks'
        ? Number(operation.base_start_index || 0)
        : Number(operation.base_block_index || 0);
}

export function buildTextSequencePatch(previousValues, currentValues, { maxCells = DEFAULT_MAX_DIFF_CELLS } = {}) {
    const previous = (Array.isArray(previousValues) ? previousValues : []).map(value => String(value ?? ''));
    const current = (Array.isArray(currentValues) ? currentValues : []).map(value => String(value ?? ''));
    const matches = exactLcsMatches(previous, current, maxCells);
    const operations = [];
    let previousCursor = 0;
    let currentCursor = 0;

    for (const [previousMatch, currentMatch] of [...matches, [previous.length, current.length]]) {
        const removedCount = previousMatch - previousCursor;
        const insertedCount = currentMatch - currentCursor;
        const pairedCount = Math.min(removedCount, insertedCount);

        for (let offset = 0; offset < pairedCount; offset++) {
            operations.push(buildBlockChange(
                previous[previousCursor + offset],
                current[currentCursor + offset],
                previousCursor + offset,
            ));
        }

        const extraRemoved = removedCount - pairedCount;
        const extraInserted = insertedCount - pairedCount;
        if (extraRemoved > 0 || extraInserted > 0) {
            operations.push({
                type: 'splice_blocks',
                base_start_index: previousCursor + pairedCount,
                delete_count: extraRemoved,
                insert_blocks: current.slice(currentCursor + pairedCount, currentMatch),
            });
        }

        previousCursor = previousMatch + 1;
        currentCursor = currentMatch + 1;
    }

    operations.sort((left, right) => operationBaseIndex(right) - operationBaseIndex(left));
    return {
        base_block_count: previous.length,
        current_block_count: current.length,
        base_digest: hashJournalText(JSON.stringify(previous)),
        current_digest: hashJournalText(JSON.stringify(current)),
        operations,
        serialized_chars: JSON.stringify(operations).length,
        reused_blocks: matches.length,
        patched_blocks: operations.filter(operation => operation.type === 'patch_block_text').length,
        replaced_blocks: operations.filter(operation => operation.type === 'replace_block').length,
        spliced_blocks: operations.filter(operation => operation.type === 'splice_blocks').length,
    };
}

export function applyTextSequencePatch(previousValues, operations) {
    const values = (Array.isArray(previousValues) ? previousValues : []).map(value => String(value ?? ''));
    const ordered = [...(Array.isArray(operations) ? operations : [])]
        .sort((left, right) => operationBaseIndex(right) - operationBaseIndex(left));
    for (const operation of ordered) {
        if (operation.type === 'patch_block_text') {
            const index = Number(operation.base_block_index || 0);
            values[index] = applyTextEdits(values[index], operation.edits);
        } else if (operation.type === 'replace_block') {
            values[Number(operation.base_block_index || 0)] = String(operation.current_text ?? '');
        } else if (operation.type === 'splice_blocks') {
            values.splice(
                Number(operation.base_start_index || 0),
                Number(operation.delete_count || 0),
                ...(Array.isArray(operation.insert_blocks) ? operation.insert_blocks.map(String) : []),
            );
        }
    }
    return values;
}

export function journalRebaseDecision({
    currentChars,
    appendedChars,
    accumulatedChars,
    hardLimitChars,
    maxRevisionChars,
    revisionRatio = 0.45,
    accumulatedRatio = 0.8,
    minRelativeChars = 16_000,
}) {
    const current = Math.max(1, Number(currentChars || 0));
    const appended = Math.max(0, Number(appendedChars || 0));
    const accumulated = Math.max(0, Number(accumulatedChars || 0));
    if (accumulated > Number(hardLimitChars || Number.POSITIVE_INFINITY)) {
        return { rebase: true, reason: 'hard-limit' };
    }
    if (appended > Number(maxRevisionChars || Number.POSITIVE_INFINITY)
        && appended > Math.max(minRelativeChars, current * revisionRatio)) {
        return { rebase: true, reason: 'large-revision' };
    }
    if (accumulated > minRelativeChars && accumulated > current * accumulatedRatio) {
        return { rebase: true, reason: 'relative-bloat' };
    }
    return { rebase: false, reason: '' };
}
