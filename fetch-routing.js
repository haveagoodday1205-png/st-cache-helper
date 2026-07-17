export function shouldBypassBaiBaoKuSaveGenerate({
    isBaiBaoKuSaveGenerate,
    streamRequested,
    nativeTransport,
} = {}) {
    return isBaiBaoKuSaveGenerate === true
        && streamRequested === true
        && nativeTransport === 'anthropic-native';
}

export function buildDirectGenerateInit(init, body) {
    return {
        ...(init || {}),
        method: 'POST',
        body: JSON.stringify(body),
    };
}
