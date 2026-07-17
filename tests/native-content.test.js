import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isUsableNativeContentBlock,
    sanitizeClaudeSourceMessages,
    sanitizeNativeContentBlocks,
    sanitizeNativeMessages,
    toNativeContentBlocks,
} from '../native-content.js';

test('string content never creates an empty Anthropic text block', () => {
    assert.deepEqual(toNativeContentBlocks(''), []);
    assert.deepEqual(toNativeContentBlocks(' \n\t '), []);
    assert.deepEqual(toNativeContentBlocks('system prompt'), [
        { type: 'text', text: 'system prompt' },
    ]);
});

test('array content drops blank text while retaining valid and non-text blocks', () => {
    const blocks = toNativeContentBlocks([
        null,
        { type: 'text', text: '' },
        { type: 'text', text: '   ' },
        { type: 'text', text: 'valid', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'tool_result', tool_use_id: 'tool-1', content: '' },
    ]);

    assert.deepEqual(blocks, [
        { type: 'text', text: 'valid' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: '' },
    ]);
});

test('persisted journal blocks are sanitized without losing cache breakpoints', () => {
    const blocks = sanitizeNativeContentBlocks([
        { type: 'text', text: 'compatibility prefix' },
        { type: 'text', text: '', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'preset', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);

    assert.equal(blocks.length, 2);
    assert.equal(blocks[1].text, 'preset');
    assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.ok(blocks.every(isUsableNativeContentBlock));
});

test('old conversation journals cannot reintroduce empty message content', () => {
    const messages = sanitizeNativeMessages([
        { role: 'user', content: [{ type: 'text', text: '' }] },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'answer' },
                { type: 'text', text: '\n ' },
            ],
        },
    ]);

    assert.deepEqual(messages[0].content, [{ type: 'text', text: '...' }]);
    assert.deepEqual(messages[1].content, [{ type: 'text', text: 'answer' }]);
});

test('final request cleanup removes the reported empty system regression', () => {
    const request = {
        system: sanitizeNativeContentBlocks([
            { type: 'text', text: 'Claude Code compatibility marker' },
            { type: 'text', text: '' },
            { type: 'text', text: '<SYSTEM_DESCRIPTION>valid preset</SYSTEM_DESCRIPTION>' },
        ]),
        messages: sanitizeNativeMessages([
            { role: 'user', content: '' },
        ]),
    };

    assert.deepEqual(request.system.map(block => block.text), [
        'Claude Code compatibility marker',
        '<SYSTEM_DESCRIPTION>valid preset</SYSTEM_DESCRIPTION>',
    ]);
    assert.ok(request.system.every(isUsableNativeContentBlock));
    assert.ok(request.messages.flatMap(message => message.content).every(isUsableNativeContentBlock));
});

test('OpenAI-compatible fallback drops empty system prompts before proxy conversion', () => {
    const messages = sanitizeClaudeSourceMessages([
        { role: 'system', content: '' },
        { role: 'system', content: [{ type: 'text', text: ' \n ' }] },
        { role: 'system', content: 'valid system' },
        { role: 'user', content: '' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1' }] },
    ]);

    assert.deepEqual(messages, [
        { role: 'system', content: 'valid system' },
        { role: 'user', content: '...' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1' }] },
    ]);
});
