import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildDirectGenerateInit,
    shouldBypassBaiBaoKuSaveGenerate,
} from '../fetch-routing.js';

test('bypasses BaiBaoKu only for streaming Anthropic-native transport', () => {
    assert.equal(shouldBypassBaiBaoKuSaveGenerate({
        isBaiBaoKuSaveGenerate: true,
        streamRequested: true,
        nativeTransport: 'anthropic-native',
    }), true);

    assert.equal(shouldBypassBaiBaoKuSaveGenerate({
        isBaiBaoKuSaveGenerate: false,
        streamRequested: true,
        nativeTransport: 'anthropic-native',
    }), false);
    assert.equal(shouldBypassBaiBaoKuSaveGenerate({
        isBaiBaoKuSaveGenerate: true,
        streamRequested: false,
        nativeTransport: 'anthropic-native',
    }), false);
    assert.equal(shouldBypassBaiBaoKuSaveGenerate({
        isBaiBaoKuSaveGenerate: true,
        streamRequested: true,
        nativeTransport: 'openai-compatible-fallback',
    }), false);
});

test('direct generate request preserves fetch controls and unwraps the body', () => {
    const controller = new AbortController();
    const headers = new Headers({ 'x-test': 'preserved' });
    const init = {
        method: 'PUT',
        headers,
        signal: controller.signal,
        credentials: 'same-origin',
        cache: 'no-store',
    };
    const body = { stream: true, model: 'claude-haiku-4-5-20251001' };

    const direct = buildDirectGenerateInit(init, body);

    assert.equal(direct.method, 'POST');
    assert.equal(direct.headers, headers);
    assert.equal(direct.signal, controller.signal);
    assert.equal(direct.credentials, 'same-origin');
    assert.equal(direct.cache, 'no-store');
    assert.deepEqual(JSON.parse(direct.body), body);
});
