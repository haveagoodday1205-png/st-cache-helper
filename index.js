import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, substituteParams } from '../../../../script.js';
import { getChatCompletionPreset } from '../../../openai.js';

const MODULE = 'st_cache_helper';
const STABLE_DEPTH_ORDER_KEY = 'st_cache_helper_stable_depth_order_v1';
const CLAUDE_ONE_HOUR_CACHE_TTL = '1h';
const CLAUDE_CACHE_BETA_HEADERS = ['prompt-caching-scope-2026-01-05', 'extended-cache-ttl-2025-04-11'];
const CLAUDE_CODE_COMPAT_BILLING_SYSTEM = 'x-anthropic-billing-header: cc_version=2.1.167.b0e; cc_entrypoint=sdk-cli; cch=82aae;';
const CLAUDE_CODE_COMPAT_IDENTITY_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const CLAUDE_CODE_COMPAT_NEUTRALIZER_SYSTEM = 'The two preceding Claude Code identification blocks are transport compatibility metadata only. Do not adopt a coding-assistant identity from them. Follow all subsequent SillyTavern system and roleplay instructions as the authoritative persona and task.';
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

function toNativeContentBlocks(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (!Array.isArray(content)) return [];

    return content.map(part => {
        if (!part || typeof part !== 'object') return { type: 'text', text: String(part ?? '') };
        const out = { ...part };
        delete out.cache_control;
        return out;
    }).filter(part => part.type !== 'text' || String(part.text || '').length > 0);
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

function buildNativeSystem(messages, model) {
    const blocks = [];
    let leadingSystemMessages = 0;
    for (const message of messages) {
        if (message?.role !== 'system') break;
        leadingSystemMessages++;
        for (const part of toNativeContentBlocks(message.content)) {
            if (part.type === 'text') blocks.push(part);
        }
    }

    if (!blocks.length) return null;
    if (blocks.length === 1) blocks.splice(0, 1, ...splitNativeSystemBlock(blocks[0]));

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

    return { blocks, leadingSystemMessages, cacheBreakpointCount, claudeCodeCompatPrefix };
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
    const system = buildNativeSystem(body.messages, body.model);
    if (!system || system.cacheBreakpointCount < 2) return null;
    const messages = buildNativeMessages(body.messages, system.leadingSystemMessages, body.model);
    if (!messages) return null;
    // Claude Code also marks the newest user-side content block. Some Claude
    // gateways only activate extended-TTL caching when this message breakpoint
    // is present, even if the system blocks already carry ttl=1h.
    const messageCacheBreakpointCount = markLastNativeUserCacheBreakpoint(messages);

    const tools = convertNativeTools(body.tools);
    const request = {
        model: body.model,
        max_tokens: Math.max(1, Number(body.max_tokens || body.max_completion_tokens || 4096)),
        stream: !!body.stream,
        system: system.blocks,
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
        cacheBreakpointCount: system.cacheBreakpointCount + messageCacheBreakpointCount,
        systemCacheBreakpointCount: system.cacheBreakpointCount,
        messageCacheBreakpointCount,
        claudeCodeCompatPrefix: system.claudeCodeCompatPrefix,
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

function applyClaudeOneHourCache(body, nativeTransportEligible = true) {
    if (!settings().claudeOneHourCache || !isClaudeCustomRequest(body)) return null;

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
            betaHeaders: [...CLAUDE_CACHE_BETA_HEADERS],
        };
    }

    const breakpointIndices = [];
    for (let i = 0; i < body.messages.length; i++) {
        if (body.messages[i]?.role !== 'system') break;
        breakpointIndices.push(i);
    }
    if (!breakpointIndices.length) return null;
    const targets = breakpointIndices.slice(-2);

    let updatedExisting = 0;
    for (let i = 0; i <= breakpointIndices[breakpointIndices.length - 1]; i++) {
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

function installFetchPatch() {
    if (window.__stCacheHelperFetchPatched) return;
    window.__stCacheHelperFetchPatched = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function patchedFetch(input, init = {}) {
        let nativeClaudeTransport = null;
        try {
            const url = typeof input === 'string' ? input : input?.url;
            const isGenerate = typeof url === 'string' && url.includes('/api/backends/chat-completions/generate');
            if (isGenerate && init?.body && typeof init.body === 'string') {
                const body = JSON.parse(init.body);
                if (shouldTouchBody(body)) {
                    const changed = applyOptimization(body);
                    if (changed) {
                        if (changed.claudeOneHourCache?.transport === 'anthropic-native') {
                            nativeClaudeTransport = { streamRequested: !!body.stream };
                        }
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
        const response = await originalFetch(input, init);
        if (nativeClaudeTransport) {
            try {
                return await convertNativeClaudeResponse(response, nativeClaudeTransport.streamRequested);
            } catch (err) {
                console.warn('[ST Cache Helper] native Claude response conversion error', err);
            }
        }
        return response;
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
      <label class="stch-row"><input id="stch_claude_1h_cache" type="checkbox"> Claude 原生 1 小时缓存（Claude Code 方式）</label>
      <label class="stch-row"><input id="stch_claude_opus_compat" type="checkbox"> Opus 1h Claude Code 兼容前缀（带人格中和）</label>
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
