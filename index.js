import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, substituteParams } from '../../../../script.js';
import { getChatCompletionPreset } from '../../../openai.js';

const MODULE = 'st_cache_helper';
const STABLE_DEPTH_ORDER_KEY = 'st_cache_helper_stable_depth_order_v1';
const CLAUDE_ONE_HOUR_CACHE_TTL = '1h';
const CLAUDE_CACHE_BETA_HEADERS = ['prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11'];
let stableDepthOrderMemory = {};
const DEFAULTS = Object.freeze({
    enabled: true,
    // Respect the UI choice, emulate the selected post-processing locally,
    // then apply cache-safe fixes before ST backend sees it.
    mode: 'stable_prefix_cache',
    log: true,
    onlyCustomOpenAI: true,
    stampRequests: true,
    recoverStrandedSystemPrompts: true,
    // Conservatively lift stable World Info / Lorebook / Memory blocks that ST
    // or presets inject as user/assistant messages at depth. Dynamic/current-state
    // blocks stay near the live chat.
    promoteStableDepthPrompts: true,
    depthPromoteMinChars: 260,
    // If ST emits a depth/world-info block as a mid-chat system message and the
    // block looks dynamic/current-state, keep it near the live conversation
    // instead of hoisting it into the cache prefix.
    keepVolatileDepthSystemNearChat: true,
    dedupeStablePrefixPrompts: true,
    canonicalizeStablePrefix: true,
    rememberStableDepthOrder: true,
    // OpenAI-compatible Claude gateways may forward Anthropic cache_control
    // content blocks. Keep this opt-in because unsupported gateways can reject
    // the extended TTL and a 1h cache write costs more than the default 5m write.
    claudeOneHourCache: false,
});

const POST_TYPES = new Set(['strict', 'strict_tools', 'semi', 'semi_tools', 'merge', 'merge_tools', 'single', 'claude']);

const MODES = new Set(['stable_prefix_cache', 'respect_choice_cache', 'strict_to_none', 'strict_to_merge', 'strict_to_semi', 'all_to_none', 'off']);

// ST only auto-populates a small set of built-in system prompts.  Some imported
// presets mark their own custom blocks as `system_prompt: true`; they render in
// Prompt Manager, but do not reach the request body.  The cache helper can
// recover those blocks generically at request time, keeping their `role` as
// system/user/assistant while making them part of the stable prefix.
const BUILTIN_OR_MARKER_PROMPT_IDS = new Set([
    'main',
    'nsfw',
    'jailbreak',
    'enhanceDefinitions',
    'worldInfoBefore',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'dialogueExamples',
    'chatHistory',
    'impersonate',
    'quietPrompt',
    'groupNudge',
    'bias',
    'summary',
    'authorsNote',
    'vectorsMemory',
    'vectorsDataBank',
    'smartContext',
]);

function settings() {
    extension_settings[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[MODULE][k] === undefined) extension_settings[MODULE][k] = v;
    }

    // Migrate old/local experimental modes. The current default must respect the
    // user's selected ST post-processing first, then optimize the resulting body.
    if (!MODES.has(extension_settings[MODULE].mode)) {
        extension_settings[MODULE].mode = DEFAULTS.mode;
        saveSettingsDebounced();
    }

    return extension_settings[MODULE];
}

function shouldTouchBody(body) {
    const s = settings();
    if (!s.enabled) return false;
    if (!body || typeof body !== 'object') return false;
    if (!Array.isArray(body.messages)) return false;
    if (s.onlyCustomOpenAI && body.chat_completion_source !== 'custom') return false;
    return true;
}

function appendYamlLine(value, key, val) {
    const line = `${key}: ${JSON.stringify(String(val))}`;
    const text = String(value || '').trim();
    if (!text) return line;
    const re = new RegExp(`^${key}\\s*:.*$`, 'mi');
    if (re.test(text)) return text.replace(re, line);
    return `${text}\n${line}`;
}

function parseYamlHeaderValue(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'string' ? parsed : value;
    } catch {
        return value.replace(/^(['"])(.*)\1$/, '$2');
    }
}

function appendYamlHeaderTokens(value, key, requiredTokens) {
    const text = String(value || '').trim();
    const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'mi');
    const match = text.match(re);
    const tokens = new Set(
        parseYamlHeaderValue(match?.[1])
            .split(',')
            .map(x => x.trim())
            .filter(Boolean),
    );
    for (const token of requiredTokens) tokens.add(token);
    return appendYamlLine(text, key, [...tokens].join(','));
}

function contentToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (part?.type === 'text') return String(part.text ?? '');
            return JSON.stringify(part ?? '');
        }).join('\n\n');
    }
    return String(content);
}

function cloneMessage(m) {
    return {
        ...m,
        content: contentToText(m?.content),
    };
}

function normalizePrefixText(text) {
    text = String(text ?? '');
    if (!settings().canonicalizeStablePrefix) return text;
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[\t ]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

function stablePromptHash(message) {
    return hashText(normalizePrefixText(contentToText(message?.content)).trim());
}

function loadStableDepthOrder() {
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(STABLE_DEPTH_ORDER_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        }
    } catch { /* noop */ }
    return { ...stableDepthOrderMemory };
}

function saveStableDepthOrder(order) {
    stableDepthOrderMemory = { ...order };
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STABLE_DEPTH_ORDER_KEY, JSON.stringify(order));
        }
    } catch { /* noop */ }
}

function activePromptOrder(promptSettings) {
    const raw = Array.isArray(promptSettings?.prompt_order) ? promptSettings.prompt_order : [];
    if (!raw.length) return [];
    if (raw[0]?.identifier) return raw;

    const lists = raw.filter(x => Array.isArray(x?.order));
    if (!lists.length) return [];

    const openAiGlobal = lists.find(x => String(x.character_id) === '100001');
    if (openAiGlobal) return openAiGlobal.order;

    return lists.sort((a, b) => b.order.length - a.order.length)[0]?.order ?? [];
}

function safeSubstitutePrompt(text) {
    try {
        return substituteParams(String(text ?? '')).trim();
    } catch {
        return String(text ?? '').trim();
    }
}

function getEnabledPresetPromptDefinitions() {
    const s = settings();
    if (!s.recoverStrandedSystemPrompts) return [];

    let preset;
    try {
        preset = getChatCompletionPreset();
    } catch (err) {
        if (s.log) console.debug('[ST Cache Helper] could not read current OpenAI preset', err);
        return [];
    }

    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    const byId = new Map(prompts.filter(Boolean).map(p => [String(p.identifier || ''), p]));
    const order = activePromptOrder(preset);
    const out = [];

    for (const entry of order) {
        if (!entry?.identifier || entry.enabled === false) continue;

        const prompt = byId.get(String(entry.identifier));
        if (!prompt || prompt.marker) continue;

        const content = safeSubstitutePrompt(prompt.content);
        if (!content) continue;

        out.push({
            identifier: String(prompt.identifier),
            role: ['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system',
            system_prompt: prompt.system_prompt,
            injection_position: prompt.injection_position,
            content,
            hash: hashText(content),
        });
    }

    return out;
}

function recoverMissingSystemPromptMessages(body, promptDefs) {
    const bodyHashes = new Set(body.messages.map(m => hashText(contentToText(m?.content).trim())));
    const recovered = [];

    for (const prompt of promptDefs) {
        const isRelative = Number(prompt.injection_position ?? 0) !== 1;
        const isStrandedSystem = prompt.system_prompt === true
            && isRelative
            && !BUILTIN_OR_MARKER_PROMPT_IDS.has(prompt.identifier);

        if (!isStrandedSystem) continue;
        if (bodyHashes.has(prompt.hash)) continue;

        recovered.push({
            role: 'system',
            content: prompt.content,
            name: `stch_${prompt.identifier}`.replace(/[^\w-]/g, '_').slice(0, 64),
            _stchRecovered: true,
        });
        bodyHashes.add(prompt.hash);
    }

    return recovered;
}

function isPresetPromptMessage(message, promptDefs) {
    if (!promptDefs.length) return false;
    if (!['assistant', 'user'].includes(message?.role)) return false;
    const text = contentToText(message.content).trim();
    if (!text) return false;
    const hash = hashText(text);
    return promptDefs.some(p => p.hash === hash && p.role === message.role);
}

const STABLE_DEPTH_MARKER_RE = /(?:World\s*Info|Lorebook|世界书|世界信息|世界设定|角色设定|人物设定|地点设定|背景设定|长期记忆|常驻记忆|Memory|Author'?s\s*Note|vectorsDataBank|vectorsMemory|smartContext|Data\s*Bank|<\s*(?:world|lore|memory|setting|character)[\s>]|\[(?:World\s*Info|Lorebook|Memory|设定|世界书)\])/i;
const STATIC_LORE_STYLE_RE = /(?:^|\n)\s*(?:Name|名称|角色|人物|地点|Location|Background|背景|Personality|性格|Appearance|外貌|Scenario|场景|规则|Rule|Setting|设定|Profile|档案|Summary|摘要)\s*[:：]/i;
const VOLATILE_DEPTH_RE = /(?:当前状态|即时状态|本轮|上一轮|最新|刚才|目前|现在时间|当前时间|今天日期|last\s*(?:message|reply)|current\s*(?:message|scene|state|time)|recent\s*(?:chat|events)|动态|临时|scratchpad|任务进度|剧情进度|status\s*bar)/i;
const CHATLIKE_LINE_RE = /^\s*(?:User|Assistant|{{user}}|{{char}}|你|我|他说|她说|[\w\u4e00-\u9fa5]{1,24})\s*[:：]/m;

function lastUserMessageIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') return i;
    }
    return -1;
}

function firstNonSystemMessageIndex(messages) {
    const index = messages.findIndex(m => m?.role !== 'system');
    return index === -1 ? messages.length : index;
}

function hasPermanentDepthMarker(text) {
    return /(?:长期记忆|常驻记忆|永久|固定|stable|permanent|角色设定|人物设定|地点设定|世界设定)/i.test(text);
}

function isVolatileDepthText(text) {
    text = String(text ?? '');
    if (!VOLATILE_DEPTH_RE.test(text)) return false;
    // A block explicitly marked permanent can still mention "current" in its own
    // rules; do not treat that as sliding state.
    if (hasPermanentDepthMarker(text)) return false;
    return true;
}

function isMidChatVolatileSystemPrompt(message, index, messages) {
    if (message?.role !== 'system') return false;
    if (index < firstNonSystemMessageIndex(messages)) return false;
    const text = contentToText(message.content).trim();
    if (!text) return false;
    return isVolatileDepthText(text);
}

function asUserContextPrompt(message) {
    const out = cloneMessage(message);
    out._stchOriginalRole = out.role;
    out.role = 'user';
    delete out.name;
    delete out.tool_calls;
    delete out.tool_call_id;
    return out;
}

function isProbablyConversationTurn(message, body) {
    const text = contentToText(message?.content).trim();
    if (!text) return true;
    const names = [body?.char_name, body?.user_name, ...(Array.isArray(body?.group_names) ? body.group_names : [])]
        .filter(Boolean).map(String).filter(x => x.length <= 40);
    if (names.some(name => text.startsWith(`${name}:`) || text.startsWith(`${name}：`))) return true;
    // Short dialogue-like user/assistant messages are very likely real chat turns.
    if (text.length < 220 && (/[“”"「」]/.test(text) || /[。！？!?]$/.test(text))) return true;
    return false;
}

function isStableDepthPromptMessage(message, body, index, messages) {
    const s = settings();
    if (!s.promoteStableDepthPrompts) return false;
    if (!['system', 'user', 'assistant'].includes(message?.role)) return false;
    if (message?._stchRecovered) return false;

    const text = contentToText(message.content).trim();
    if (text.length < Math.max(80, Number(s.depthPromoteMinChars || 260))) return false;

    // Never move the latest live user turn, nor the final assistant turn. Depth
    // inserts usually sit above recent history, while the live message is tail.
    const lastUser = lastUserMessageIndex(messages);
    if (index === lastUser || index >= messages.length - 1) return false;

    const hasStrongMarker = STABLE_DEPTH_MARKER_RE.test(text);
    const hasLoreShape = text.length >= 700 && STATIC_LORE_STYLE_RE.test(text);
    if (!hasStrongMarker && !hasLoreShape) return false;

    // Dynamic state / current-scene summaries are intentionally not lifted; if
    // their content changes every turn and is placed at the very front, cache read
    // becomes worse, not better.
    if (isVolatileDepthText(text)) return false;

    if (isProbablyConversationTurn(message, body) && !hasStrongMarker) return false;
    if (CHATLIKE_LINE_RE.test(text) && !hasStrongMarker && text.length < 1200) return false;

    return true;
}

function startsWithGroupName(text, groupNames = []) {
    return groupNames.some(name => String(text).startsWith(`${name}: `));
}

function normalizeNames(message, body) {
    const names = {
        charName: String(body.char_name || ''),
        userName: String(body.user_name || ''),
        groupNames: Array.isArray(body.group_names) ? body.group_names.map(String) : [],
    };

    if (message.role === 'system' && message.name === 'example_assistant') {
        if (names.charName && !message.content.startsWith(`${names.charName}: `) && !startsWithGroupName(message.content, names.groupNames)) {
            message.content = `${names.charName}: ${message.content}`;
        }
    }
    if (message.role === 'system' && message.name === 'example_user') {
        if (names.userName && !message.content.startsWith(`${names.userName}: `)) {
            message.content = `${names.userName}: ${message.content}`;
        }
    }
    if (message.name && message.role !== 'system') {
        if (!message.content.startsWith(`${message.name}: `)) {
            message.content = `${message.name}: ${message.content}`;
        }
    }
    delete message.name;
    delete message.tool_calls;
    delete message.tool_call_id;
    return message;
}

function mergeConsecutive(messages) {
    const out = [];
    for (const msg of messages) {
        if (out.length && out[out.length - 1].role === msg.role && msg.content && msg.role !== 'tool') {
            out[out.length - 1].content += '\n\n' + msg.content;
        } else {
            out.push(msg);
        }
    }
    return out.length ? out : [{ role: 'user', content: "Let's get started." }];
}

function emulatePostProcessing(messages, type, body) {
    let out = messages.map(m => normalizeNames(cloneMessage(m), body));

    if (type === 'single') {
        const charName = String(body.char_name || '');
        const userName = String(body.user_name || '');
        const groupNames = Array.isArray(body.group_names) ? body.group_names.map(String) : [];
        out = out.map(m => {
            if (m.role === 'assistant' && charName && !m.content.startsWith(`${charName}: `) && !startsWithGroupName(m.content, groupNames)) {
                m.content = `${charName}: ${m.content}`;
            }
            if (m.role === 'user' && userName && !m.content.startsWith(`${userName}: `)) {
                m.content = `${userName}: ${m.content}`;
            }
            m.role = 'user';
            return m;
        });
        return mergeConsecutive(out);
    }

    out = mergeConsecutive(out);

    if (['strict', 'strict_tools', 'semi', 'semi_tools'].includes(type)) {
        for (let i = 0; i < out.length; i++) {
            if (i > 0 && out[i].role === 'system') out[i].role = 'user';
        }
    }

    // Do NOT insert Strict's [Start a new chat] placeholder. It is the most
    // cache-hostile part and not useful for NewAPI/OpenAI-compatible routing.
    // This is the key cache-safe optimization after respecting the selected mode.
    return mergeConsecutive(out);
}


function isStaticAssistantPrompt(message) {
    if (message?.role !== 'assistant') return false;
    const text = contentToText(message.content).trim();
    // These are ST prompt-manager assistant-role prompt blocks, not real chat replies.
    // Moving them into the stable system prefix prevents them from sliding behind
    // user/assistant chat turns and breaking Claude prompt cache.
    return /^\[字数\]/.test(text)
        || /^<think>（我的思考已完成）<\/think>/.test(text)
        || /@PuppyPhase\.vX\.12/.test(text);
}

function asSystemPrompt(message) {
    const out = cloneMessage(message);
    out._stchOriginalRole = out.role;
    out.role = 'system';
    out.content = normalizePrefixText(out.content);
    delete out.name;
    delete out.tool_calls;
    delete out.tool_call_id;
    return out;
}

function stripInternalFields(message) {
    delete message._stchOriginalRole;
    delete message._stchRecovered;
    delete message._stchReason;
    delete message._stchPromptIndex;
    delete message._stchDepthHash;
    delete message._stchDepthOrder;
    return message;
}

function dedupePrefixPrompts(messages) {
    if (!settings().dedupeStablePrefixPrompts) return { messages, removed: 0 };
    const seen = new Set();
    const out = [];
    let removed = 0;

    for (const msg of messages) {
        const key = `${msg.role}:${hashText(contentToText(msg.content).trim())}`;
        if (msg.role === 'system' && seen.has(key)) {
            removed++;
            continue;
        }
        if (msg.role === 'system') seen.add(key);
        out.push(msg);
    }

    return { messages: out, removed };
}

function orderStableDepthPrompts(prompts) {
    const stable = [];
    const other = [];

    for (let i = 0; i < prompts.length; i++) {
        const msg = prompts[i];
        msg._stchPromptIndex = i;
        if (String(msg._stchReason || '').startsWith('stable-depth')) stable.push(msg);
        else other.push(msg);
    }

    if (!settings().rememberStableDepthOrder || !stable.length) {
        return { prompts, knownStableDepthBlocks: 0, newStableDepthBlocks: 0 };
    }

    const order = loadStableDepthOrder();
    let max = -1;
    for (const value of Object.values(order)) {
        const n = Number(value);
        if (Number.isFinite(n) && n > max) max = n;
    }

    let changed = false;
    let known = 0;
    let created = 0;
    for (const msg of stable) {
        const h = stablePromptHash(msg);
        msg._stchDepthHash = h;
        if (Number.isFinite(Number(order[h]))) {
            known++;
        } else {
            order[h] = ++max;
            changed = true;
            created++;
        }
        msg._stchDepthOrder = Number(order[h]);
    }

    if (changed) saveStableDepthOrder(order);

    stable.sort((a, b) => {
        const da = Number(a._stchDepthOrder ?? 0);
        const db = Number(b._stchDepthOrder ?? 0);
        if (da !== db) return da - db;
        return Number(a._stchPromptIndex ?? 0) - Number(b._stchPromptIndex ?? 0);
    });

    // Keep base/preset/system prompts first; put stable depth/lore blocks after
    // that base in remembered append-only order. If a new world entry activates,
    // it tends to append after known entries instead of being inserted before them
    // and invalidating the whole prefix.
    return { prompts: [...other, ...stable], knownStableDepthBlocks: known, newStableDepthBlocks: created };
}

function stablePrefixCacheFix(body) {
    const beforePost = body.custom_prompt_post_processing || '';
    const originalSummary = summarizeMessages(body.messages);
    const promptDefs = getEnabledPresetPromptDefinitions();
    const recovered = recoverMissingSystemPromptMessages(body, promptDefs);
    const prompts = [];
    const conversation = [];
    let volatileSystemDepthKept = 0;

    for (let i = 0; i < body.messages.length; i++) {
        const raw = body.messages[i];
        const msg = cloneMessage(raw);
        if (msg.role === 'system') {
            if (settings().keepVolatileDepthSystemNearChat && isMidChatVolatileSystemPrompt(msg, i, body.messages)) {
                const kept = asUserContextPrompt(msg);
                kept._stchReason = 'volatile-system-depth-kept';
                conversation.push(kept);
                volatileSystemDepthKept++;
            } else {
                const promoted = asSystemPrompt(msg);
                const isDepthSystem = i >= firstNonSystemMessageIndex(body.messages);
                promoted._stchReason = isDepthSystem && isStableDepthPromptMessage(msg, body, i, body.messages) ? 'stable-depth-system-prompt' : 'system';
                prompts.push(promoted);
            }
        } else if (isStaticAssistantPrompt(msg)) {
            const promoted = asSystemPrompt(msg);
            promoted._stchReason = 'static-assistant-prompt';
            prompts.push(promoted);
        } else if (isPresetPromptMessage(msg, promptDefs)) {
            const promoted = asSystemPrompt(msg);
            promoted._stchReason = 'preset-prompt';
            prompts.push(promoted);
        } else if (isStableDepthPromptMessage(msg, body, i, body.messages)) {
            const promoted = asSystemPrompt(msg);
            promoted._stchReason = 'stable-depth-prompt';
            prompts.push(promoted);
        } else {
            conversation.push(msg);
        }
    }

    if (!prompts.length && !recovered.length) return null;

    const ordered = orderStableDepthPrompts(prompts);
    const promotedStableDepthBlocks = ordered.prompts.filter(x => String(x._stchReason || '').startsWith('stable-depth')).length;
    const prefix = [...recovered.map(asSystemPrompt), ...ordered.prompts];
    const deduped = dedupePrefixPrompts(prefix);
    body.messages = [...deduped.messages, ...conversation].map(stripInternalFields);

    // This mode deliberately bypasses ST backend prompt post-processing.
    // We are preserving the content, but moving static prompt blocks into a stable
    // prefix. If ST processes it again, it may reintroduce sliding depth blocks.
    body.custom_prompt_post_processing = '';

    if (settings().stampRequests) {
        body.custom_include_headers = appendYamlLine(body.custom_include_headers, 'X-ST-Cache-Helper', 'stable-prefix-cache-v4');
    }

    return {
        mode: 'stable_prefix_cache',
        selectedPostProcessing: beforePost || 'none',
        sentPostProcessing: 'none-stable-prefix',
        recoveredStrandedSystemBlocks: recovered.length,
        promotedSystemBlocks: prompts.length + recovered.length,
        promotedStableDepthBlocks,
        volatileSystemDepthKept,
        dedupedStablePrefixBlocks: deduped.removed,
        knownStableDepthBlocks: ordered.knownStableDepthBlocks,
        newStableDepthBlocks: ordered.newStableDepthBlocks,
        canonicalizeStablePrefix: !!settings().canonicalizeStablePrefix,
        conversationBlocks: conversation.length,
        before: originalSummary,
        after: summarizeMessages(body.messages),
    };
}

function splitMergedSystemForCache(messages) {
    // If the selected mode merged consecutive system blocks into one huge system,
    // split it back on double newlines between recognizable prompt sections.
    // This keeps the user's post-processing choice mostly intact while allowing
    // NewAPI/Claude conversion to see stable chunks instead of one huge volatile blob.
    if (!messages.length || messages[0].role !== 'system') return messages;
    const first = messages[0];
    const text = String(first.content || '');
    if (text.length < 3000) return messages;

    const parts = text
        .split(/\n{2,}(?=(?:<[^>\n]{1,80}>|\[[^\]\n]{1,120}\]|[#【]|Write\s+[^\n]{1,160}'s\s+next\s+reply|If you have more knowledge|The following examples))/g)
        .map(x => x.trim())
        .filter(Boolean);

    if (parts.length <= 1) return messages;
    return [
        ...parts.map(part => ({ ...first, role: 'system', content: part })),
        ...messages.slice(1),
    ];
}

function optimizeAfterSelection(body) {
    const before = body.custom_prompt_post_processing || '';
    if (!before || !POST_TYPES.has(before)) return null;

    const originalSummary = summarizeMessages(body.messages);
    let afterMessages = emulatePostProcessing(body.messages, before, body);
    afterMessages = splitMergedSystemForCache(afterMessages);

    body.messages = afterMessages;
    // We already applied the selected mode locally. Clear backend post-processing
    // only to prevent ST from processing the optimized messages a second time.
    body.custom_prompt_post_processing = '';

    if (settings().stampRequests) {
        body.custom_include_headers = appendYamlLine(body.custom_include_headers, 'X-ST-Cache-Helper', `applied-${before}-cache-optimized`);
    }

    return {
        selected: before,
        sentPostProcessing: 'none-after-local-apply',
        before: originalSummary,
        after: summarizeMessages(body.messages),
    };
}

function legacyRewritePostProcessing(body) {
    const s = settings();
    const before = body.custom_prompt_post_processing || '';
    let after = before;

    if (s.mode === 'off') return null;
    if (s.mode === 'strict_to_none') {
        if (before === 'strict' || before === 'strict_tools') after = '';
    } else if (s.mode === 'strict_to_merge') {
        if (before === 'strict') after = 'merge';
        if (before === 'strict_tools') after = 'merge_tools';
    } else if (s.mode === 'strict_to_semi') {
        if (before === 'strict') after = 'semi';
        if (before === 'strict_tools') after = 'semi_tools';
    } else if (s.mode === 'all_to_none') {
        if (before) after = '';
    }

    if (after !== before) {
        body.custom_prompt_post_processing = after;
        if (s.stampRequests) {
            body.custom_include_headers = appendYamlLine(body.custom_include_headers, 'X-ST-Cache-Helper', `${before || 'none'}-to-${after || 'none'}`);
        }
        return { before, after, summary: summarizeMessages(body.messages) };
    }
    return null;
}

function isClaudeCustomRequest(body) {
    return body?.chat_completion_source === 'custom' && /(?:^|[/_-])claude(?:$|[/_.-])/i.test(String(body?.model || ''));
}

function applyCacheControlToContent(content, ttl) {
    const cacheControl = { type: 'ephemeral', ttl };

    if (typeof content === 'string') {
        return {
            content: [{ type: 'text', text: content, cache_control: cacheControl }],
            updatedExisting: 0,
        };
    }

    if (!Array.isArray(content)) return null;

    const parts = content.map(part => part && typeof part === 'object' ? { ...part } : part);
    let updatedExisting = 0;
    let lastTextIndex = -1;
    for (let i = 0; i < parts.length; i++) {
        if (parts[i]?.type !== 'text') continue;
        lastTextIndex = i;
        if (parts[i].cache_control) {
            parts[i].cache_control = { ...parts[i].cache_control, type: 'ephemeral', ttl };
            updatedExisting++;
        }
    }

    if (lastTextIndex === -1) return null;
    if (!parts[lastTextIndex].cache_control) {
        parts[lastTextIndex].cache_control = cacheControl;
    }

    return { content: parts, updatedExisting };
}

function applyClaudeOneHourCache(body) {
    if (!settings().claudeOneHourCache || !isClaudeCustomRequest(body)) return null;

    let breakpointIndex = -1;
    for (let i = 0; i < body.messages.length; i++) {
        if (body.messages[i]?.role !== 'system') break;
        breakpointIndex = i;
    }
    if (breakpointIndex === -1) return null;

    let updatedExisting = 0;
    for (let i = 0; i <= breakpointIndex; i++) {
        const message = body.messages[i];
        if (message?.cache_control) {
            message.cache_control = { ...message.cache_control, type: 'ephemeral', ttl: CLAUDE_ONE_HOUR_CACHE_TTL };
            updatedExisting++;
        }
        if (i === breakpointIndex) continue;
        if (!Array.isArray(message?.content)) continue;
        message.content = message.content.map(part => {
            if (!part?.cache_control) return part;
            updatedExisting++;
            return {
                ...part,
                cache_control: { ...part.cache_control, type: 'ephemeral', ttl: CLAUDE_ONE_HOUR_CACHE_TTL },
            };
        });
    }

    const breakpoint = body.messages[breakpointIndex];
    const marked = applyCacheControlToContent(breakpoint.content, CLAUDE_ONE_HOUR_CACHE_TTL);
    if (!marked) return null;
    breakpoint.content = marked.content;
    updatedExisting += marked.updatedExisting;

    body.custom_include_headers = appendYamlHeaderTokens(
        body.custom_include_headers,
        'anthropic-beta',
        CLAUDE_CACHE_BETA_HEADERS,
    );

    return {
        requestedTtl: CLAUDE_ONE_HOUR_CACHE_TTL,
        breakpointIndex,
        breakpointRole: breakpoint.role,
        updatedExistingCacheControls: updatedExisting,
        betaHeaders: [...CLAUDE_CACHE_BETA_HEADERS],
    };
}

function applyOptimization(body) {
    const s = settings();
    let promptOptimization;
    if (s.mode === 'stable_prefix_cache') promptOptimization = stablePrefixCacheFix(body);
    else if (s.mode === 'respect_choice_cache') promptOptimization = optimizeAfterSelection(body);
    else promptOptimization = legacyRewritePostProcessing(body);

    const claudeOneHourCache = applyClaudeOneHourCache(body);
    if (!promptOptimization && !claudeOneHourCache) return null;
    return { promptOptimization, claudeOneHourCache };
}

function hashText(s) {
    s = String(s ?? '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function summarizeMessages(messages) {
    const systemTexts = messages.filter(x => x?.role === 'system').map(x => contentToText(x.content));
    const allText = messages.map(x => `${x?.role}:${contentToText(x?.content)}`).join('\n---\n');
    return {
        count: messages.length,
        roles: messages.map(x => x?.role).join(','),
        systemBlocks: systemTexts.length,
        systemLen: systemTexts.join('\n\n').length,
        systemHash: hashText(systemTexts.join('\n\n')),
        allHash: hashText(allText),
    };
}

function installFetchPatch() {
    if (window.__stCacheHelperFetchPatched) return;
    window.__stCacheHelperFetchPatched = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init = {}) {
        try {
            const url = typeof input === 'string' ? input : input?.url;
            const isGenerate = typeof url === 'string' && url.includes('/api/backends/chat-completions/generate');
            if (isGenerate && init?.body && typeof init.body === 'string') {
                const body = JSON.parse(init.body);
                if (shouldTouchBody(body)) {
                    const changed = applyOptimization(body);
                    if (changed) {
                        init = { ...init, body: JSON.stringify(body) };
                        if (settings().log) console.info('[ST Cache Helper] optimized request', changed);
                    } else if (settings().log) {
                        console.debug('[ST Cache Helper] no optimization', { post: body.custom_prompt_post_processing || '', ...summarizeMessages(body.messages) });
                    }
                }
            }
        } catch (err) {
            console.warn('[ST Cache Helper] fetch patch error', err);
        }
        return originalFetch(input, init);
    };
}

function addPanel() {
    if ($('#st_cache_helper_panel').length) return;

    const s = settings();
    const html = `
    <div id="st_cache_helper_panel">
      <b>ST Cache Helper</b>
      <div class="stch-muted">缓存修复插件。推荐使用“稳定前缀缓存修复”：把 ST 的中后段静态提示词提前为稳定前缀，避免 depth 注入块随对话轮次滑动导致 Claude prompt cache 只写不读。</div>
      <label class="stch-row"><input id="stch_enabled" type="checkbox"> 启用请求修复</label>
      <div class="stch-row">
        <span>策略</span>
        <select id="stch_mode">
          <option value="stable_prefix_cache">稳定前缀缓存修复（实测命中）</option>
          <option value="respect_choice_cache">尊重选择后优化（旧实验）</option>
          <option value="strict_to_none">旧模式：Strict → None</option>
          <option value="strict_to_merge">旧模式：Strict → Merge</option>
          <option value="strict_to_semi">旧模式：Strict → Semi</option>
          <option value="all_to_none">旧模式：所有后处理 → None</option>
          <option value="off">不改写</option>
        </select>
      </div>
      <label class="stch-row"><input id="stch_only_custom" type="checkbox"> 仅作用于自定义 OpenAI 源</label>
      <label class="stch-row"><input id="stch_log" type="checkbox"> 控制台输出调试日志</label>
      <label class="stch-row"><input id="stch_stamp" type="checkbox"> 给请求加调试头 <code>X-ST-Cache-Helper</code></label>
      <label class="stch-row"><input id="stch_recover_stranded" type="checkbox"> 自动识别并补回“显示在预设里但没进请求体”的自定义 system 提示词</label>
      <label class="stch-row"><input id="stch_promote_depth" type="checkbox"> 保守提升稳定世界书/深度注入块到缓存前缀</label>
      <label class="stch-row"><input id="stch_keep_volatile_system" type="checkbox"> 中段动态 system 不提前，留在聊天附近</label>
      <label class="stch-row"><input id="stch_dedupe_prefix" type="checkbox"> 去重稳定前缀里的重复 system 块</label>
      <label class="stch-row"><input id="stch_canonicalize_prefix" type="checkbox"> 规范化稳定前缀换行/尾随空格</label>
      <label class="stch-row"><input id="stch_remember_depth_order" type="checkbox"> 记忆稳定世界书顺序，新条目尽量追加到后面</label>
      <label class="stch-row"><input id="stch_claude_1h_cache" type="checkbox"> 请求 Claude 1 小时缓存（ttl=1h）</label>
      <div class="stch-muted">1 小时缓存仅对自定义 OpenAI 中模型名含 Claude 的请求生效；插件会在稳定 system 前缀末尾写入标准 Anthropic 缓存断点。是否实际写入由上游代理决定。</div>
      <div class="stch-muted">世界书说明：只提升像长期设定/资料库的块；含“当前状态/本轮/最新”等动态状态栏会尽量留在原位，避免反而破坏缓存或剧情。</div>
      <div class="stch-muted">注意：这是前端请求级修复，不修改 ST 后端源码和 NewAPI。稳定前缀模式会清空 post-processing，原因是它已经把静态提示块固定到前缀，不能再让 ST 后端二次移动这些块。</div>
    </div>`;

    const target = $('#openai_settings, #extensions_settings, #completion_prompt_manager_popup_entry_form').first();
    if (target.length) target.prepend(html);
    else $('#extensions_settings').append(html);

    $('#stch_enabled').prop('checked', !!s.enabled).on('change', function () {
        settings().enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_mode').val(s.mode).on('change', function () {
        settings().mode = String($(this).val());
        saveSettingsDebounced();
    });
    $('#stch_only_custom').prop('checked', !!s.onlyCustomOpenAI).on('change', function () {
        settings().onlyCustomOpenAI = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_log').prop('checked', !!s.log).on('change', function () {
        settings().log = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_stamp').prop('checked', !!s.stampRequests).on('change', function () {
        settings().stampRequests = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_recover_stranded').prop('checked', !!s.recoverStrandedSystemPrompts).on('change', function () {
        settings().recoverStrandedSystemPrompts = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_promote_depth').prop('checked', !!s.promoteStableDepthPrompts).on('change', function () {
        settings().promoteStableDepthPrompts = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_keep_volatile_system').prop('checked', !!s.keepVolatileDepthSystemNearChat).on('change', function () {
        settings().keepVolatileDepthSystemNearChat = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_dedupe_prefix').prop('checked', !!s.dedupeStablePrefixPrompts).on('change', function () {
        settings().dedupeStablePrefixPrompts = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_canonicalize_prefix').prop('checked', !!s.canonicalizeStablePrefix).on('change', function () {
        settings().canonicalizeStablePrefix = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_remember_depth_order').prop('checked', !!s.rememberStableDepthOrder).on('change', function () {
        settings().rememberStableDepthOrder = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_claude_1h_cache').prop('checked', !!s.claudeOneHourCache).on('change', function () {
        settings().claudeOneHourCache = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
}

function exposeDebug() {
    window.stCacheHelper = {
        settings,
        testOptimize(body) {
            const clone = structuredClone(body);
            const changed = shouldTouchBody(clone) ? applyOptimization(clone) : null;
            return { changed, body: clone };
        },
        clearStableDepthOrder() {
            stableDepthOrderMemory = {};
            try { if (typeof localStorage !== 'undefined') localStorage.removeItem(STABLE_DEPTH_ORDER_KEY); } catch { /* noop */ }
        },
    };
}

export function init() {
    settings();
    installFetchPatch();
    exposeDebug();
    addPanel();
    setTimeout(addPanel, 1000);
    setTimeout(addPanel, 3000);
    console.info('[ST Cache Helper] loaded', settings());
}
