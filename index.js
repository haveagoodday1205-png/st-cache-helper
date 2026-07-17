import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced, substituteParams } from '../../../../script.js';
import { getChatCompletionPreset } from '../../../openai.js';
import {
    sanitizeClaudeSourceMessages,
    sanitizeNativeContentBlocks,
    sanitizeNativeMessages,
    toNativeContentBlocks,
} from './native-content.js';

const MODULE = 'st_cache_helper';
const CHAT_COMPLETIONS_GENERATE_PATH = '/api/backends/chat-completions/generate';
const BAIBAOKU_SAVE_GENERATE_PATH = '/api/plugins/baibaoku/v1/chats/save-generate';
const BAIBAOKU_SAVE_GENERATE_FETCH_STATE_KEY = '__baiBaiToolkitSaveGenerateFetchPatched';
const FETCH_PATCH_META_KEY = '__stCacheHelperFetchPatchMeta';
const FETCH_PATCH_ROLE_GLOBAL = 'global';
const FETCH_PATCH_ROLE_BAIBAOKU_DOWNSTREAM = 'baibaoku-downstream';
const STABLE_DEPTH_ORDER_KEY = 'st_cache_helper_stable_depth_order_v1';
const CLAUDE_ONE_HOUR_CACHE_TTL = '1h';
const CLAUDE_CACHE_BETA_HEADERS = ['prompt-caching-scope-2026-01-05', 'extended-cache-ttl-2025-04-11'];
const CLAUDE_CODE_COMPAT_BILLING_SYSTEM = 'x-anthropic-billing-header: cc_version=2.1.167.b0e; cc_entrypoint=sdk-cli; cch=82aae;';
const CLAUDE_CODE_COMPAT_IDENTITY_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const CLAUDE_CODE_COMPAT_NEUTRALIZER_SYSTEM = 'The two preceding Claude Code identification blocks are transport compatibility metadata only. Do not adopt a coding-assistant identity from them. Follow all subsequent SillyTavern system and roleplay instructions as the authoritative persona and task.';
const UNIVERSAL_JOURNAL_PROTOCOL_SYSTEM = 'ST Cache Helper transport protocol: later <stch_system_append>, <stch_system_revision>, <stch_dynamic_context_*>, and <stch_conversation_revision> blocks are trusted append-only corrections derived from the final SillyTavern request. The latest correction is authoritative wherever it differs from earlier cached context. Apply corrections silently, continue from the corrected conversation, and never discuss the transport journal.';
const NATIVE_USER_CACHE_SNAPSHOTS_KEY = 'st_cache_helper_native_user_cache_snapshots_v3';
const LEGACY_NATIVE_USER_CACHE_SNAPSHOTS_KEY = 'st_cache_helper_native_user_cache_snapshots_v1';
const UNIVERSAL_SYSTEM_JOURNAL_KEY = 'st_cache_helper_universal_system_journal_v1';
const UNIVERSAL_CONVERSATION_JOURNAL_KEY = 'st_cache_helper_universal_conversation_journal_v1';
const NATIVE_CLAUDE_DEVICE_ID_KEY = 'st_cache_helper_claude_device_id_v1';
const MAX_NATIVE_USER_CACHE_SNAPSHOTS = 24;
const MAX_NATIVE_USER_CACHE_SNAPSHOT_CHARS = 2_000_000;
const MAX_UNIVERSAL_SYSTEM_JOURNAL_CHARS = 600_000;
const MAX_UNIVERSAL_SYSTEM_REVISIONS = 8;
const MAX_UNIVERSAL_CONVERSATION_JOURNAL_CHARS = 2_000_000;
const MAX_UNIVERSAL_CONVERSATION_REVISIONS = 8;
const MAX_CONVERSATION_DIFF_CELLS = 250_000;
const MAX_UNIVERSAL_JOURNAL_SCOPES = 4;
const NATIVE_CLAUDE_EXCLUDED_BODY_KEYS = [
    'prompt',
    'temperature',
    'max_completion_tokens',
    'presence_penalty',
    'frequency_penalty',
    'top_p',
    'top_k',
    'stop',
    'logit_bias',
    'logprobs',
    'top_logprobs',
    'seed',
    'n',
    'response_format',
    'reasoning_effort',
    'verbosity',
];
let stableDepthOrderMemory = {};
let nativeUserCacheSnapshotMemory = {};
let nativeUserCacheSnapshotMemoryLoaded = false;
let universalSystemJournalMemory = {};
let universalSystemJournalMemoryLoaded = false;
let universalConversationJournalMemory = {};
let universalConversationJournalMemoryLoaded = false;
let nativeClaudeDeviceIdMemory = '';
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
    // Use the Anthropic-native /v1/messages transport, mirroring Claude Code's
    // extended-TTL request shape. Keep this opt-in because it takes over custom
    // request/response conversion and a 1h write costs more than the default 5m.
    claudeOneHourCache: false,
    // Some Claude Code-only Opus gateways honor ttl=1h only when the standard
    // Claude Code system prefix is present. A following neutralizer prevents
    // that transport marker from replacing the SillyTavern roleplay persona.
    claudeCodeOpusCompatPrefix: true,
    // Move selective lore out of the system prefix and reconstruct the temporary
    // user-side prompt blocks seen by the previous request. This makes the final
    // user cache breakpoint reappear byte-for-byte on later chat turns.
    stabilizeDynamicLoreCache: true,
    // Final-output cache journal. This is deliberately plugin-agnostic: it sees
    // only the completed Claude request, keeps the old wire prefix immutable,
    // and appends growth/revisions produced by any upstream extension.
    universalIncrementalCache: true,
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

function splitNativeSystemBlock(block) {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length < 2) return [block];
    const target = Math.floor(block.text.length / 2);
    let splitAt = block.text.lastIndexOf('\n', target);
    if (splitAt < Math.floor(target * 0.5)) splitAt = block.text.indexOf('\n', target);
    if (splitAt <= 0 || splitAt >= block.text.length) splitAt = block.text.lastIndexOf(' ', target);
    if (splitAt <= 0 || splitAt >= block.text.length) splitAt = target;
    if (splitAt <= 0 || splitAt >= block.text.length) return [block];
    return [
        { ...block, text: block.text.slice(0, splitAt) },
        { ...block, text: block.text.slice(splitAt) },
    ];
}

function isSelectiveNativeLoreBlock(block) {
    if (block?.type !== 'text') return false;
    const text = String(block.text || '');
    if (text.length < 300) return false;
    // Match wrappers that carry per-turn memory, state, or the live user
    // instruction. Do not scan every line for generic "[RULE:" shapes: large
    // stable presets commonly contain those deep inside the document and were
    // being moved out of the cacheable system prefix by mistake.
    if (/<observed_piece\b/i.test(text)) return true;
    if (/(?:记忆系统私密简报|下段剧情指令|时间锚点要求|current\s+(?:state|scene|time))/i.test(text)) return true;
    return /^\s*\[\s*[^\]\n]{1,160}\s*[:：]/.test(text) || /<\/?Example_Responses>/i.test(text);
}

function cloneNativeTextBlocks(blocks) {
    return sanitizeNativeContentBlocks(blocks, { stripCacheControl: true });
}

function universalSystemJournalScope(body) {
    return hashText([
        currentNativeChatIdentity(),
        body?.custom_url || '',
        body?.model || '',
        body?.char_name || '',
        body?.user_name || '',
    ].join('\n'));
}

function loadUniversalSystemJournalStore() {
    if (universalSystemJournalMemoryLoaded) return universalSystemJournalMemory;
    universalSystemJournalMemoryLoaded = true;
    try {
        const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(UNIVERSAL_SYSTEM_JOURNAL_KEY) : '';
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) universalSystemJournalMemory = parsed;
    } catch { /* noop */ }
    return universalSystemJournalMemory;
}

function trimUniversalJournalScopes(store, activeScope) {
    const scopes = Object.keys(store).sort((left, right) => (
        Number(store[right]?.savedAt || 0) - Number(store[left]?.savedAt || 0)
    ));
    const keep = new Set([activeScope, ...scopes.filter(scope => scope !== activeScope).slice(0, MAX_UNIVERSAL_JOURNAL_SCOPES - 1)]);
    for (const scope of scopes) {
        if (!keep.has(scope)) delete store[scope];
    }
}

function saveUniversalSystemJournalStore(store) {
    universalSystemJournalMemory = store;
    try {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(UNIVERSAL_SYSTEM_JOURNAL_KEY, JSON.stringify(store));
        }
    } catch { /* keep in memory */ }
}

function systemBlockTexts(blocks) {
    return blocks.map(block => String(block?.text || ''));
}

function sanitizeStoredSystemTexts(texts) {
    return (Array.isArray(texts) ? texts : [])
        .map(text => String(text ?? ''))
        .filter(text => text.trim().length > 0);
}

function sameStringArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringArrayStartsWith(values, prefix) {
    return values.length >= prefix.length && prefix.every((value, index) => values[index] === value);
}

function appendedSystemBlocks(currentBlocks, currentTexts, previousTexts) {
    if (stringArrayStartsWith(currentTexts, previousTexts)) {
        return cloneNativeTextBlocks(currentBlocks.slice(previousTexts.length));
    }
    if (!previousTexts.length || currentTexts.length < previousTexts.length) return null;

    const lastPreviousIndex = previousTexts.length - 1;
    for (let index = 0; index < lastPreviousIndex; index++) {
        if (currentTexts[index] !== previousTexts[index]) return null;
    }
    const previousTail = previousTexts[lastPreviousIndex];
    const currentTail = currentTexts[lastPreviousIndex];
    if (!currentTail.startsWith(previousTail)) return null;

    const suffix = currentTail.slice(previousTail.length);
    const appended = [];
    if (suffix) appended.push({ ...structuredClone(currentBlocks[lastPreviousIndex]), text: suffix });
    appended.push(...cloneNativeTextBlocks(currentBlocks.slice(previousTexts.length)));
    return appended.length ? appended : null;
}

function buildSystemRevisionBlock(currentTexts, revision) {
    const sections = currentTexts.map((text, index) => (
        `<stch_system_block index="${index}">\n${text}\n</stch_system_block>`
    ));
    return {
        type: 'text',
        text: [
            `<stch_system_revision number="${revision}">`,
            'The following is the current authoritative system context. Where it differs from earlier cached system context, this revision supersedes the earlier version.',
            ...sections,
            '</stch_system_revision>',
        ].join('\n\n'),
    };
}

function buildSystemAppendBlock(appendedBlocks, revision) {
    const sections = appendedBlocks.map((block, index) => (
        `<stch_system_append_block index="${index}">\n${String(block?.text || '')}\n</stch_system_append_block>`
    ));
    return {
        type: 'text',
        text: [
            `<stch_system_append number="${revision}">`,
            'Append the following blocks to the current authoritative system context in this order.',
            ...sections,
            '</stch_system_append>',
        ].join('\n\n'),
    };
}

function addUniversalJournalProtocol(blocks) {
    return [
        ...cloneNativeTextBlocks(blocks),
        { type: 'text', text: UNIVERSAL_JOURNAL_PROTOCOL_SYSTEM },
    ];
}

function stabilizeUniversalSystemBlocks(blocks, body) {
    const current = cloneNativeTextBlocks(blocks);
    const currentTexts = systemBlockTexts(current);
    const freshWire = cloneNativeTextBlocks(current.length === 1 ? splitNativeSystemBlock(current[0]) : current);
    if (!settings().universalIncrementalCache) {
        return {
            blocks: freshWire,
            epochHash: hashText(currentTexts.join('\n---STCH-SYSTEM---\n')),
            status: 'disabled',
            revision: 0,
            appendedChars: currentTexts.reduce((sum, text) => sum + text.length, 0),
            deferredContextBlocks: [],
        };
    }

    const store = loadUniversalSystemJournalStore();
    const scope = universalSystemJournalScope(body);
    const previous = store[scope];
    let wire = addUniversalJournalProtocol(freshWire);
    let revision = 0;
    let status = 'created';
    let epochHash = hashText(currentTexts.join('\n---STCH-SYSTEM---\n'));
    let appendedChars = currentTexts.reduce((sum, text) => sum + text.length, 0);
    let accumulatedJournalChars = 0;
    let deferredContextBlocks = [];

    const previousLogicalTexts = sanitizeStoredSystemTexts(previous?.logicalTexts);
    const previousWire = cloneNativeTextBlocks(previous?.wireBlocks || []);
    if (previous?.protocolVersion === 1 && previousLogicalTexts.length && previousWire.length) {
        revision = Number(previous.revision || 0);
        epochHash = String(previous.epochHash || epochHash);
        accumulatedJournalChars = Number(previous.accumulatedJournalChars || 0);
        appendedChars = 0;
        wire = previousWire;
        if (sameStringArray(currentTexts, previousLogicalTexts)) {
            status = 'reused';
        } else {
            revision++;
            const appended = appendedSystemBlocks(current, currentTexts, previousLogicalTexts);
            if (appended) {
                const appendBlock = buildSystemAppendBlock(appended, revision);
                deferredContextBlocks = [appendBlock];
                appendedChars = appendBlock.text.length;
                status = 'appended';
            } else {
                const revisionBlock = buildSystemRevisionBlock(currentTexts, revision);
                deferredContextBlocks = [revisionBlock];
                appendedChars = revisionBlock.text.length;
                status = 'revised';
            }
            accumulatedJournalChars += appendedChars;
        }
    }

    const journalIsBloated = accumulatedJournalChars > MAX_UNIVERSAL_SYSTEM_JOURNAL_CHARS;
    if (revision > MAX_UNIVERSAL_SYSTEM_REVISIONS || journalIsBloated) {
        wire = addUniversalJournalProtocol(freshWire);
        revision = 0;
        epochHash = hashText(`${Date.now()}:${Math.random()}:${currentTexts.join('\n---STCH-SYSTEM---\n')}`);
        appendedChars = currentTexts.reduce((sum, text) => sum + text.length, 0);
        accumulatedJournalChars = 0;
        deferredContextBlocks = [];
        status = 'epoch-reset';
    }

    store[scope] = {
        protocolVersion: 1,
        logicalTexts: currentTexts,
        wireBlocks: cloneNativeTextBlocks(wire),
        revision,
        accumulatedJournalChars,
        epochHash,
        savedAt: Date.now(),
    };
    trimUniversalJournalScopes(store, scope);
    saveUniversalSystemJournalStore(store);
    return { blocks: wire, epochHash, status, revision, appendedChars, deferredContextBlocks };
}

function buildNativeSystem(messages, model, body) {
    let blocks = [];
    let dynamicLoreBlocks = [];
    let leadingSystemMessages = 0;
    for (const message of messages) {
        if (message?.role !== 'system') break;
        leadingSystemMessages++;
        for (const part of toNativeContentBlocks(message.content)) {
            if (part.type === 'text') blocks.push(part);
        }
    }

    if (!blocks.length) return null;
    if (settings().stabilizeDynamicLoreCache) {
        const stable = [];
        const dynamic = [];
        for (const block of blocks) {
            if (isSelectiveNativeLoreBlock(block)) dynamic.push(block);
            else stable.push(block);
        }
        // Never remove every system block. A fully lore-shaped system prompt is
        // safer left untouched than converted into user context wholesale.
        if (stable.length && dynamic.length) {
            blocks = stable;
            dynamicLoreBlocks = dynamic;
        }
    }
    const universalJournal = stabilizeUniversalSystemBlocks(blocks, body);
    blocks = sanitizeNativeContentBlocks(universalJournal.blocks);
    if (!blocks.length) return null;

    const cacheControl = { type: 'ephemeral', ttl: CLAUDE_ONE_HOUR_CACHE_TTL };
    let cacheBreakpointCount = Math.min(2, blocks.length);
    for (let i = blocks.length - cacheBreakpointCount; i < blocks.length; i++) {
        blocks[i] = { ...blocks[i], cache_control: cacheControl };
    }

    const claudeCodeCompatPrefix = !!settings().claudeCodeOpusCompatPrefix
        && /^claude-opus(?:$|[/_.-])/i.test(String(model || ''));
    if (claudeCodeCompatPrefix) {
        blocks.unshift(
            { type: 'text', text: CLAUDE_CODE_COMPAT_BILLING_SYSTEM },
            { type: 'text', text: CLAUDE_CODE_COMPAT_IDENTITY_SYSTEM, cache_control: cacheControl },
            { type: 'text', text: CLAUDE_CODE_COMPAT_NEUTRALIZER_SYSTEM },
        );
        cacheBreakpointCount++;
    }

    return {
        blocks,
        dynamicLoreBlocks,
        deferredContextBlocks: universalJournal.deferredContextBlocks,
        universalSystemJournal: {
            status: universalJournal.status,
            revision: universalJournal.revision,
            appendedChars: universalJournal.appendedChars,
        },
        leadingSystemMessages,
        cacheBreakpointCount,
        claudeCodeCompatPrefix,
        stableSystemHash: universalJournal.epochHash,
    };
}

function parseOpenAIToolCalls(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function buildNativeMessages(messages, leadingSystemMessages, model) {
    const out = [];
    const append = (role, blocks) => {
        if (!blocks.length) blocks = [{ type: 'text', text: '...' }];
        const previous = out[out.length - 1];
        if (previous?.role === role) previous.content.push(...blocks);
        else out.push({ role, content: blocks });
    };

    for (const message of messages.slice(leadingSystemMessages)) {
        if (message?.role === 'tool') {
            append('user', [{
                type: 'tool_result',
                tool_use_id: String(message.tool_call_id || ''),
                content: contentToText(message.content),
            }]);
            continue;
        }
        if (!['user', 'assistant'].includes(message?.role)) continue;

        const blocks = toNativeContentBlocks(message.content);
        if (message.role === 'assistant') {
            for (const toolCall of parseOpenAIToolCalls(message.tool_calls)) {
                let input = {};
                try {
                    input = JSON.parse(toolCall?.function?.arguments || '{}');
                } catch {
                    input = {};
                }
                blocks.push({
                    type: 'tool_use',
                    id: String(toolCall?.id || ''),
                    name: String(toolCall?.function?.name || ''),
                    input,
                });
            }
        }
        append(message.role, blocks);
    }

    if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: "Let's get started." }] });
    if (out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '...' }] });

    const noPrefillModel = /^claude-(?:opus-4-[6-8]|sonnet-4-6)/i.test(String(model || ''));
    if (noPrefillModel && out[out.length - 1]?.role === 'assistant') return null;
    return out;
}

function cloneNativeContentWithoutCacheControl(content) {
    return sanitizeNativeContentBlocks(content, { stripCacheControl: true });
}

function nativeUserPersistentText(message) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return '';
    const part = message.content.find(item => item?.type === 'text' && String(item.text || '').length > 0);
    return part ? String(part.text) : '';
}

function nativeConversationTurnKey(messages, targetUser) {
    const parts = [];
    for (const message of messages) {
        if (message?.role !== 'user' && message?.role !== 'assistant') continue;
        const text = message.role === 'user'
            ? nativeUserPersistentText(message)
            : (Array.isArray(message.content)
                ? message.content.filter(item => item?.type === 'text').map(item => String(item.text || '')).join('\n')
                : String(message.content || ''));
        parts.push(`${message.role}:${text}`);
        if (message === targetUser) break;
    }
    return hashText(parts.join('\n---\n'));
}

function isContinuationUserText(text) {
    return /(?:【只输出续写内容】|你正在续写上一条\s*assistant|只输出[“"']?接在|continue\s+the\s+previous\s+assistant)/i.test(String(text || ''));
}

function currentNativeChatIdentity() {
    try {
        const context = getContext();
        const chatId = context?.chatId || context?.getCurrentChatId?.() || '';
        const groupId = context?.groupId || '';
        const characterId = context?.characterId ?? '';
        return `${groupId}:${characterId}:${chatId}`;
    } catch {
        return '';
    }
}

function stableNativeIdentifier(seed) {
    const hex = Array.from({ length: 4 }, (_, index) => hashText(`${index}:${seed}`)).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nativeClaudeDeviceId() {
    if (nativeClaudeDeviceIdMemory) return nativeClaudeDeviceIdMemory;
    try {
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(NATIVE_CLAUDE_DEVICE_ID_KEY) : '';
        if (stored) return (nativeClaudeDeviceIdMemory = stored);
    } catch { /* use a generated in-memory ID */ }

    const randomId = globalThis.crypto?.randomUUID?.();
    nativeClaudeDeviceIdMemory = randomId || stableNativeIdentifier(`${Date.now()}:${Math.random()}`);
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(NATIVE_CLAUDE_DEVICE_ID_KEY, nativeClaudeDeviceIdMemory);
    } catch { /* keep in memory */ }
    return nativeClaudeDeviceIdMemory;
}

function nativeClaudeCacheMetadata(body, stableSystemHash) {
    const sessionSeed = [
        currentNativeChatIdentity(),
        body?.custom_url || '',
        body?.model || '',
        body?.char_name || '',
        body?.user_name || '',
        stableSystemHash || '',
    ].join('\n');
    const sessionId = stableNativeIdentifier(sessionSeed);
    return {
        sessionId,
        metadata: {
            user_id: JSON.stringify({
                device_id: nativeClaudeDeviceId(),
                account_uuid: '',
                session_id: sessionId,
            }),
        },
    };
}

function nativeUserSnapshotScope(body, stableSystemHash) {
    return hashText([
        currentNativeChatIdentity(),
        body?.custom_url || '',
        body?.model || '',
        body?.char_name || '',
        body?.user_name || '',
        stableSystemHash || '',
    ].join('\n'));
}

function cloneNativeConversationMessages(messages) {
    return sanitizeNativeMessages(messages, { stripCacheControl: true });
}

function extractNativeUserSideContext(messages) {
    const logicalMessages = cloneNativeConversationMessages(messages);
    let latestUserIndex = -1;
    for (let index = logicalMessages.length - 1; index >= 0; index--) {
        if (logicalMessages[index]?.role === 'user') {
            latestUserIndex = index;
            break;
        }
    }

    const contextBlocks = [];
    let strippedHistoricalBlocks = 0;
    for (let messageIndex = 0; messageIndex < logicalMessages.length; messageIndex++) {
        const message = logicalMessages[messageIndex];
        if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
        let keptPrimaryText = false;
        const kept = [];
        for (const block of message.content) {
            if (block?.type !== 'text' || !String(block.text || '').length) {
                kept.push(block);
                continue;
            }
            if (!keptPrimaryText) {
                kept.push(block);
                keptPrimaryText = true;
                continue;
            }
            if (messageIndex === latestUserIndex) contextBlocks.push({ type: 'text', text: String(block.text) });
            else strippedHistoricalBlocks++;
        }
        message.content = kept.length ? kept : [{ type: 'text', text: '...' }];
    }
    return { messages: logicalMessages, contextBlocks, strippedHistoricalBlocks };
}

function sameNativeValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function nativeValueWithoutKey(value, key) {
    const clone = structuredClone(value);
    delete clone[key];
    return clone;
}

function nativeContentAppendDelta(currentContent, previousContent) {
    const current = cloneNativeContentWithoutCacheControl(currentContent);
    const previous = cloneNativeContentWithoutCacheControl(previousContent);
    if (!previous.length) return current;
    if (current.length < previous.length) return null;

    let exactBlockPrefix = true;
    for (let index = 0; index < previous.length; index++) {
        if (!sameNativeValue(current[index], previous[index])) {
            exactBlockPrefix = false;
            break;
        }
    }
    if (exactBlockPrefix) return current.slice(previous.length);

    const tailIndex = previous.length - 1;
    for (let index = 0; index < tailIndex; index++) {
        if (!sameNativeValue(current[index], previous[index])) return null;
    }
    const previousTail = previous[tailIndex];
    const currentTail = current[tailIndex];
    if (previousTail?.type !== 'text' || currentTail?.type !== 'text') return null;
    if (!sameNativeValue(nativeValueWithoutKey(currentTail, 'text'), nativeValueWithoutKey(previousTail, 'text'))) return null;

    const previousText = String(previousTail.text || '');
    const currentText = String(currentTail.text || '');
    if (!currentText.startsWith(previousText)) return null;
    const suffix = currentText.slice(previousText.length);
    const appended = [];
    if (suffix) appended.push({ ...currentTail, text: suffix });
    appended.push(...current.slice(previous.length));
    return appended.length ? appended : null;
}

function nativeConversationAppendDelta(currentMessages, previousMessages) {
    const current = cloneNativeConversationMessages(currentMessages);
    const previous = cloneNativeConversationMessages(previousMessages);
    if (!previous.length) return current;
    if (current.length < previous.length) return null;

    const lastPreviousIndex = previous.length - 1;
    for (let index = 0; index < lastPreviousIndex; index++) {
        if (!sameNativeValue(current[index], previous[index])) return null;
    }
    const previousTail = previous[lastPreviousIndex];
    const currentTail = current[lastPreviousIndex];
    if (sameNativeValue(currentTail, previousTail)) return current.slice(previous.length);
    if (currentTail?.role !== previousTail?.role) return null;
    if (!sameNativeValue(nativeValueWithoutKey(currentTail, 'content'), nativeValueWithoutKey(previousTail, 'content'))) return null;

    const contentDelta = nativeContentAppendDelta(currentTail.content, previousTail.content);
    if (!contentDelta?.length) return null;
    return [
        { ...nativeValueWithoutKey(currentTail, 'content'), content: contentDelta },
        ...current.slice(previous.length),
    ];
}

function appendNativeConversationMessages(baseMessages, appendedMessages) {
    const out = cloneNativeConversationMessages(baseMessages);
    for (const message of cloneNativeConversationMessages(appendedMessages)) {
        if (!message?.role || !Array.isArray(message.content) || !message.content.length) continue;
        const previous = out[out.length - 1];
        if (previous?.role === message.role) previous.content.push(...message.content);
        else out.push(message);
    }
    return out;
}

function appendJournalContextBlocks(messages, blocks) {
    const wire = cloneNativeConversationMessages(messages);
    if (!Array.isArray(blocks) || !blocks.length) return wire;
    const currentUser = [...wire].reverse().find(message => message?.role === 'user' && Array.isArray(message.content));
    if (!currentUser) return wire;
    currentUser.content.push(...cloneNativeContentWithoutCacheControl(blocks));
    return wire;
}

function nativeConversationCharCount(messages) {
    let count = 0;
    for (const message of messages) {
        count += String(message?.role || '').length;
        for (const block of Array.isArray(message?.content) ? message.content : []) {
            count += block?.type === 'text' ? String(block.text || '').length : JSON.stringify(block ?? null).length;
        }
    }
    return count;
}

function fallbackConversationMatches(previousSerialized, currentSerialized) {
    const matches = [];
    const limit = Math.min(previousSerialized.length, currentSerialized.length);
    let prefix = 0;
    while (prefix < limit && previousSerialized[prefix] === currentSerialized[prefix]) {
        matches.push([prefix, prefix]);
        prefix++;
    }

    const suffix = [];
    let previousIndex = previousSerialized.length - 1;
    let currentIndex = currentSerialized.length - 1;
    while (previousIndex >= prefix && currentIndex >= prefix && previousSerialized[previousIndex] === currentSerialized[currentIndex]) {
        suffix.push([previousIndex, currentIndex]);
        previousIndex--;
        currentIndex--;
    }
    return [...matches, ...suffix.reverse()];
}

function conversationLcsMatches(previousMessages, currentMessages) {
    const previousSerialized = previousMessages.map(message => JSON.stringify(message));
    const currentSerialized = currentMessages.map(message => JSON.stringify(message));
    const previousCount = previousSerialized.length;
    const currentCount = currentSerialized.length;
    if (previousCount * currentCount > MAX_CONVERSATION_DIFF_CELLS) {
        return fallbackConversationMatches(previousSerialized, currentSerialized);
    }

    const rows = Array.from({ length: previousCount + 1 }, () => new Uint16Array(currentCount + 1));
    for (let previousIndex = previousCount - 1; previousIndex >= 0; previousIndex--) {
        for (let currentIndex = currentCount - 1; currentIndex >= 0; currentIndex--) {
            rows[previousIndex][currentIndex] = previousSerialized[previousIndex] === currentSerialized[currentIndex]
                ? rows[previousIndex + 1][currentIndex + 1] + 1
                : Math.max(rows[previousIndex + 1][currentIndex], rows[previousIndex][currentIndex + 1]);
        }
    }

    const matches = [];
    let previousIndex = 0;
    let currentIndex = 0;
    while (previousIndex < previousCount && currentIndex < currentCount) {
        if (previousSerialized[previousIndex] === currentSerialized[currentIndex]) {
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

function buildConversationRevisionOperations(previousMessages, currentMessages) {
    const matches = conversationLcsMatches(previousMessages, currentMessages);
    const operations = [];
    let previousCursor = 0;
    let currentCursor = 0;
    for (const [previousMatch, currentMatch] of [...matches, [previousMessages.length, currentMessages.length]]) {
        if (previousMatch > previousCursor || currentMatch > currentCursor) {
            const removed = previousMessages.slice(previousCursor, previousMatch);
            const inserted = currentMessages.slice(currentCursor, currentMatch);
            if (removed.length === 1 && inserted.length === 1 && removed[0]?.role === inserted[0]?.role) {
                const contentDelta = nativeContentAppendDelta(inserted[0].content, removed[0].content);
                if (contentDelta?.length) {
                    operations.push({
                        type: 'append_content',
                        previous_message_index: previousCursor,
                        role: inserted[0].role,
                        appended_content: contentDelta,
                    });
                } else {
                    operations.push({
                        type: 'splice',
                        previous_start_index: previousCursor,
                        delete_count: removed.length,
                        current_start_index: currentCursor,
                        insert_messages: inserted,
                    });
                }
            } else {
                operations.push({
                    type: 'splice',
                    previous_start_index: previousCursor,
                    delete_count: removed.length,
                    current_start_index: currentCursor,
                    insert_messages: inserted,
                });
            }
        }
        previousCursor = previousMatch + 1;
        currentCursor = currentMatch + 1;
    }
    return operations;
}

function buildConversationRevisionMessage(previousMessages, currentMessages, operations, revision) {
    const patch = {
        base_revision: revision - 1,
        current_revision: revision,
        base_message_count: previousMessages.length,
        current_message_count: currentMessages.length,
        base_digest: hashText(JSON.stringify(previousMessages)),
        current_digest: hashText(JSON.stringify(currentMessages)),
        operations,
    };
    return {
        role: 'user',
        content: [{
            type: 'text',
            text: [
                `<stch_conversation_revision number="${revision}">`,
                'This is an append-only cache-journal correction, not a new chat turn. Apply the JSON operations to the prior authoritative conversation state. All edits, deletions, insertions, and reordering in this revision supersede the older cached messages where they differ. Continue the roleplay or task from the final message of the corrected conversation; do not discuss this correction.',
                '<stch_conversation_patch_json>',
                JSON.stringify(patch),
                '</stch_conversation_patch_json>',
                '</stch_conversation_revision>',
            ].join('\n'),
        }],
    };
}

function loadUniversalConversationJournalStore() {
    if (universalConversationJournalMemoryLoaded) return universalConversationJournalMemory;
    universalConversationJournalMemoryLoaded = true;
    try {
        const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(UNIVERSAL_CONVERSATION_JOURNAL_KEY) : '';
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) universalConversationJournalMemory = parsed;
    } catch { /* noop */ }
    return universalConversationJournalMemory;
}

function saveUniversalConversationJournalStore(store) {
    universalConversationJournalMemory = store;
    try {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(UNIVERSAL_CONVERSATION_JOURNAL_KEY, JSON.stringify(store));
        }
    } catch { /* keep in memory */ }
}

function stabilizeUniversalConversationMessages(messages, body, stableSystemHash, dynamicLoreBlocks = [], deferredContextBlocks = []) {
    const current = cloneNativeConversationMessages(messages);
    const initialChars = nativeConversationCharCount(current);
    if (!settings().universalIncrementalCache) {
        return {
            messages: current,
            epochHash: '',
            status: 'disabled',
            revision: 0,
            wirePrefixReused: false,
            appendedMessages: current.length,
            appendedChars: initialChars,
            revisionOperations: 0,
        };
    }

    const store = loadUniversalConversationJournalStore();
    const scope = nativeUserSnapshotScope(body, stableSystemHash);
    const previous = store[scope];
    let wire = current;
    let revision = 0;
    let status = 'created';
    let epochHash = hashText(`conversation-journal-v1:${scope}`);
    let wirePrefixReused = false;
    let appendedMessages = current.length;
    let appendedChars = initialChars;
    let revisionOperations = 0;
    let contextWasCompacted = false;

    if (previous && Array.isArray(previous.logicalMessages) && Array.isArray(previous.wireMessages)) {
        const previousLogical = cloneNativeConversationMessages(previous.logicalMessages);
        const previousWire = cloneNativeConversationMessages(previous.wireMessages);
        revision = Number(previous.revision || 0);
        epochHash = String(previous.epochHash || epochHash);
        wirePrefixReused = true;
        appendedMessages = 0;
        appendedChars = 0;

        if (sameNativeValue(current, previousLogical)) {
            wire = previousWire;
            status = 'reused';
        } else {
            const appendDelta = nativeConversationAppendDelta(current, previousLogical);
            if (appendDelta) {
                wire = appendNativeConversationMessages(previousWire, appendDelta);
                status = 'appended';
                appendedMessages = appendDelta.length;
                appendedChars = nativeConversationCharCount(appendDelta);
            } else {
                revision++;
                const operations = buildConversationRevisionOperations(previousLogical, current);
                const firstOperation = operations[0];
                const leadingRangeWasCompacted = firstOperation?.type === 'splice'
                    && firstOperation.previous_start_index === 0
                    && firstOperation.current_start_index === 0
                    && firstOperation.delete_count >= 2
                    && firstOperation.insert_messages.length < firstOperation.delete_count;
                const conversationShrankSubstantially = current.length + 4 < previousLogical.length
                    && nativeConversationCharCount(current) < nativeConversationCharCount(previousLogical) * 0.85;
                contextWasCompacted = leadingRangeWasCompacted || conversationShrankSubstantially;
                const tailOperation = operations.at(-1);
                const tailMessages = tailOperation?.type === 'splice'
                    && tailOperation.previous_start_index === previousLogical.length
                    && tailOperation.delete_count === 0
                    ? cloneNativeConversationMessages(operations.pop().insert_messages)
                    : [];
                const revisionMessage = buildConversationRevisionMessage(previousLogical, current, operations, revision);
                wire = appendNativeConversationMessages(previousWire, [revisionMessage, ...tailMessages]);
                if (current.at(-1)?.role === 'assistant' && wire.at(-1)?.role !== 'assistant') {
                    wire = appendNativeConversationMessages(wire, [current.at(-1)]);
                }
                status = 'revised';
                revisionOperations = operations.length;
                appendedMessages = 1 + tailMessages.length;
                appendedChars = nativeConversationCharCount([revisionMessage, ...tailMessages]);
            }
        }
    }

    const previousDynamicTexts = wirePrefixReused && Array.isArray(previous?.dynamicTexts)
        ? previous.dynamicTexts
        : null;
    let dynamicJournal = appendUniversalDynamicContext(wire, dynamicLoreBlocks, previousDynamicTexts);
    wire = dynamicJournal.messages;
    appendedChars += dynamicJournal.appendedDynamicChars;
    const deferredContextChars = deferredContextBlocks.reduce((sum, block) => sum + String(block?.text || '').length, 0);
    wire = appendJournalContextBlocks(wire, deferredContextBlocks);
    appendedChars += deferredContextChars;
    if (status === 'reused' && (dynamicJournal.appendedDynamicChars > 0 || deferredContextChars > 0)) status = 'appended';

    const wireSerializedChars = JSON.stringify(wire).length;
    const currentSerializedChars = JSON.stringify(current).length
        + dynamicJournal.currentTexts.reduce((sum, text) => sum + text.length, 0);
    const journalIsBloated = wireSerializedChars > MAX_UNIVERSAL_CONVERSATION_JOURNAL_CHARS
        && wireSerializedChars > currentSerializedChars * 1.25;
    if (revision > MAX_UNIVERSAL_CONVERSATION_REVISIONS || journalIsBloated || contextWasCompacted) {
        wire = current;
        revision = 0;
        epochHash = hashText(`${Date.now()}:${Math.random()}:${JSON.stringify(current)}`);
        status = 'epoch-reset';
        wirePrefixReused = false;
        appendedMessages = current.length;
        appendedChars = initialChars;
        revisionOperations = 0;
        dynamicJournal = appendUniversalDynamicContext(wire, dynamicLoreBlocks, null);
        wire = dynamicJournal.messages;
        appendedChars += dynamicJournal.appendedDynamicChars;
        wire = appendJournalContextBlocks(wire, deferredContextBlocks);
        appendedChars += deferredContextChars;
    }

    store[scope] = {
        logicalMessages: current,
        wireMessages: cloneNativeConversationMessages(wire),
        dynamicTexts: dynamicJournal.currentTexts,
        revision,
        epochHash,
        savedAt: Date.now(),
    };
    trimUniversalJournalScopes(store, scope);
    saveUniversalConversationJournalStore(store);
    return {
        messages: wire,
        epochHash,
        status,
        revision,
        wirePrefixReused,
        appendedMessages,
        appendedChars,
        revisionOperations,
        dynamicLoreBlockCount: dynamicJournal.dynamicLoreBlockCount,
        reusedDynamicBlocks: dynamicJournal.reusedDynamicBlocks,
        appendedDynamicSuffixes: dynamicJournal.appendedDynamicSuffixes,
        revisedDynamicBlocks: dynamicJournal.revisedDynamicBlocks,
        removedDynamicBlocks: dynamicJournal.removedDynamicBlocks,
        appendedDynamicChars: dynamicJournal.appendedDynamicChars,
        incrementalWireReused: wirePrefixReused && previousDynamicTexts !== null,
        deferredSystemChars: deferredContextChars,
        contextWasCompacted,
    };
}

function loadNativeUserCacheSnapshotStore() {
    if (nativeUserCacheSnapshotMemoryLoaded) return nativeUserCacheSnapshotMemory;
    nativeUserCacheSnapshotMemoryLoaded = true;
    try {
        const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(NATIVE_USER_CACHE_SNAPSHOTS_KEY) : '';
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) nativeUserCacheSnapshotMemory = parsed;
    } catch { /* noop */ }
    return nativeUserCacheSnapshotMemory;
}

function saveNativeUserCacheSnapshotStore(store) {
    nativeUserCacheSnapshotMemory = store;
    try {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(NATIVE_USER_CACHE_SNAPSHOTS_KEY, JSON.stringify(store));
        }
    } catch { /* keep in memory */ }
}

function trimNativeUserSnapshots(snapshots) {
    let trimmed = snapshots.slice(-MAX_NATIVE_USER_CACHE_SNAPSHOTS);
    while (trimmed.length > 1 && JSON.stringify(trimmed).length > MAX_NATIVE_USER_CACHE_SNAPSHOT_CHARS) {
        trimmed = trimmed.slice(1);
    }
    return trimmed;
}

function restoreNativeUserSnapshots(messages, snapshots, currentUser) {
    const historicalUsers = messages.filter(message => message.role === 'user' && message !== currentUser);
    let snapshotIndex = snapshots.length - 1;
    let restored = 0;
    for (let messageIndex = historicalUsers.length - 1; messageIndex >= 0 && snapshotIndex >= 0; messageIndex--) {
        const message = historicalUsers[messageIndex];
        const persistentText = nativeUserPersistentText(message);
        if (!persistentText) continue;
        const turnKey = nativeConversationTurnKey(messages, message);
        let matchIndex = -1;
        for (let i = snapshotIndex; i >= 0; i--) {
            if (snapshots[i]?.turnKey === turnKey) {
                matchIndex = i;
                break;
            }
        }
        // Backward compatibility for any unkeyed snapshot. Match it by
        // occurrence order, never by a
        // global text lookup that could collapse repeated user messages.
        if (matchIndex === -1) {
            for (let i = snapshotIndex; i >= 0; i--) {
                if (!snapshots[i]?.turnKey && snapshots[i]?.persistentText === persistentText) {
                    matchIndex = i;
                    break;
                }
            }
        }
        if (matchIndex === -1) continue;
        message.content = cloneNativeContentWithoutCacheControl(snapshots[matchIndex].content);
        snapshotIndex = matchIndex - 1;
        restored++;
    }
    return restored;
}

function fullDynamicContextBlock(text, index) {
    return `<stch_dynamic_context index="${index}">\n${text}\n</stch_dynamic_context>`;
}

function revisedDynamicContextBlock(text, index) {
    return [
        `<stch_dynamic_context_revision index="${index}">`,
        `Dynamic context ${index} above has changed. The following version is current and authoritative; ignore the earlier version where they differ.`,
        text,
        '</stch_dynamic_context_revision>',
    ].join('\n');
}

function appendedDynamicContextBlock(text, index) {
    return [
        `<stch_dynamic_context_append index="${index}">`,
        `Append the following content to dynamic context ${index} from the earlier cached journal. Together they form the current authoritative context.`,
        text,
        '</stch_dynamic_context_append>',
    ].join('\n');
}

function removedDynamicContextBlock(index) {
    return [
        `<stch_dynamic_context_removed index="${index}">`,
        `Dynamic context ${index} from the earlier cached request is no longer active. Ignore that earlier context.`,
        '</stch_dynamic_context_removed>',
    ].join('\n');
}

function appendUniversalDynamicContext(messages, dynamicLoreBlocks, previousTexts = null) {
    const currentTexts = dynamicLoreBlocks.map(block => String(block?.text || ''));
    const stats = {
        dynamicLoreBlockCount: currentTexts.length,
        reusedDynamicBlocks: 0,
        appendedDynamicSuffixes: 0,
        revisedDynamicBlocks: 0,
        removedDynamicBlocks: 0,
        appendedDynamicChars: 0,
        currentTexts,
    };
    const wire = cloneNativeConversationMessages(messages);
    const currentUser = [...wire].reverse().find(message => message?.role === 'user' && Array.isArray(message.content));
    if (!currentUser) return { messages: wire, ...stats };

    const previous = Array.isArray(previousTexts) ? previousTexts.map(String) : null;
    const appendedParts = [];
    if (!previous) {
        for (let index = 0; index < currentTexts.length; index++) {
            const text = fullDynamicContextBlock(currentTexts[index], index);
            appendedParts.push({ type: 'text', text });
            stats.appendedDynamicChars += text.length;
        }
    } else {
        const count = Math.max(previous.length, currentTexts.length);
        for (let index = 0; index < count; index++) {
            const oldText = previous[index];
            const currentText = currentTexts[index];
            if (currentText === oldText) {
                stats.reusedDynamicBlocks++;
                continue;
            }
            if (currentText === undefined) {
                const text = removedDynamicContextBlock(index);
                appendedParts.push({ type: 'text', text });
                stats.removedDynamicBlocks++;
                stats.appendedDynamicChars += text.length;
                continue;
            }
            if (oldText !== undefined && currentText.startsWith(oldText)) {
                const suffix = currentText.slice(oldText.length);
                if (suffix) {
                    const text = appendedDynamicContextBlock(suffix, index);
                    appendedParts.push({ type: 'text', text });
                    stats.appendedDynamicSuffixes++;
                    stats.appendedDynamicChars += text.length;
                }
                continue;
            }
            const text = oldText === undefined
                ? fullDynamicContextBlock(currentText, index)
                : revisedDynamicContextBlock(currentText, index);
            appendedParts.push({ type: 'text', text });
            if (oldText === undefined) stats.appendedDynamicSuffixes++;
            else stats.revisedDynamicBlocks++;
            stats.appendedDynamicChars += text.length;
        }
    }
    currentUser.content.push(...appendedParts);
    return { messages: wire, ...stats };
}

function appendDynamicLoreToCurrentUser(currentUser, dynamicLoreBlocks, previousSnapshot = null) {
    const currentTexts = dynamicLoreBlocks.map(block => String(block?.text || ''));
    const stats = {
        dynamicLoreBlockCount: currentTexts.length,
        reusedDynamicBlocks: 0,
        appendedDynamicSuffixes: 0,
        revisedDynamicBlocks: 0,
        removedDynamicBlocks: 0,
        appendedDynamicChars: 0,
        incrementalWireReused: false,
        currentTexts,
    };
    if (!currentUser || !Array.isArray(currentUser.content)) return stats;

    const previousTexts = Array.isArray(previousSnapshot?.dynamicLoreTexts)
        ? previousSnapshot.dynamicLoreTexts.map(String)
        : null;
    const canReuseWire = settings().universalIncrementalCache
        && previousTexts
        && Array.isArray(previousSnapshot?.content);

    if (!canReuseWire) {
        for (let index = 0; index < currentTexts.length; index++) {
            const text = fullDynamicContextBlock(currentTexts[index], index);
            currentUser.content.push({ type: 'text', text });
            stats.appendedDynamicChars += text.length;
        }
        return stats;
    }

    currentUser.content = cloneNativeContentWithoutCacheControl(previousSnapshot.content);
    stats.incrementalWireReused = true;
    const count = Math.max(previousTexts.length, currentTexts.length);
    for (let index = 0; index < count; index++) {
        const previous = previousTexts[index];
        const current = currentTexts[index];
        if (current === previous) {
            stats.reusedDynamicBlocks++;
            continue;
        }
        if (current === undefined) {
            const text = removedDynamicContextBlock(index);
            currentUser.content.push({ type: 'text', text });
            stats.removedDynamicBlocks++;
            stats.appendedDynamicChars += text.length;
            continue;
        }
        if (previous !== undefined && current.startsWith(previous)) {
            const suffix = current.slice(previous.length);
            if (suffix) {
                currentUser.content.push({ type: 'text', text: suffix });
                stats.appendedDynamicSuffixes++;
                stats.appendedDynamicChars += suffix.length;
            }
            continue;
        }
        const text = previous === undefined
            ? fullDynamicContextBlock(current, index)
            : revisedDynamicContextBlock(current, index);
        currentUser.content.push({ type: 'text', text });
        if (previous === undefined) stats.appendedDynamicSuffixes++;
        else stats.revisedDynamicBlocks++;
        stats.appendedDynamicChars += text.length;
    }
    return stats;
}

function prepareNativeUserCacheSnapshots(messages, dynamicLoreBlocks, body, stableSystemHash) {
    if (!settings().stabilizeDynamicLoreCache) {
        return { restoredUserSnapshots: 0, storedUserSnapshot: false, dynamicLoreBlockCount: 0 };
    }
    const currentUser = [...messages].reverse().find(message => message.role === 'user');
    if (!currentUser || !Array.isArray(currentUser.content)) {
        return { restoredUserSnapshots: 0, storedUserSnapshot: false, dynamicLoreBlockCount: 0 };
    }

    const store = loadNativeUserCacheSnapshotStore();
    const scope = nativeUserSnapshotScope(body, stableSystemHash);
    let snapshots = Array.isArray(store[scope]) ? store[scope] : [];
    const restoredUserSnapshots = restoreNativeUserSnapshots(messages, snapshots, currentUser);
    const persistentText = nativeUserPersistentText(currentUser);
    const turnKey = nativeConversationTurnKey(messages, currentUser);
    const existingIndex = snapshots.findIndex(item => item?.turnKey === turnKey);
    const previousSnapshot = existingIndex >= 0 ? snapshots[existingIndex] : null;
    const dynamicJournal = appendDynamicLoreToCurrentUser(currentUser, dynamicLoreBlocks, previousSnapshot);
    const continuation = isContinuationUserText(persistentText);
    let storedUserSnapshot = false;

    if (persistentText && !continuation) {
        const snapshot = {
            turnKey,
            persistentText,
            content: cloneNativeContentWithoutCacheControl(currentUser.content),
            dynamicLoreTexts: dynamicJournal.currentTexts,
            savedAt: Date.now(),
        };
        if (existingIndex >= 0) snapshots[existingIndex] = snapshot;
        else snapshots.push(snapshot);
        snapshots = trimNativeUserSnapshots(snapshots);
        store[scope] = snapshots;
        saveNativeUserCacheSnapshotStore(store);
        storedUserSnapshot = true;
    }

    delete dynamicJournal.currentTexts;
    return { restoredUserSnapshots, storedUserSnapshot, ...dynamicJournal };
}

function markLastNativeUserCacheBreakpoint(messages) {
    const cacheControl = { type: 'ephemeral', ttl: CLAUDE_ONE_HOUR_CACHE_TTL };
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
        const message = messages[messageIndex];
        if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
        for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
            const part = message.content[partIndex];
            if (!part || typeof part !== 'object') continue;
            message.content[partIndex] = { ...part, cache_control: cacheControl };
            return 1;
        }
    }
    return 0;
}

function convertNativeTools(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.map(tool => {
        if (tool?.name && tool?.input_schema) return { ...tool };
        if (tool?.type !== 'function' || !tool?.function?.name) return null;
        return {
            name: String(tool.function.name),
            description: String(tool.function.description || ''),
            input_schema: tool.function.parameters || { type: 'object', properties: {} },
        };
    }).filter(Boolean);
}

function convertNativeToolChoice(toolChoice) {
    if (!toolChoice || toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'required') return { type: 'any' };
    if (toolChoice === 'none') return undefined;
    const name = toolChoice?.function?.name || toolChoice?.name;
    return name ? { type: 'tool', name: String(name) } : { type: 'auto' };
}

function canUseNativeClaudeTransport(body) {
    const hasUnsupportedMedia = body.messages.some(message =>
        (Array.isArray(message?.media) && message.media.length)
        || (Array.isArray(message?.content) && message.content.some(part => part?.type && part.type !== 'text')),
    );
    return !body?.json_schema && !hasUnsupportedMedia;
}

function buildNativeClaudeRequest(body) {
    if (!canUseNativeClaudeTransport(body)) return null;
    const system = buildNativeSystem(body.messages, body.model, body);
    if (!system || system.cacheBreakpointCount < 2) return null;
    let messages = buildNativeMessages(body.messages, system.leadingSystemMessages, body.model);
    if (!messages) return null;
    const useUniversalJournal = settings().universalIncrementalCache;
    const userSideContext = useUniversalJournal
        ? extractNativeUserSideContext(messages)
        : { messages, contextBlocks: [], strippedHistoricalBlocks: 0 };
    messages = userSideContext.messages;
    const universalDynamicBlocks = [
        ...(useUniversalJournal ? system.dynamicLoreBlocks : []),
        ...userSideContext.contextBlocks,
    ];
    const snapshotInfo = useUniversalJournal
        ? {
            restoredUserSnapshots: 0,
            storedUserSnapshot: false,
            userSideContextBlockCount: userSideContext.contextBlocks.length,
            strippedHistoricalUserContextBlocks: userSideContext.strippedHistoricalBlocks,
        }
        : prepareNativeUserCacheSnapshots(
            messages,
            system.dynamicLoreBlocks,
            body,
            system.stableSystemHash,
        );
    const conversationJournal = stabilizeUniversalConversationMessages(
        messages,
        body,
        system.stableSystemHash,
        universalDynamicBlocks,
        useUniversalJournal ? system.deferredContextBlocks : [],
    );
    messages = sanitizeNativeMessages(conversationJournal.messages);
    if (useUniversalJournal) {
        Object.assign(snapshotInfo, {
            dynamicLoreBlockCount: conversationJournal.dynamicLoreBlockCount,
            reusedDynamicBlocks: conversationJournal.reusedDynamicBlocks,
            appendedDynamicSuffixes: conversationJournal.appendedDynamicSuffixes,
            revisedDynamicBlocks: conversationJournal.revisedDynamicBlocks,
            removedDynamicBlocks: conversationJournal.removedDynamicBlocks,
            appendedDynamicChars: conversationJournal.appendedDynamicChars,
            incrementalWireReused: conversationJournal.incrementalWireReused,
        });
    }
    const systemBlocks = sanitizeNativeContentBlocks(system.blocks);
    const systemCacheBreakpointCount = systemBlocks.filter(block => block?.cache_control).length;
    if (!systemBlocks.length || systemCacheBreakpointCount < 2) return null;

    // Claude Code also marks the newest user-side content block. Some Claude
    // gateways only activate extended-TTL caching when this message breakpoint
    // is present, even if the system blocks already carry ttl=1h.
    const messageCacheBreakpointCount = markLastNativeUserCacheBreakpoint(messages);
    const cacheEpochHash = hashText(`${system.stableSystemHash}\n${conversationJournal.epochHash}`);
    const cacheMetadata = nativeClaudeCacheMetadata(body, cacheEpochHash);

    const tools = convertNativeTools(body.tools);
    const request = {
        model: body.model,
        max_tokens: Math.max(1, Number(body.max_tokens || body.max_completion_tokens || 4096)),
        stream: !!body.stream,
        metadata: cacheMetadata.metadata,
        system: systemBlocks,
        messages,
    };
    if (Array.isArray(body.stop) && body.stop.length) request.stop_sequences = body.stop;
    if (tools.length) {
        request.tools = tools;
        const toolChoice = convertNativeToolChoice(body.tool_choice);
        if (toolChoice) request.tool_choice = toolChoice;
    }
    return {
        request,
        cacheBreakpointCount: systemCacheBreakpointCount + messageCacheBreakpointCount,
        systemCacheBreakpointCount,
        messageCacheBreakpointCount,
        claudeCodeCompatPrefix: system.claudeCodeCompatPrefix,
        universalSystemJournal: system.universalSystemJournal,
        universalConversationJournal: {
            status: conversationJournal.status,
            revision: conversationJournal.revision,
            wirePrefixReused: conversationJournal.wirePrefixReused,
            appendedMessages: conversationJournal.appendedMessages,
            appendedChars: conversationJournal.appendedChars,
            revisionOperations: conversationJournal.revisionOperations,
            deferredSystemChars: conversationJournal.deferredSystemChars,
            contextWasCompacted: conversationJournal.contextWasCompacted,
        },
        cacheSessionId: cacheMetadata.sessionId,
        ...snapshotInfo,
    };
}

function buildNativeClaudeTunnelUrl(customUrl) {
    try {
        const url = new URL(String(customUrl || ''));
        let pathname = url.pathname.replace(/\/+$/, '');
        pathname = pathname.replace(/\/(?:chat\/completions|messages)$/i, '');
        if (!/\/v1$/i.test(pathname)) pathname += '/v1';
        url.pathname = `${pathname}/messages`.replace(/\/{2,}/g, '/');
        url.hash = '';
        url.searchParams.set('beta', 'true');
        // SillyTavern appends /chat/completions to every custom URL. Keeping an
        // open query value turns that suffix into harmless query data while the
        // actual path remains /v1/messages.
        url.searchParams.set('stch_path', '');
        return url.toString();
    } catch {
        return null;
    }
}

function mergeExcludedBodyKeys(value, requiredKeys) {
    const keys = new Set(requiredKeys);
    const text = String(value || '').trim();
    if (text) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) parsed.forEach(key => keys.add(String(key)));
            else if (typeof parsed === 'string') keys.add(parsed);
            else if (parsed && typeof parsed === 'object') Object.keys(parsed).forEach(key => keys.add(key));
        } catch {
            for (const line of text.split(/\r?\n/)) {
                const match = line.match(/^\s*(?:-\s*)?([\w.-]+)\s*(?::.*)?$/);
                if (match) keys.add(match[1]);
            }
        }
    }
    return JSON.stringify([...keys]);
}

function applyCacheControlToContent(content, ttl) {
    const cacheControl = { type: 'ephemeral', ttl };
    const source = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    const parts = sanitizeNativeContentBlocks(source);
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

function applyClaudeOneHourCache(body, nativeTransportEligible = true) {
    if (!settings().claudeOneHourCache || !isClaudeCustomRequest(body)) return null;

    body.messages = sanitizeClaudeSourceMessages(body.messages);

    const native = buildNativeClaudeRequest(body);
    const nativeUrl = buildNativeClaudeTunnelUrl(body.custom_url);
    if (nativeTransportEligible && native && nativeUrl) {
        const originalCustomUrl = body.custom_url;
        body.custom_url = nativeUrl;
        body.custom_include_body = JSON.stringify(native.request);
        body.custom_exclude_body = mergeExcludedBodyKeys(body.custom_exclude_body, NATIVE_CLAUDE_EXCLUDED_BODY_KEYS);
        body.tools = native.request.tools || [];
        body.tool_choice = native.request.tool_choice;
        body.custom_include_headers = appendYamlHeaderTokens(body.custom_include_headers, 'anthropic-beta', CLAUDE_CACHE_BETA_HEADERS);
        body.custom_include_headers = appendYamlLine(body.custom_include_headers, 'anthropic-version', '2023-06-01');
        body.custom_include_headers = appendYamlLine(body.custom_include_headers, 'x-app', 'cli');
        return {
            requestedTtl: CLAUDE_ONE_HOUR_CACHE_TTL,
            transport: 'anthropic-native',
            originalCustomUrl,
            nativeEndpoint: nativeUrl,
            cacheBreakpointCount: native.cacheBreakpointCount,
            systemCacheBreakpointCount: native.systemCacheBreakpointCount,
            messageCacheBreakpointCount: native.messageCacheBreakpointCount,
            claudeCodeCompatPrefix: native.claudeCodeCompatPrefix,
            restoredUserSnapshots: native.restoredUserSnapshots,
            storedUserSnapshot: native.storedUserSnapshot,
            userSideContextBlockCount: native.userSideContextBlockCount || 0,
            strippedHistoricalUserContextBlocks: native.strippedHistoricalUserContextBlocks || 0,
            dynamicLoreBlockCount: native.dynamicLoreBlockCount,
            reusedDynamicBlocks: native.reusedDynamicBlocks,
            appendedDynamicSuffixes: native.appendedDynamicSuffixes,
            revisedDynamicBlocks: native.revisedDynamicBlocks,
            removedDynamicBlocks: native.removedDynamicBlocks,
            appendedDynamicChars: native.appendedDynamicChars,
            incrementalWireReused: native.incrementalWireReused,
            universalSystemJournal: native.universalSystemJournal,
            universalConversationJournal: native.universalConversationJournal,
            betaHeaders: [...CLAUDE_CACHE_BETA_HEADERS],
        };
    }

    const breakpointIndices = [];
    let leadingSystemMessageCount = 0;
    for (let i = 0; i < body.messages.length; i++) {
        if (body.messages[i]?.role !== 'system') break;
        leadingSystemMessageCount++;
        if (toNativeContentBlocks(body.messages[i].content).some(part => part.type === 'text')) {
            breakpointIndices.push(i);
        }
    }
    if (!breakpointIndices.length) return null;
    const targets = breakpointIndices.slice(-2);

    let updatedExisting = 0;
    for (let i = 0; i < leadingSystemMessageCount; i++) {
        const message = body.messages[i];
        if (message?.cache_control) {
            message.cache_control = { ...message.cache_control, type: 'ephemeral', ttl: CLAUDE_ONE_HOUR_CACHE_TTL };
            updatedExisting++;
        }
        if (targets.includes(i)) continue;
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

    let markedBreakpoints = 0;
    for (const index of targets) {
        const marked = applyCacheControlToContent(body.messages[index].content, CLAUDE_ONE_HOUR_CACHE_TTL);
        if (!marked) continue;
        body.messages[index].content = marked.content;
        updatedExisting += marked.updatedExisting;
        markedBreakpoints++;
    }
    if (!markedBreakpoints) return null;

    body.custom_include_headers = appendYamlHeaderTokens(
        body.custom_include_headers,
        'anthropic-beta',
        CLAUDE_CACHE_BETA_HEADERS,
    );

    return {
        requestedTtl: CLAUDE_ONE_HOUR_CACHE_TTL,
        transport: 'openai-compatible-fallback',
        breakpointIndices: targets,
        cacheBreakpointCount: markedBreakpoints,
        updatedExistingCacheControls: updatedExisting,
        betaHeaders: [...CLAUDE_CACHE_BETA_HEADERS],
    };
}

function applyOptimization(body) {
    const s = settings();
    const nativeTransportEligible = canUseNativeClaudeTransport(body);
    let promptOptimization;
    if (s.mode === 'stable_prefix_cache') promptOptimization = stablePrefixCacheFix(body);
    else if (s.mode === 'respect_choice_cache') promptOptimization = optimizeAfterSelection(body);
    else promptOptimization = legacyRewritePostProcessing(body);

    const claudeOneHourCache = applyClaudeOneHourCache(body, nativeTransportEligible);
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

function claudeStopReasonToOpenAI(reason) {
    if (reason === 'max_tokens') return 'length';
    if (reason === 'tool_use') return 'tool_calls';
    if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
    return reason || null;
}

function claudeUsageToOpenAI(usage = {}) {
    const cacheCreation = Number(usage.cache_creation_input_tokens || 0);
    const cacheRead = Number(usage.cache_read_input_tokens || 0);
    const input = Number(usage.input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    const cache5m = Number(usage.cache_creation?.ephemeral_5m_input_tokens || usage.cache_creation_5m_input_tokens || 0);
    const cache1h = Number(usage.cache_creation?.ephemeral_1h_input_tokens || usage.cache_creation_1h_input_tokens || 0);
    const promptTokens = input + cacheCreation + cacheRead;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: output,
        total_tokens: promptTokens + output,
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        claude_cache_creation_5_m_tokens: cache5m,
        claude_cache_creation_1_h_tokens: cache1h,
        prompt_tokens_details: {
            cached_tokens: cacheRead,
            cached_creation_tokens: cacheCreation,
        },
        billing_usage: {
            source: 'claude_messages',
            semantic: 'anthropic',
            claude_usage: usage,
        },
    };
}

function convertNativeClaudeJson(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data?.choices) || data.error) return data;
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter(block => block?.type === 'text').map(block => String(block.text || '')).join('');
    const reasoning = blocks.filter(block => block?.type === 'thinking').map(block => String(block.thinking || '')).join('');
    const toolCalls = blocks.filter(block => block?.type === 'tool_use').map(block => ({
        id: String(block.id || ''),
        type: 'function',
        function: {
            name: String(block.name || ''),
            arguments: JSON.stringify(block.input || {}),
        },
    }));
    const message = { role: 'assistant', content: text || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
        id: data.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: data.model,
        choices: [{
            index: 0,
            message,
            finish_reason: claudeStopReasonToOpenAI(data.stop_reason),
        }],
        usage: claudeUsageToOpenAI(data.usage),
    };
}

function createOpenAIStreamChunk(state, delta = {}, finishReason = null, usage = undefined) {
    const chunk = {
        id: state.id || 'stch-claude-stream',
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model || '',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = claudeUsageToOpenAI(usage);
    return chunk;
}

function convertNativeClaudeStreamEvent(event, state) {
    if (!event || typeof event !== 'object') return [];
    if (Array.isArray(event.choices) || event.error) return [event];

    if (event.type === 'message_start') {
        state.id = event.message?.id || state.id;
        state.model = event.message?.model || state.model;
        state.usage = { ...(event.message?.usage || {}) };
        return [createOpenAIStreamChunk(state, { role: 'assistant' }, null, state.usage)];
    }
    if (event.type === 'content_block_start') {
        const block = event.content_block || {};
        if (block.type === 'text' && block.text) return [createOpenAIStreamChunk(state, { content: block.text })];
        if (block.type === 'thinking' && block.thinking) return [createOpenAIStreamChunk(state, { reasoning_content: block.thinking })];
        if (block.type === 'tool_use') {
            const toolIndex = state.nextToolIndex++;
            state.toolIndices.set(event.index, toolIndex);
            return [createOpenAIStreamChunk(state, {
                tool_calls: [{
                    index: toolIndex,
                    id: String(block.id || ''),
                    type: 'function',
                    function: { name: String(block.name || ''), arguments: '' },
                }],
            })];
        }
        return [];
    }
    if (event.type === 'content_block_delta') {
        const delta = event.delta || {};
        if (delta.type === 'text_delta') return [createOpenAIStreamChunk(state, { content: String(delta.text || '') })];
        if (delta.type === 'thinking_delta') return [createOpenAIStreamChunk(state, { reasoning_content: String(delta.thinking || '') })];
        if (delta.type === 'input_json_delta') {
            const toolIndex = state.toolIndices.get(event.index) ?? 0;
            return [createOpenAIStreamChunk(state, {
                tool_calls: [{ index: toolIndex, function: { arguments: String(delta.partial_json || '') } }],
            })];
        }
        if (delta.type === 'signature_delta') {
            return [createOpenAIStreamChunk(state, {
                reasoning_details: [{ type: 'reasoning.encrypted', data: String(delta.signature || '') }],
            })];
        }
        return [];
    }
    if (event.type === 'message_delta') {
        state.usage = { ...state.usage, ...(event.usage || {}) };
        return [createOpenAIStreamChunk(state, {}, claudeStopReasonToOpenAI(event.delta?.stop_reason), state.usage)];
    }
    if (event.type === 'message_stop') return ['[DONE]'];
    return [];
}

function convertNativeClaudeSseResponse(response) {
    if (!response.body) return response;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const state = {
        id: '',
        model: '',
        created: Math.floor(Date.now() / 1000),
        usage: {},
        toolIndices: new Map(),
        nextToolIndex: 0,
        sentDone: false,
    };
    let buffer = '';

    const stream = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                emitFrame(frame, controller);
            }
        },
        flush(controller) {
            buffer += decoder.decode();
            if (buffer.trim()) emitFrame(buffer, controller);
            if (!state.sentDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        },
    }));

    function emitFrame(frame, controller) {
        const data = frame.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (!data) return;
        if (data === '[DONE]') {
            state.sentDone = true;
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            return;
        }
        let event;
        try {
            event = JSON.parse(data);
        } catch {
            return;
        }
        for (const converted of convertNativeClaudeStreamEvent(event, state)) {
            if (converted === '[DONE]') {
                if (!state.sentDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                state.sentDone = true;
            } else {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(converted)}\n\n`));
            }
        }
    }

    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/event-stream; charset=utf-8');
    headers.delete('content-length');
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}

async function convertNativeClaudeResponse(response, streamRequested) {
    if (!response.ok) return response;
    const contentType = String(response.headers.get('content-type') || '');
    if (streamRequested && contentType.includes('application/json')) {
        try {
            const data = await response.clone().json();
            const converted = convertNativeClaudeJson(data);
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.set('content-type', 'text/event-stream; charset=utf-8');
            const payload = `data: ${JSON.stringify(converted)}\n\ndata: [DONE]\n\n`;
            return new Response(payload, { status: response.status, statusText: response.statusText, headers });
        } catch {
            return response;
        }
    }
    // SillyTavern's streaming proxy does not consistently preserve the
    // upstream content-type, so the original request flag is authoritative.
    if (streamRequested) return convertNativeClaudeSseResponse(response);

    let data;
    try {
        data = await response.clone().json();
    } catch {
        return response;
    }
    const converted = convertNativeClaudeJson(data);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(converted), { status: response.status, statusText: response.statusText, headers });
}

function fetchRequestMatchesPath(input, expectedPath) {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    if (typeof rawUrl !== 'string') return false;
    try {
        return new URL(rawUrl, location.href).pathname === expectedPath;
    } catch {
        return false;
    }
}

function isNativeClaudeTunnelRequest(body) {
    if (!isClaudeCustomRequest(body)) return false;
    try {
        if (!new URL(String(body?.custom_url || '')).pathname.endsWith('/messages')) return false;
    } catch {
        return false;
    }
    try {
        const native = JSON.parse(body.custom_include_body || '');
        return native?.model === body.model && Array.isArray(native?.messages) && Array.isArray(native?.system);
    } catch {
        return false;
    }
}

function shouldDeferStandardGenerateToBaiBaoKu(role) {
    if (role === FETCH_PATCH_ROLE_BAIBAOKU_DOWNSTREAM) return false;
    const state = window[BAIBAOKU_SAVE_GENERATE_FETCH_STATE_KEY];
    return !!state?.wrappedFetch && !!state?.originalFetch?.[FETCH_PATCH_META_KEY];
}

function createFetchPatch(originalFetch, role = FETCH_PATCH_ROLE_GLOBAL) {
    const patchMeta = { role };
    async function patchedFetch(input, init = {}) {
        let nativeClaudeTransport = null;
        try {
            const isGenerate = fetchRequestMatchesPath(input, CHAT_COMPLETIONS_GENERATE_PATH);
            const isBaiBaoKuSaveGenerate = fetchRequestMatchesPath(input, BAIBAOKU_SAVE_GENERATE_PATH);
            if (isGenerate && shouldDeferStandardGenerateToBaiBaoKu(patchMeta.role)) {
                return originalFetch.call(window, input, init);
            }
            if ((isGenerate || isBaiBaoKuSaveGenerate) && init?.body && typeof init.body === 'string') {
                const envelope = JSON.parse(init.body);
                const body = isBaiBaoKuSaveGenerate ? envelope?.generate : envelope;
                const streamRequested = !!body?.stream;

                // BaiBai Tools can wrap the normal generate request in a
                // save-generate envelope before this fetch patch sees it. Its
                // server-side stream collector expects OpenAI-compatible SSE,
                // while the 1h tunnel deliberately returns Anthropic-native
                // SSE. Buffer this compatibility route as native JSON so
                // BaiBai can persist the assistant message, then convert that
                // JSON back to the streaming shape requested by SillyTavern.
                const bufferBaiBaoKuNativeResponse = isBaiBaoKuSaveGenerate
                    && streamRequested
                    && settings().claudeOneHourCache
                    && isClaudeCustomRequest(body)
                    && canUseNativeClaudeTransport(body);
                if (bufferBaiBaoKuNativeResponse) body.stream = false;

                if (!isNativeClaudeTunnelRequest(body) && shouldTouchBody(body)) {
                    const changed = applyOptimization(body);
                    if (changed) {
                        if (changed.claudeOneHourCache?.transport === 'anthropic-native') {
                            nativeClaudeTransport = {
                                streamRequested,
                                route: isBaiBaoKuSaveGenerate ? 'baibaoku-save-generate' : 'standard-generate',
                                buffered: bufferBaiBaoKuNativeResponse,
                            };
                        } else if (bufferBaiBaoKuNativeResponse) {
                            body.stream = streamRequested;
                        }
                        init = { ...init, body: JSON.stringify(body) };
                        if (isBaiBaoKuSaveGenerate) {
                            envelope.generate = body;
                            init = { ...init, body: JSON.stringify(envelope) };
                        }
                        if (settings().log) console.info('[ST Cache Helper] optimized request', {
                            ...changed,
                            route: nativeClaudeTransport?.route || (isBaiBaoKuSaveGenerate ? 'baibaoku-save-generate' : 'standard-generate'),
                            bufferedNativeResponse: nativeClaudeTransport?.buffered === true,
                        });
                    } else if (settings().log) {
                        if (bufferBaiBaoKuNativeResponse) body.stream = streamRequested;
                        console.debug('[ST Cache Helper] no optimization', { post: body.custom_prompt_post_processing || '', ...summarizeMessages(body.messages) });
                    }
                } else if (bufferBaiBaoKuNativeResponse) {
                    body.stream = streamRequested;
                }
            }
        } catch (err) {
            console.warn('[ST Cache Helper] fetch patch error', err);
        }
        const response = await originalFetch.call(window, input, init);
        if (nativeClaudeTransport) {
            try {
                return await convertNativeClaudeResponse(response, nativeClaudeTransport.streamRequested);
            } catch (err) {
                console.warn('[ST Cache Helper] native Claude response conversion error', err);
            }
        }
        return response;
    }

    Object.defineProperty(patchedFetch, FETCH_PATCH_META_KEY, {
        configurable: true,
        value: patchMeta,
    });
    return patchedFetch;
}

function patchBaiBaoKuDownstreamFetch() {
    const state = window[BAIBAOKU_SAVE_GENERATE_FETCH_STATE_KEY];
    if (!state || typeof state.originalFetch !== 'function') return false;

    const existingMeta = state.originalFetch[FETCH_PATCH_META_KEY];
    if (existingMeta) {
        const changed = existingMeta.role !== FETCH_PATCH_ROLE_BAIBAOKU_DOWNSTREAM;
        existingMeta.role = FETCH_PATCH_ROLE_BAIBAOKU_DOWNSTREAM;
        return changed;
    }

    state.originalFetch = createFetchPatch(state.originalFetch, FETCH_PATCH_ROLE_BAIBAOKU_DOWNSTREAM);
    return true;
}

function ensureFetchPatch(reason = 'manual') {
    const baiBaoKuPatched = patchBaiBaoKuDownstreamFetch();
    let globalPatched = false;
    // The manifest loads this hook immediately after Request Monitor and before
    // ordinary extensions. Later wrappers retain this function as their
    // downstream fetch, so it observes their final request body. Re-wrapping the
    // current window.fetch here would move us back outside those extensions and
    // let them invalidate the optimized request after we processed it.
    if (!window.__stCacheHelperFetchPatched) {
        window.fetch = createFetchPatch(window.fetch, FETCH_PATCH_ROLE_GLOBAL);
        globalPatched = true;
        window.__stCacheHelperFetchPatched = true;
    }
    if (settings().log && (globalPatched || baiBaoKuPatched)) {
        console.debug('[ST Cache Helper] fetch patch ensured', { reason, globalPatched, baiBaoKuPatched });
    }
}

function installFetchPatch() {
    ensureFetchPatch('init');

    for (const eventName of [
        event_types.EXTENSIONS_FIRST_LOAD,
        event_types.EXTENSION_SETTINGS_LOADED,
        event_types.APP_READY,
        event_types.CHAT_COMPLETION_SETTINGS_READY,
    ]) {
        if (eventName) eventSource.on(eventName, () => ensureFetchPatch(eventName));
    }

    // Revisit exposed downstream hooks installed asynchronously. The global
    // hook itself remains at the bottom of the fetch chain.
    for (const delay of [1_000, 3_000, 10_000, 30_000, 60_000]) {
        setTimeout(() => ensureFetchPatch(`delayed-${delay}`), delay);
    }
}

function addPanel() {
    if ($('#st_cache_helper_panel').length) return;

    const s = settings();
    const html = `
    <div id="st_cache_helper_panel">
      <b>ST Cache Helper</b>
      <div class="stch-muted">缓存修复插件。原生 1h 模式下会在最终 Claude 请求出口建立追加式 system、对话与动态上下文日志。</div>
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
      <label class="stch-row"><input id="stch_claude_1h_cache" type="checkbox"> Claude 原生 1 小时缓存（Claude Code 方式）</label>
      <label class="stch-row"><input id="stch_claude_opus_compat" type="checkbox"> Opus 1h Claude Code 兼容前缀（带人格中和）</label>
      <label class="stch-row"><input id="stch_dynamic_lore_cache" type="checkbox"> 重建临时 user／选择性世界书缓存前缀</label>
      <label class="stch-row"><input id="stch_universal_incremental" type="checkbox"> 全局最终请求增量日志（system／对话／动态注入）</label>
      <div class="stch-muted">仅处理自定义 OpenAI 中模型名含 Claude 的请求。启用后通过同一地址的 <code>/v1/messages</code> 原生协议发送，在稳定 system 前缀和最新 user 消息放置 <code>ttl=1h</code> 断点，并自动转换普通/流式响应。部分 Opus 运营商需要标准 Claude Code 前缀才接受 1h；兼容前缀后会立即加入中和说明，后续酒馆角色设定仍为权威人格。</div>
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
    $('#stch_claude_opus_compat').prop('checked', !!s.claudeCodeOpusCompatPrefix).on('change', function () {
        settings().claudeCodeOpusCompatPrefix = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_dynamic_lore_cache').prop('checked', !!s.stabilizeDynamicLoreCache).on('change', function () {
        settings().stabilizeDynamicLoreCache = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#stch_universal_incremental').prop('checked', !!s.universalIncrementalCache).on('change', function () {
        settings().universalIncrementalCache = !!$(this).prop('checked');
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
        clearNativeUserCacheSnapshots() {
            nativeUserCacheSnapshotMemory = {};
            nativeUserCacheSnapshotMemoryLoaded = true;
            universalSystemJournalMemory = {};
            universalSystemJournalMemoryLoaded = true;
            universalConversationJournalMemory = {};
            universalConversationJournalMemoryLoaded = true;
            try {
                if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.removeItem(NATIVE_USER_CACHE_SNAPSHOTS_KEY);
                    sessionStorage.removeItem(LEGACY_NATIVE_USER_CACHE_SNAPSHOTS_KEY);
                    sessionStorage.removeItem(UNIVERSAL_SYSTEM_JOURNAL_KEY);
                    sessionStorage.removeItem(UNIVERSAL_CONVERSATION_JOURNAL_KEY);
                }
            } catch { /* noop */ }
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
