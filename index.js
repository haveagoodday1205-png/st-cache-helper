import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, substituteParams } from '../../../../script.js';
import { getChatCompletionPreset } from '../../../openai.js';

const MODULE = 'st_cache_helper';
const DEFAULTS = Object.freeze({
    enabled: true,
    // Respect the UI choice, emulate the selected post-processing locally,
    // then apply cache-safe fixes before ST backend sees it.
    mode: 'stable_prefix_cache',
    log: true,
    onlyCustomOpenAI: true,
    stampRequests: true,
    recoverStrandedSystemPrompts: true,
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
    out.role = 'system';
    delete out.name;
    delete out.tool_calls;
    delete out.tool_call_id;
    return out;
}

function stablePrefixCacheFix(body) {
    const beforePost = body.custom_prompt_post_processing || '';
    const originalSummary = summarizeMessages(body.messages);
    const promptDefs = getEnabledPresetPromptDefinitions();
    const recovered = recoverMissingSystemPromptMessages(body, promptDefs);
    const prompts = [];
    const conversation = [];

    for (const raw of body.messages) {
        const msg = cloneMessage(raw);
        if (msg.role === 'system') {
            prompts.push(asSystemPrompt(msg));
        } else if (isStaticAssistantPrompt(msg)) {
            prompts.push(asSystemPrompt(msg));
        } else if (isPresetPromptMessage(msg, promptDefs)) {
            prompts.push(asSystemPrompt(msg));
        } else {
            conversation.push(msg);
        }
    }

    if (!prompts.length && !recovered.length) return null;

    body.messages = [...recovered.map(asSystemPrompt), ...prompts, ...conversation];

    // This mode deliberately bypasses ST backend prompt post-processing.
    // We are preserving the content, but moving static prompt blocks into a stable
    // prefix. If ST processes it again, it may reintroduce sliding depth blocks.
    body.custom_prompt_post_processing = '';

    if (settings().stampRequests) {
        body.custom_include_headers = appendYamlLine(body.custom_include_headers, 'X-ST-Cache-Helper', 'stable-prefix-cache-v1');
    }

    return {
        mode: 'stable_prefix_cache',
        selectedPostProcessing: beforePost || 'none',
        sentPostProcessing: 'none-stable-prefix',
        recoveredStrandedSystemBlocks: recovered.length,
        promotedSystemBlocks: prompts.length + recovered.length,
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

function applyOptimization(body) {
    const s = settings();
    if (s.mode === 'stable_prefix_cache') return stablePrefixCacheFix(body);
    if (s.mode === 'respect_choice_cache') return optimizeAfterSelection(body);
    return legacyRewritePostProcessing(body);
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
}

function exposeDebug() {
    window.stCacheHelper = {
        settings,
        testOptimize(body) {
            const clone = structuredClone(body);
            const changed = shouldTouchBody(clone) ? applyOptimization(clone) : null;
            return { changed, body: clone };
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
