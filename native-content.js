export function isUsableNativeContentBlock(block) {
    if (!block || typeof block !== 'object') return false;
    if (block.type !== 'text') return true;
    return String(block.text ?? '').trim().length > 0;
}

export function sanitizeNativeContentBlocks(blocks, { stripCacheControl = false } = {}) {
    return (Array.isArray(blocks) ? blocks : [])
        .filter(block => block && typeof block === 'object')
        .map(block => {
            const clone = structuredClone(block);
            if (clone.type === 'text') clone.text = String(clone.text ?? '');
            if (stripCacheControl) delete clone.cache_control;
            return clone;
        })
        .filter(isUsableNativeContentBlock);
}

export function toNativeContentBlocks(content) {
    const blocks = typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : (Array.isArray(content)
            ? content.map(part => (
                part && typeof part === 'object'
                    ? part
                    : { type: 'text', text: String(part ?? '') }
            ))
            : []);
    return sanitizeNativeContentBlocks(blocks, { stripCacheControl: true });
}

export function sanitizeNativeMessages(messages, { stripCacheControl = false, fallbackText = '...' } = {}) {
    const fallback = String(fallbackText ?? '').trim() || '...';
    return (Array.isArray(messages) ? messages : [])
        .filter(message => message && typeof message === 'object')
        .map(message => {
            const clone = structuredClone(message);
            const content = typeof clone.content === 'string'
                ? [{ type: 'text', text: clone.content }]
                : clone.content;
            clone.content = sanitizeNativeContentBlocks(content, { stripCacheControl });
            if (['user', 'assistant'].includes(clone.role) && !clone.content.length) {
                clone.content = [{ type: 'text', text: fallback }];
            }
            if (stripCacheControl) delete clone.cache_control;
            return clone;
        });
}

export function sanitizeClaudeSourceMessages(messages, { fallbackText = '...' } = {}) {
    const fallback = String(fallbackText ?? '').trim() || '...';
    const out = [];
    for (const source of Array.isArray(messages) ? messages : []) {
        if (!source || typeof source !== 'object') continue;
        const message = structuredClone(source);
        if (!['system', 'user', 'assistant'].includes(message.role)) {
            out.push(message);
            continue;
        }

        if (typeof message.content === 'string') {
            if (message.content.trim().length > 0) {
                out.push(message);
            } else if (message.role !== 'system') {
                message.content = fallback;
                out.push(message);
            }
            continue;
        }

        const content = sanitizeNativeContentBlocks(message.content);
        if (content.length > 0) {
            message.content = content;
            out.push(message);
        } else if (message.role !== 'system') {
            if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
                out.push(message);
            } else {
                message.content = fallback;
                out.push(message);
            }
        }
    }
    return out;
}
