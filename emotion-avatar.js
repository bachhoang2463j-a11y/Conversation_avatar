/**
 * 情绪头像 EmotionAvatar — SillyTavern 酒馆助手脚本
 *
 * AI 在角色对话的自然段前输出 {角色名(情绪)} 标签，本脚本在显示层把标签替换为行内头像：
 * - 不修改消息原文（chat[i].mes 永不触碰），卸载脚本即回到原始文本
 * - 提示词经 injectPrompts 以 system / in_chat / depth 0 注入（MiniMapStatus 早期同款通道）
 * - 情绪词恒定十个：默认、微笑、愤怒、悲伤、惊讶、轻蔑、杀意、思考、大笑、害羞
 * - 支持一张表情合集大图按网格切分批量导入
 */
(function () {
    'use strict';

    // ============================================
    // 常量定义
    // ============================================
    const SCRIPT_NAME = '情绪头像';
    const VERSION = '0.1.0';
    const DB_NAME = 'EmotionAvatarDB';
    const DB_VERSION = 1;
    const STORE_AVATARS = 'avatars';
    const INJECT_ID = 'emoavatar-prompt';
    const LS_CHARACTERS = 'emoavatar_characters';
    const LS_SETTINGS = 'emoavatar_settings';
    /** 情绪词恒定十个；顺序即批量导入网格的默认映射顺序 */
    const EMOTIONS = ['默认', '微笑', '愤怒', '悲伤', '惊讶', '轻蔑', '杀意', '思考', '大笑', '害羞'];
    const EMOTION_SET = new Set(EMOTIONS);
    /** 标签匹配：{角色名(情绪)}；角色名 1-30 字（不含花括号/圆括号），情绪 1-8 字 */
    const TAG_RE = /\{([^{}()]{1,30})\(([^{}()]{1,8})\)\}/g;
    /** 头像显示高度默认值（em），面板可调 */
    const DEFAULT_SIZE = 2.5;

    // ============================================
    // 运行环境（酒馆助手脚本运行在 iframe 内，DOM/样式走顶层窗口）
    // ============================================
    const topWindow = typeof window.parent !== 'undefined' ? window.parent : window;
    const doc = topWindow.document;
    const Env = {
        events: (typeof tavern_events !== 'undefined') ? tavern_events : (topWindow.tavern_events || {}),
        on(event, fn) {
            if (typeof eventOn === 'function') { eventOn(event, fn); return; }
            if (topWindow.eventOn) topWindow.eventOn(event, fn);
        },
        inject(prompts) {
            if (typeof injectPrompts === 'function') return injectPrompts(prompts);
            if (topWindow.TavernHelper && typeof topWindow.TavernHelper.injectPrompts === 'function') {
                return topWindow.TavernHelper.injectPrompts(prompts);
            }
            return null;
        },
    };

    // ============================================
    // 设置与角色登记表（localStorage）
    // ============================================
    let settings = { enabled: true, size: DEFAULT_SIZE };
    /** 已登记角色名列表（角色名即主键，全局跨卡跨聊天） */
    let characters = [];

    function loadState() {
        try { characters = JSON.parse(topWindow.localStorage.getItem(LS_CHARACTERS)) || []; } catch (e) { characters = []; }
        try {
            const s = JSON.parse(topWindow.localStorage.getItem(LS_SETTINGS));
            if (s && typeof s === 'object') Object.assign(settings, s);
        } catch (e) { /* 保持默认 */ }
    }
    function persistCharacters() {
        try { topWindow.localStorage.setItem(LS_CHARACTERS, JSON.stringify(characters)); } catch (e) { /* 存储失败不阻塞 */ }
    }
    function persistSettings() {
        try { topWindow.localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* 存储失败不阻塞 */ }
    }

    // ============================================
    // 样式注入
    // ============================================
    const CSS_TEXT = ''
        + '.eca-avatar{display:inline-block;height:var(--eca-size,2.5em);width:auto;'
        + 'max-width:calc(var(--eca-size,2.5em)*1.6);object-fit:cover;vertical-align:text-bottom;'
        + 'margin:0 .18em;border-radius:.32em;}'
        // 占位符不可在自身上改 font-size：height 的 em 会按放大后的字号解析，导致尺寸超标
        + '.eca-avatar.eca-placeholder{width:var(--eca-size,2.5em);height:var(--eca-size,2.5em);'
        + 'max-width:none;box-sizing:border-box;display:inline-flex;align-items:center;'
        + 'justify-content:center;background:rgba(128,128,128,.28);'
        + 'color:rgba(190,190,190,.75);border:1px solid rgba(128,128,128,.35);border-radius:50%;'
        + 'user-select:none;overflow:hidden;}'
        + '.eca-avatar.eca-placeholder::after{content:"?";'
        + 'font-size:calc(var(--eca-size,2.5em)*.5);}';

    function injectStyles() {
        if (doc.getElementById('eca-styles')) return;
        const style = doc.createElement('style');
        style.id = 'eca-styles';
        style.textContent = CSS_TEXT;
        doc.head.appendChild(style);
    }

    /** 头像尺寸即时生效：只改 CSS 变量，已渲染楼层无需重扫 */
    function applySizeVar() {
        let el = doc.getElementById('eca-size-style');
        if (!el) {
            el = doc.createElement('style');
            el.id = 'eca-size-style';
            doc.head.appendChild(el);
        }
        const size = Number(settings.size);
        el.textContent = ':root{--eca-size:' + (Number.isFinite(size) && size > 0 ? size : DEFAULT_SIZE) + 'em}';
    }

    // ============================================
    // 渲染替换（M1）：显示层最小侵入，只动命中文本节点
    // ============================================
    /** 内存头像缓存：`角色名_情绪` → 图片 src（M1 由调试桥填充，M3 起由 IndexedDB 预热） */
    const avatarCache = new Map();

    function isRegistered(name) { return characters.indexOf(name) !== -1; }

    /**
     * 三级容错解析，返回可用于 <img> 的 src，null 表示渲染占位头像：
     * 未注册 → null；无效情绪/缺图 → 回落该角色"默认"图；默认也缺 → null
     */
    function resolveTag(name, emotion) {
        if (!isRegistered(name)) return null;
        if (!EMOTION_SET.has(emotion)) emotion = '默认';
        let src = avatarCache.get(name + '_' + emotion);
        if (!src && emotion !== '默认') src = avatarCache.get(name + '_默认');
        return src || null;
    }

    function buildAvatarEl(name, emotion, src) {
        if (src) {
            const img = doc.createElement('img');
            img.className = 'eca-avatar';
            img.src = src;
            img.alt = name + '·' + emotion;
            img.title = name + '（' + emotion + '）';
            img.dataset.ecaName = name;
            img.dataset.ecaEmotion = emotion;
            return img;
        }
        const span = doc.createElement('span');
        span.className = 'eca-avatar eca-placeholder';
        span.title = name + (isRegistered(name) ? '（已登记，缺图）' : '（未登记角色）');
        span.dataset.ecaName = name;
        span.dataset.ecaEmotion = emotion;
        return span;
    }

    /** 替换单个文本节点中的全部完整标签；只切分命中片段，其余文本原样保留 */
    function processTextNode(node) {
        const text = node.nodeValue;
        if (!text || text.indexOf('{') === -1) return;
        TAG_RE.lastIndex = 0;
        let match;
        let frag = null;
        let lastIdx = 0;
        while ((match = TAG_RE.exec(text)) !== null) {
            const name = match[1].trim();
            const emotion = match[2].trim();
            if (!name || !emotion) continue; // 畸形标签保留为文本
            if (frag === null) frag = doc.createDocumentFragment();
            frag.appendChild(doc.createTextNode(text.slice(lastIdx, match.index)));
            frag.appendChild(buildAvatarEl(name, emotion, resolveTag(name, emotion)));
            lastIdx = match.index + match[0].length;
        }
        if (frag === null) return;
        frag.appendChild(doc.createTextNode(text.slice(lastIdx)));
        node.parentNode.replaceChild(frag, node);
    }

    /** 遍历一个 .mes_text 的文本节点（跳过 pre/code），先收集后替换，避免遍历中突变 */
    function processMesText(root) {
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent || parent.closest('pre, code')) return NodeFilter.FILTER_REJECT;
                return node.nodeValue.indexOf('{') === -1 ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
            },
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (let i = 0; i < nodes.length; i++) processTextNode(nodes[i]);
    }

    /** 幂等全扫：已替换的标签不在文本节点里，重扫无副作用 */
    function scanAll() {
        const list = doc.querySelectorAll('.mes_text');
        for (let i = 0; i < list.length; i++) processMesText(list[i]);
    }

    let scanTimer = null;
    /** 事件触发的重扫，去抖合并（事件可能先于 DOM 更新完成，留一拍再扫） */
    function scheduleScan() {
        if (scanTimer !== null) return;
        scanTimer = setTimeout(function () {
            scanTimer = null;
            hookStreamObserver();
            scanAll();
        }, 50);
    }

    /** 流式兜底：#chat MutationObserver 节流扫描（自身替换触发的 mutation 幂等无害） */
    let streamObserver = null;
    let streamTimer = null;
    function hookStreamObserver() {
        if (streamObserver) return;
        const chatEl = doc.getElementById('chat');
        if (!chatEl) return; // #chat 未就绪时由下次 scheduleScan 重试
        streamObserver = new MutationObserver(function () {
            if (streamTimer !== null) return;
            streamTimer = setTimeout(function () {
                streamTimer = null;
                scanAll();
            }, 250);
        });
        streamObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });
    }

    function hookEvents() {
        [
            'APP_READY',
            'CHARACTER_MESSAGE_RENDERED',
            'USER_MESSAGE_RENDERED',
            'MESSAGE_EDITED',
            'MESSAGE_SWIPED',
            'MESSAGE_RECEIVED',
            'MORE_MESSAGES_LOADED',
        ].forEach(function (key) {
            const ev = Env.events[key];
            if (ev) Env.on(ev, scheduleScan);
        });
        // CHAT_CHANGED：注入只对当前聊天有效，切聊天必须重注；同时全扫恢复渲染
        const chatChanged = Env.events.CHAT_CHANGED;
        if (chatChanged) {
            Env.on(chatChanged, function () {
                applyInjection();
                scheduleScan();
            });
        }
        hookStreamObserver();
    }

    // ============================================
    // 提示词注入（M2）：MiniMapStatus 早期同款通道
    // system / in_chat / depth 0（上下文最末尾，紧贴最新消息）
    // ============================================
    let uninjectHandle = null;

    function buildPrompt() {
        if (!characters.length) return null;
        const list = characters.join('、');
        // 示例取第一个登记角色，与其同名的对话片段对齐
        const hero = characters[0];
        const example = '{' + hero + '(大笑)}“看不见的敌人？”' + hero
            + '咧嘴一笑，那笑容里带着一股嗜血的狠劲，“那最好不过了。看不见的东西，通常也躲不开这种口径的子弹。”';
        return '<头像标记>\n'
            + '若' + list + '说话，请在对应自然段前加入标记`{名称(情绪)}`。\n'
            + '情绪词限定十个：' + EMOTIONS.join('、') + '\n'
            + '无法确定时，优先使用默认。\n'
            + '例：\n'
            + example + '\n'
            + '</头像标记>';
    }

    /** 注入只对当前聊天有效：切聊天（CHAT_CHANGED）与登记变更时都必须重注 */
    function applyInjection() {
        if (uninjectHandle) {
            try { uninjectHandle.uninject(); } catch (e) { /* 句柄可能已随脚本卸载失效 */ }
            uninjectHandle = null;
        }
        if (!settings.enabled || !characters.length) return;
        const content = buildPrompt();
        if (!content) return;
        try {
            uninjectHandle = Env.inject([{
                id: INJECT_ID,
                position: 'in_chat',
                depth: 0,
                role: 'system',
                content: content,
            }]);
        } catch (e) {
            console.warn('[' + SCRIPT_NAME + '] 提示词注入失败:', e);
        }
    }

    /** 总开关：关闭即撤销注入 */
    function setEnabled(enabled) {
        settings.enabled = !!enabled;
        persistSettings();
        applyInjection();
    }

    /** 头像显示大小（em），1.5–5，即时生效（只改 CSS 变量） */
    function setSize(size) {
        const n = Number(size);
        if (Number.isFinite(n) && n >= 1.5 && n <= 5) {
            settings.size = n;
            persistSettings();
            applySizeVar();
        }
    }

    // ============================================
    // IndexedDB 存储层（M3）
    // ============================================

    // ============================================
    // 管理面板（M4）
    // ============================================

    // ============================================
    // 单图批量网格导入（M5）
    // ============================================

    // ============================================
    // 调试 / 测试桥（控制台排查与 harness 种子用）
    // ============================================
    topWindow.EmoAvatar = {
        version: VERSION,
        emotions: EMOTIONS.slice(),
        /** 调试/harness 桥：直接向内存缓存塞头像（不落库） */
        seedAvatar(name, emotion, src) { avatarCache.set(name + '_' + emotion, src); },
        /** 调试/harness 桥：整体替换登记名单（不落 localStorage，但会同步重注提示词） */
        setCharacters(list) { characters = list.slice(); applyInjection(); },
        getCharacters() { return characters.slice(); },
        setEnabled: setEnabled,
        setSize: setSize,
        scanAll: scanAll,
        applyInjection: applyInjection,
    };

    // ============================================
    // 入口
    // ============================================
    function init() {
        loadState();
        injectStyles();
        applySizeVar();
        hookEvents();
        applyInjection();
        scanAll();
    }
    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
