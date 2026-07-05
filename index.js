import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'st_cache_helper';
const DEFAULTS = Object.freeze({
    enabled: true,
    mode: 'strict_to_merge',
    log: true,
    onlyCustomOpenAI: true,
});

function settings() {
    extension_settings[MODULE] ??= structuredClone(DEFAULTS);
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[MODULE][k] === undefined) extension_settings[MODULE][k] = v;
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

function rewritePostProcessing(body) {
    const s = settings();
    const before = body.custom_prompt_post_processing || '';
    let after = before;

    if (s.mode === 'off') return null;

    if (s.mode === 'strict_to_merge') {
        if (before === 'strict') after = 'merge';
        if (before === 'strict_tools') after = 'merge_tools';
    } else if (s.mode === 'strict_to_semi') {
        if (before === 'strict') after = 'semi';
        if (before === 'strict_tools') after = 'semi_tools';
    } else if (s.mode === 'strict_to_none') {
        if (before === 'strict' || before === 'strict_tools') after = '';
    }

    if (after !== before) {
        body.custom_prompt_post_processing = after;
        return { before, after };
    }
    return null;
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
    const system = messages.filter(x => x?.role === 'system').map(x => String(x.content ?? '')).join('\n\n');
    return {
        count: messages.length,
        roles: messages.map(x => x?.role).join(','),
        systemLen: system.length,
        systemHash: hashText(system),
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
                    const beforeSummary = summarizeMessages(body.messages);
                    const changed = rewritePostProcessing(body);
                    if (changed) {
                        init = { ...init, body: JSON.stringify(body) };
                        if (settings().log) {
                            console.info('[ST Cache Helper] post-processing rewritten', changed, beforeSummary);
                        }
                    } else if (settings().log) {
                        console.debug('[ST Cache Helper] no rewrite', { post: body.custom_prompt_post_processing || '', ...beforeSummary });
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
      <div class="stch-muted">用于改善 <code>提示词后处理=严格</code> 导致的 Claude 缓存不命中。默认把 Strict 请求在发送前改成 Merge。</div>
      <label class="stch-row"><input id="stch_enabled" type="checkbox"> 启用请求修复</label>
      <div class="stch-row">
        <span>策略</span>
        <select id="stch_mode">
          <option value="strict_to_merge">Strict → Merge（推荐）</option>
          <option value="strict_to_semi">Strict → Semi</option>
          <option value="strict_to_none">Strict → None</option>
          <option value="off">不改写</option>
        </select>
      </div>
      <label class="stch-row"><input id="stch_only_custom" type="checkbox"> 仅作用于自定义 OpenAI 源</label>
      <label class="stch-row"><input id="stch_log" type="checkbox"> 控制台输出调试日志</label>
      <div class="stch-muted">注意：这是前端请求级修复，不修改 ST 后端源码和 NewAPI。</div>
    </div>`;

    const target = $('#openai_settings, #extensions_settings, #completion_prompt_manager_popup_entry_form').first();
    if (target.length) {
        target.prepend(html);
    } else {
        $('#extensions_settings').append(html);
    }

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
}

function exposeDebug() {
    window.stCacheHelper = {
        settings,
        testRewrite(body) {
            const clone = structuredClone(body);
            const changed = shouldTouchBody(clone) ? rewritePostProcessing(clone) : null;
            return { changed, body: clone };
        },
    };
}

export function init() {
    settings();
    installFetchPatch();
    exposeDebug();
    addPanel();
    // Settings panels are sometimes rendered later / switched by tabs.
    setTimeout(addPanel, 1000);
    setTimeout(addPanel, 3000);
    console.info('[ST Cache Helper] loaded', settings());
}
