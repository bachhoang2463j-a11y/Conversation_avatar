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
    // groups: [{id, name, enabled, members:[角色名]}]；characters 为拍平索引（isRegistered 等零改动）
    // 组开关只控制提示词注入（角色卡切换用），不影响已渲染头像与素材库
    // ============================================
    let settings = { enabled: true, size: DEFAULT_SIZE, batchCropRatio: '1:1' };
    let characters = [];
    let groups = [];
    let groupSeq = 1;
    const LS_GROUPS = 'emoavatar_groups';

    function makeGroupId() { return 'g' + Date.now().toString(36) + (groupSeq++); }

    /** 由 groups 重建拍平索引（任何组结构变更后调用） */
    function rebuildCharacterIndex() {
        characters = [];
        groups.forEach(function (g) {
            Array.prototype.push.apply(characters, g.members);
        });
    }

    function findGroupByChar(name) {
        for (let i = 0; i < groups.length; i++) {
            if (groups[i].members.indexOf(name) !== -1) return groups[i];
        }
        return null;
    }

    function loadState() {
        try {
            const stored = JSON.parse(topWindow.localStorage.getItem(LS_GROUPS));
            if (Array.isArray(stored) && stored.length) {
                groups = stored.filter(function (g) {
                    return g && typeof g.name === 'string' && Array.isArray(g.members);
                }).map(function (g) {
                    return { id: g.id || makeGroupId(), name: g.name, enabled: g.enabled !== false, members: g.members.slice() };
                });
            }
        } catch (e) { /* 保持空 */ }
        // 迁移：旧版扁平角色表 → 单一默认组
        try {
            const legacy = JSON.parse(topWindow.localStorage.getItem(LS_CHARACTERS));
            if (!groups.length && Array.isArray(legacy) && legacy.length) {
                groups = [{ id: makeGroupId(), name: '默认组', enabled: true, members: legacy.slice() }];
            }
        } catch (e) { /* 无旧数据 */ }
        if (!groups.length) {
            groups = [{ id: makeGroupId(), name: '默认组', enabled: true, members: [] }];
        }
        rebuildCharacterIndex();
        try {
            const s = JSON.parse(topWindow.localStorage.getItem(LS_SETTINGS));
            if (s && typeof s === 'object') Object.assign(settings, s);
        } catch (e) { /* 保持默认 */ }
    }

    function persistCharacters() {
        try {
            topWindow.localStorage.setItem(LS_GROUPS, JSON.stringify(groups));
            // 兼容旧字段同步写一份扁平表（回滚旧版脚本不丢人）
            topWindow.localStorage.setItem(LS_CHARACTERS, JSON.stringify(characters));
        } catch (e) { /* 存储失败不阻塞 */ }
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
        + 'font-size:calc(var(--eca-size,2.5em)*.5);}'
        // 段首头像两列布局。p 段落由 wrapLeadingAvatarParagraphs 把头像后的全部
        // 内容包进单个 .eca-text，形成「头像 + 文字块」两个 flex 项的标准聊天行：
        // 文字块内部保持正常行内流（<q>/<em> 不会被拆成多个 flex 项），
        // align-items:center 让单行与多行文字都相对头像垂直居中。
        // 非 p 容器（.mes_text 直接子节点等，无 JS 包裹）保留
        // absolute + translateY 居中的兜底布局
        + '.mes_text p.eca-p{display:flex;align-items:center;gap:.3em;}'
        + '.mes_text p.eca-p > .eca-avatar:first-child{flex:0 0 auto;'
        + 'width:var(--eca-size,2.5em);max-width:none;margin:0;}'
        + '.mes_text p.eca-p > .eca-text{flex:1 1 auto;min-width:0;}'
        + '.mes_text :has(> .eca-avatar:first-child):not(p):not(.mes_text),'
        + '.mes_text:has(> .eca-avatar:first-child){position:relative;'
        + 'padding-left:calc(var(--eca-size,2.5em) + .3em);'
        + 'min-height:var(--eca-size,2.5em);}'
        + '.mes_text :has(> .eca-avatar:first-child):not(p):not(.mes_text) > .eca-avatar:first-child,'
        + '.mes_text:has(> .eca-avatar:first-child) > .eca-avatar:first-child{'
        + 'position:absolute;left:0;top:50%;transform:translateY(-50%);margin:0;'
        + 'width:var(--eca-size,2.5em);max-width:none;}';

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

    /**
     * 段首头像两列化：p 的首个子节点是头像时，把头像后的全部兄弟内容
     * （文本、<q>、<em> 等）包进单个 .eca-text，使段落成为
     * 「头像 + 文字块」两个 flex 项（配合 p.eca-p 样式），
     * 单行/多行文字都垂直居中且内部行内流不变。
     * 幂等：已处理（.eca-p）或头像后无内容则跳过
     */
    function wrapLeadingAvatarParagraphs() {
        const list = doc.querySelectorAll('.mes_text p > .eca-avatar:first-child');
        for (let i = 0; i < list.length; i++) {
            const avatar = list[i];
            const p = avatar.parentElement;
            if (!p || p.classList.contains('eca-p')) continue;
            p.classList.add('eca-p');
            const nodes = [];
            let n = avatar.nextSibling;
            while (n) { nodes.push(n); n = n.nextSibling; }
            if (!nodes.length) continue;
            const span = doc.createElement('span');
            span.className = 'eca-text';
            for (let k = 0; k < nodes.length; k++) span.appendChild(nodes[k]);
            p.appendChild(span);
        }
    }

    /** 幂等全扫：已替换的标签不在文本节点里，重扫无副作用 */
    function scanAll() {
        const list = doc.querySelectorAll('.mes_text');
        for (let i = 0; i < list.length; i++) processMesText(list[i]);
        wrapLeadingAvatarParagraphs();
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
        const appReady = Env.events.APP_READY;
        if (appReady) Env.on(appReady, function () { addMenuButton(); scheduleScan(); });
        // CHAT_CHANGED：注入只对当前聊天有效，切聊天必须重注；同时全扫恢复渲染
        const chatChanged = Env.events.CHAT_CHANGED;
        if (chatChanged) {
            Env.on(chatChanged, function () {
                applyInjection();
                addMenuButton();
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

    /** 参与提示词注入的角色：仅启用组内的成员（组开关 = 角色卡切换） */
    function getInjectionCharacters() {
        const list = [];
        groups.forEach(function (g) {
            if (g.enabled) Array.prototype.push.apply(list, g.members);
        });
        return list;
    }

    function buildPrompt() {
        const injectable = getInjectionCharacters();
        if (!injectable.length) return null;
        const list = injectable.join('、');
        // 示例取第一个注入角色，与其同名的对话片段对齐
        const hero = injectable[0];
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
        if (!settings.enabled || !getInjectionCharacters().length) return;
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
        syncPanelControls();
    }

    /** 头像显示大小（em），1.5–5，即时生效（只改 CSS 变量） */
    function setSize(size) {
        const n = Number(size);
        if (Number.isFinite(n) && n >= 1.5 && n <= 5) {
            settings.size = n;
            persistSettings();
            applySizeVar();
            syncPanelControls();
            updateSizePreview();
        }
    }

    // ============================================
    // IndexedDB 存储层（M3）：主键 `角色名_情绪`，全局角色库（不绑角色卡）
    // ============================================
    let dbPromise = null;

    function initDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = function () {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_AVATARS)) {
                    db.createObjectStore(STORE_AVATARS, { keyPath: 'id' })
                        .createIndex('character', 'character', { unique: false });
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
        return dbPromise;
    }

    function createBlobUrl(blob) {
        return (topWindow.URL || URL).createObjectURL(blob);
    }

    /** 只 revoke 自己创建的 blob: URL，dataURL（调试种子）不动 */
    function revokeCacheUrl(url) {
        if (typeof url === 'string' && url.indexOf('blob:') === 0) {
            try { (topWindow.URL || URL).revokeObjectURL(url); } catch (e) { /* 已失效 */ }
        }
    }

    function txStore(mode) {
        return initDB().then(function (db) {
            return db.transaction(STORE_AVATARS, mode).objectStore(STORE_AVATARS);
        });
    }

    /** 保存并同步更新内存缓存（覆盖时 revoke 旧 URL） */
    function saveAvatar(character, emotion, blob) {
        const id = character + '_' + emotion;
        return txStore('readwrite').then(function (store) {
            return new Promise(function (resolve, reject) {
                const request = store.put({
                    id: id,
                    character: character,
                    emotion: emotion,
                    imageBlob: blob,
                    lastModified: Date.now(),
                });
                request.onsuccess = function () {
                    revokeCacheUrl(avatarCache.get(id));
                    avatarCache.set(id, createBlobUrl(blob));
                    resolve();
                };
                request.onerror = function () { reject(request.error); };
            });
        });
    }

    function deleteAvatar(character, emotion) {
        const id = character + '_' + emotion;
        return txStore('readwrite').then(function (store) {
            return new Promise(function (resolve, reject) {
                const request = store.delete(id);
                request.onsuccess = function () {
                    revokeCacheUrl(avatarCache.get(id));
                    avatarCache.delete(id);
                    resolve();
                };
                request.onerror = function () { reject(request.error); };
            });
        });
    }

    function getAllAvatarRecords() {
        return txStore('readonly').then(function (store) {
            return new Promise(function (resolve, reject) {
                const request = store.getAll();
                request.onsuccess = function () { resolve(request.result || []); };
                request.onerror = function () { reject(request.error); };
            });
        });
    }

    /** 删除角色全部头像（角色移除时用），返回删除条数 */
    function deleteCharacterAvatars(character) {
        return txStore('readwrite').then(function (store) {
            return new Promise(function (resolve, reject) {
                const request = store.index('character').getAllKeys(character);
                request.onsuccess = function () {
                    const keys = request.result || [];
                    keys.forEach(function (key) {
                        revokeCacheUrl(avatarCache.get(key));
                        avatarCache.delete(key);
                        store.delete(key);
                    });
                    resolve(keys.length);
                };
                request.onerror = function () { reject(request.error); };
            });
        });
    }

    /** 角色改名：迁移该角色全部头像的记录与缓存键 */
    function renameCharacterAvatars(oldName, newName) {
        return getAllAvatarRecords().then(function (records) {
            const mine = records.filter(function (r) { return r.character === oldName; });
            return Promise.all(mine.map(function (r) {
                return saveAvatar(newName, r.emotion, r.imageBlob)
                    .then(function () { return deleteAvatar(oldName, r.emotion); });
            }));
        });
    }

    /** 启动预热：全量载入内存缓存，渲染替换零 await */
    function preloadAvatars() {
        return getAllAvatarRecords().then(function (records) {
            records.forEach(function (r) {
                if (!avatarCache.has(r.id)) avatarCache.set(r.id, createBlobUrl(r.imageBlob));
            });
        }).catch(function (e) {
            console.warn('[' + SCRIPT_NAME + '] 头像缓存预热失败:', e);
        });
    }

    // ============================================
    // 管理面板（M4）：魔法棒菜单入口 + 单弹窗
    // ============================================
    const PANEL_CSS = ''
        // 两个弹窗（管理面板 / 批量导入）共用的骨架样式
        + '#eca-panel,#eca-batch-panel{display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);align-items:center;justify-content:center;font-size:14px;font-family:system-ui,"Microsoft YaHei",sans-serif;}'
        + '#eca-batch-panel{z-index:100001;background:rgba(0,0,0,.5);}'
        + '#eca-panel .eca-modal,#eca-batch-panel .eca-modal{width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;background:#23262e;color:#e6e6e6;border:1px solid #3a3f4b;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);}'
        + '#eca-batch-panel .eca-modal{width:min(880px,94vw);max-height:90vh;}'
        + '#eca-panel .eca-header,#eca-batch-panel .eca-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #3a3f4b;font-weight:600;}'
        + '#eca-panel .eca-close,#eca-batch-panel .eca-close{background:none;border:0;color:#999;font-size:20px;cursor:pointer;line-height:1;padding:0 4px;}'
        + '#eca-panel .eca-close:hover,#eca-batch-panel .eca-close:hover{color:#fff;}'
        + '#eca-panel .eca-footer,#eca-batch-panel .eca-footer{display:flex;align-items:center;gap:18px;padding:10px 16px;border-top:1px solid #3a3f4b;flex-wrap:wrap;}'
        // 管理面板
        + '#eca-panel .eca-body{display:flex;min-height:320px;overflow:hidden;}'
        + '#eca-panel .eca-side{width:170px;border-right:1px solid #3a3f4b;padding:10px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;}'
        + '#eca-panel .eca-side-title{color:#8ab;font-size:12px;}'
        + '#eca-panel .eca-char-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;cursor:pointer;background:#2a2e37;}'
        + '#eca-panel .eca-char-item:hover{background:#323744;}'
        + '#eca-panel .eca-char-item.active{background:#2d5f8a;}'
        + '#eca-panel .eca-char-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
        + '#eca-panel .eca-char-del{background:none;border:0;color:#c66;cursor:pointer;font-size:12px;padding:0 2px;}'
        + '#eca-panel .eca-add{margin-top:auto;padding:6px;border-radius:6px;border:1px dashed #555;background:none;color:#9bd;cursor:pointer;}'
        // 人物组手风琴
        + '#eca-panel .eca-group{border:1px solid #333844;border-radius:6px;margin-bottom:6px;background:#262a33;overflow:hidden;}'
        + '#eca-panel .eca-group-head{display:flex;align-items:center;gap:5px;padding:5px 8px;cursor:pointer;user-select:none;}'
        + '#eca-panel .eca-group-head:hover{background:#2c313c;}'
        + '#eca-panel .eca-group-arrow{width:1em;color:#8ab;transition:transform .15s;flex:0 0 auto;text-align:center;}'
        + '#eca-panel .eca-group.collapsed .eca-group-arrow{transform:rotate(-90deg);}'
        + '#eca-panel .eca-group-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;}'
        + '#eca-panel .eca-group-count{color:#778;font-size:11px;flex:0 0 auto;}'
        + '#eca-panel .eca-group-off .eca-group-name,#eca-panel .eca-group-off .eca-group-count{color:#666;text-decoration:line-through;}'
        + '#eca-panel .eca-group-toggle{flex:0 0 auto;cursor:pointer;margin:0;}'
        + '#eca-panel .eca-group-btn{background:none;border:0;color:#8895a8;cursor:pointer;font-size:11px;padding:0 2px;flex:0 0 auto;}'
        + '#eca-panel .eca-group-btn:hover{color:#fff;}'
        + '#eca-panel .eca-group-body{padding:4px 6px 6px;display:flex;flex-direction:column;gap:4px;min-height:14px;border-top:1px solid #333844;}'
        + '#eca-panel .eca-group.collapsed .eca-group-body{display:none;}'
        + '#eca-panel .eca-group-body.eca-drop-hover{background:rgba(45,95,138,.35);outline:1px dashed #4a90c4;outline-offset:-3px;}'
        + '#eca-panel .eca-char-item[draggable]{cursor:grab;}'
        + '#eca-panel .eca-char-item.eca-dragging{opacity:.4;}'
        + '#eca-panel .eca-detail{flex:1;padding:12px 16px;overflow-y:auto;}'
        + '#eca-panel .eca-detail-empty{color:#777;padding:40px 0;text-align:center;}'
        + '#eca-panel .eca-detail-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}'
        + '#eca-panel .eca-detail-head b{font-size:15px;}'
        + '#eca-panel .eca-detail-tip{color:#778;font-size:12px;margin-bottom:8px;}'
        + '#eca-panel .eca-mini-btn{padding:3px 10px;border-radius:5px;border:1px solid #4a5160;background:#2a2e37;color:#cde;cursor:pointer;font-size:12px;}'
        + '#eca-panel .eca-mini-btn:hover{background:#323744;}'
        + '#eca-panel .eca-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;}'
        + '#eca-panel .eca-cell{border:1px solid #3a3f4b;border-radius:8px;padding:6px;text-align:center;cursor:pointer;background:#282c35;}'
        + '#eca-panel .eca-cell:hover{border-color:#4a90c4;}'
        + '#eca-panel .eca-cell-img{height:72px;display:flex;align-items:center;justify-content:center;margin-bottom:4px;}'
        + '#eca-panel .eca-cell-img img{max-height:72px;max-width:100%;border-radius:6px;}'
        + '#eca-panel .eca-cell-empty{width:56px;height:56px;border:1px dashed #555;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#666;font-size:11px;}'
        + '#eca-panel .eca-cell-name{font-size:12px;color:#aab;}'
        + '#eca-panel .eca-switch{display:flex;align-items:center;gap:6px;cursor:pointer;}'
        + '#eca-panel .eca-size{display:flex;align-items:center;gap:8px;}'
        + '#eca-panel .eca-size input[type=range]{width:140px;}'
        + '#eca-panel .eca-size-val{min-width:3.5em;color:#9bd;}'
        + '#eca-panel .eca-size-preview{margin-left:auto;display:flex;align-items:center;gap:8px;color:#889;}'
        // 批量导入对话框
        + '#eca-batch-panel .eca-batch-body{padding:12px 16px;overflow-y:auto;}'
        + '#eca-batch-panel .eca-batch-canvas-wrap{background:#181a1f;border:1px dashed #444;border-radius:8px;padding:8px;text-align:center;cursor:pointer;}'
        + '#eca-batch-panel .eca-batch-canvas-wrap canvas{max-width:100%;height:auto;}'
        + '#eca-batch-panel .eca-batch-hint{color:#889;padding:24px 0;}'
        + '#eca-batch-panel .eca-batch-ctrl{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0;}'
        + '#eca-batch-panel .eca-stepper{display:flex;align-items:center;gap:4px;color:#aab;}'
        + '#eca-batch-panel .eca-stepper b{min-width:1.2em;text-align:center;color:#cde;}'
        + '#eca-batch-panel .eca-batch-ctrl button{padding:2px 9px;border-radius:4px;border:1px solid #4a5160;background:#2a2e37;color:#cde;cursor:pointer;}'
        + '#eca-batch-panel .eca-batch-ctrl button:hover{background:#323744;}'
        + '#eca-batch-panel .eca-batch-ctrl select,#eca-batch-panel .eca-bcell select{background:#2a2e37;color:#cde;border:1px solid #4a5160;border-radius:4px;padding:2px 6px;}'
        + '#eca-batch-panel .eca-batch-mapping{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;}'
        + '#eca-batch-panel .eca-bcell{border:1px solid #3a3f4b;border-radius:8px;padding:5px;text-align:center;background:#282c35;}'
        + '#eca-batch-panel .eca-bcell.skipped{opacity:.45;}'
        + '#eca-batch-panel .eca-bcell img{width:100%;height:60px;object-fit:contain;border-radius:4px;background:#181a1f;}'
        + '#eca-batch-panel .eca-bcell select{width:100%;margin-top:4px;font-size:12px;}'
        + '#eca-batch-panel .eca-primary{background:#2d5f8a;color:#fff;border:0;border-radius:6px;padding:6px 18px;cursor:pointer;font-size:13px;}'
        + '#eca-batch-panel .eca-primary:hover{background:#3a78ab;}'
        + '#eca-batch-panel .eca-primary:disabled{opacity:.5;cursor:wait;}'
        // toast
        + '.eca-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:#2d5f8a;color:#fff;padding:8px 18px;border-radius:6px;z-index:100002;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .4s;}'
        + '.eca-toast.eca-toast-warn{background:#8a4a2d;}'
        + '.eca-toast.eca-toast-out{opacity:0;}';

    function ensurePanelStyles() {
        if (doc.getElementById('eca-panel-styles')) return;
        const style = doc.createElement('style');
        style.id = 'eca-panel-styles';
        style.textContent = PANEL_CSS;
        doc.head.appendChild(style);
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function toast(msg, isWarn) {
        const el = doc.createElement('div');
        el.className = 'eca-toast' + (isWarn ? ' eca-toast-warn' : '');
        el.textContent = msg;
        doc.body.appendChild(el);
        setTimeout(function () { el.classList.add('eca-toast-out'); }, 1800);
        setTimeout(function () { el.remove(); }, 2300);
    }

    /** 图片降采样：长边 ≤ maxEdge，输出 PNG Blob（单格上传与批量切图共用） */
    function downscaleBlob(blob, maxEdge) {
        return new Promise(function (resolve, reject) {
            const url = createBlobUrl(blob);
            const img = new topWindow.Image();
            img.onload = function () {
                try {
                    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
                    const w = Math.max(1, Math.round(img.naturalWidth * scale));
                    const h = Math.max(1, Math.round(img.naturalHeight * scale));
                    const canvas = doc.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    canvas.toBlob(function (out) {
                        revokeCacheUrl(url);
                        if (out) resolve(out); else reject(new Error('图片编码失败'));
                    }, 'image/png');
                } catch (e) { revokeCacheUrl(url); reject(e); }
            };
            img.onerror = function () { revokeCacheUrl(url); reject(new Error('图片加载失败')); };
            img.src = url;
        });
    }

    // ---------- 角色与组操作（面板与调试桥共用，全部持久化） ----------
    function addCharacter(name, groupId) {
        name = String(name || '').trim();
        if (!name || name.length > 30 || /[{}()]/.test(name)) return false;
        if (characters.indexOf(name) !== -1) return false;
        const group = (groupId && groups.filter(function (g) { return g.id === groupId; })[0]) || groups[0];
        if (!group) return false;
        group.members.push(name);
        rebuildCharacterIndex();
        persistCharacters();
        applyInjection();
        return true;
    }

    function removeCharacter(name) {
        const group = findGroupByChar(name);
        if (!group) return Promise.resolve(false);
        group.members.splice(group.members.indexOf(name), 1);
        rebuildCharacterIndex();
        persistCharacters();
        if (selectedCharacter === name) selectedCharacter = characters[0] || null;
        applyInjection();
        return deleteCharacterAvatars(name).then(function () { return true; });
    }

    function renameCharacter(oldName, newName) {
        newName = String(newName || '').trim();
        if (!newName || newName.length > 30 || /[{}()]/.test(newName)) return Promise.resolve(false);
        if (characters.indexOf(newName) !== -1) return Promise.resolve(false);
        const group = findGroupByChar(oldName);
        if (!group) return Promise.resolve(false);
        group.members[group.members.indexOf(oldName)] = newName;
        rebuildCharacterIndex();
        persistCharacters();
        if (selectedCharacter === oldName) selectedCharacter = newName;
        applyInjection();
        return renameCharacterAvatars(oldName, newName).then(function () { return true; });
    }

    // ---------- 人物组操作 ----------
    function addGroup(name) {
        name = String(name || '').trim() || ('分组 ' + (groups.length + 1));
        if (groups.some(function (g) { return g.name === name; })) return null;
        const g = { id: makeGroupId(), name: name, enabled: true, members: [] };
        groups.push(g);
        persistCharacters();
        return g;
    }

    function removeGroup(groupId) {
        const i = groups.findIndex(function (g) { return g.id === groupId; });
        if (i === -1 || groups.length <= 1) return false; // 至少保留一个组
        const removed = groups.splice(i, 1)[0];
        // 组内角色迁回第一个剩余组（素材保留，避免误删）
        const target = groups[0];
        removed.members.forEach(function (name) {
            if (target.members.indexOf(name) === -1) target.members.push(name);
        });
        rebuildCharacterIndex();
        persistCharacters();
        applyInjection();
        return true;
    }

    function toggleGroup(groupId, enabled) {
        const g = groups.filter(function (x) { return x.id === groupId; })[0];
        if (!g) return false;
        g.enabled = !!enabled;
        persistCharacters();
        applyInjection();
        return true;
    }

    function renameGroup(groupId, newName) {
        newName = String(newName || '').trim();
        const g = groups.filter(function (x) { return x.id === groupId; })[0];
        if (!g || !newName || groups.some(function (x) { return x.name === newName && x.id !== groupId; })) return false;
        g.name = newName;
        persistCharacters();
        return true;
    }

    /** 拖拽落点：把角色移入目标组 */
    function moveCharacterToGroup(name, groupId) {
        const from = findGroupByChar(name);
        const to = groups.filter(function (g) { return g.id === groupId; })[0];
        if (!from || !to || from === to) return false;
        from.members.splice(from.members.indexOf(name), 1);
        to.members.push(name);
        rebuildCharacterIndex();
        persistCharacters();
        applyInjection();
        return true;
    }

    /** 单格上传入口：降采样（长边 256）后入库 */
    function uploadAvatarFile(character, emotion, file) {
        if (!EMOTION_SET.has(emotion)) return Promise.reject(new Error('非法情绪词：' + emotion));
        return downscaleBlob(file, 256).then(function (blob) {
            return saveAvatar(character, emotion, blob);
        });
    }

    /** 文件名包含中文情绪名即命中；多个命中取最先出现者；无命中返回 null */
    function matchEmotionFromName(name) {
        let best = null;
        let bestIdx = Infinity;
        const text = String(name || '');
        for (let i = 0; i < EMOTIONS.length; i++) {
            const idx = text.indexOf(EMOTIONS[i]);
            if (idx !== -1 && idx < bestIdx) { best = EMOTIONS[i]; bestIdx = idx; }
        }
        return best;
    }

    // ---------- 面板 DOM ----------
    let panelEl = null;
    let selectedCharacter = null;
    let fileInputEl = null;

    function addMenuButton() {
        if (doc.getElementById('eca-menu-btn')) return;
        const mount = doc.getElementById('extensionsMenu') || doc.getElementById('top-bar');
        if (!mount) return;
        // 酒馆原生菜单条目结构（同"跳转楼层"等插件）：menu_button 自带
        // width:min-content，放在抽屉里会被压成单字竖排，故不可用
        const container = doc.createElement('div');
        container.className = 'extension_container';
        const btn = doc.createElement('div');
        btn.id = 'eca-menu-btn';
        btn.className = 'list-group-item flex-container flexGap5';
        btn.title = '情绪头像管理';
        const icon = doc.createElement('div');
        icon.className = 'fa-solid fa-face-smile extensionsMenuExtensionButton';
        const label = doc.createElement('span');
        label.textContent = '情绪头像';
        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener('click', openPanel);
        container.appendChild(btn);
        mount.appendChild(container);
    }

    function buildPanelSkeleton() {
        const root = doc.createElement('div');
        root.id = 'eca-panel';
        root.innerHTML = ''
            + '<div class="eca-modal">'
            + '  <div class="eca-header"><span>情绪头像管理</span><button class="eca-close" title="关闭">×</button></div>'
            + '  <div class="eca-body">'
            + '    <div class="eca-side">'
            + '      <div class="eca-side-title">已登记角色（可拖拽分组）</div>'
            + '      <div id="eca-char-list"></div>'
            + '      <button class="eca-add" id="eca-add-group">＋ 新增分组</button>'
            + '      <button class="eca-add" id="eca-add-char" style="margin-top:6px;">＋ 新增角色</button>'
            + '    </div>'
            + '    <div class="eca-detail" id="eca-detail"></div>'
            + '  </div>'
            + '  <div class="eca-footer">'
            + '    <label class="eca-switch"><input type="checkbox" id="eca-enabled"> 启用提示词注入</label>'
            + '    <div class="eca-size"><span>头像大小</span>'
            + '      <input type="range" id="eca-size-range" min="1.5" max="5" step="0.1">'
            + '      <span class="eca-size-val" id="eca-size-val"></span></div>'
            + '    <div class="eca-size-preview" id="eca-size-preview"></div>'
            + '  </div>'
            + '</div>';
        fileInputEl = doc.createElement('input');
        fileInputEl.type = 'file';
        fileInputEl.accept = 'image/*';
        fileInputEl.multiple = true;
        fileInputEl.style.display = 'none';
        root.appendChild(fileInputEl);
        bindPanelEvents(root);
        return root;
    }

    /** 手风琴展开状态（gid → true 折叠），不持久化 */
    const collapsedGroups = {};

    function bindPanelEvents(root) {
        root.querySelector('.eca-close').addEventListener('click', closePanel);
        root.addEventListener('click', function (ev) {
            const target = ev.target;
            if (target.id === 'eca-add-char') { addCharacterFlow(); return; }
            if (target.id === 'eca-add-group') { addGroupFlow(); return; }
            // 组开关（checkbox）：点击不冒泡到折叠
            if (target.classList && target.classList.contains('eca-group-toggle')) {
                toggleGroup(target.dataset.gid, target.checked);
                renderPanel();
                const g = groups.filter(function (x) { return x.id === target.dataset.gid; })[0];
                toast('「' + (g ? g.name : '') + '」注入已' + (target.checked ? '开启' : '关闭')
                    + (target.checked ? '' : '（组内角色不再注入提示词，头像渲染不受影响）'));
                return;
            }
            const grpBtn = target.closest ? target.closest('.eca-group-btn') : null;
            if (grpBtn) {
                if (grpBtn.dataset.act === 'grp-rename') renameGroupFlow(grpBtn.dataset.gid);
                else if (grpBtn.dataset.act === 'grp-del') removeGroupFlow(grpBtn.dataset.gid);
                return;
            }
            const del = target.closest ? target.closest('.eca-char-del') : null;
            if (del) { removeCharacterFlow(del.dataset.name); return; }
            const rename = target.closest ? target.closest('#eca-rename-btn') : null;
            if (rename) { renameCharacterFlow(selectedCharacter); return; }
            const batch = target.closest ? target.closest('#eca-batch-btn') : null;
            if (batch) { openBatchDialog(selectedCharacter); return; }
            // 组头点击：折叠/展开（点名字区域或箭头）
            const head = target.closest ? target.closest('.eca-group-head') : null;
            if (head) {
                const gid = head.parentElement.dataset.gid;
                collapsedGroups[gid] = !collapsedGroups[gid];
                renderPanel();
                return;
            }
            const item = target.closest ? target.closest('.eca-char-item') : null;
            if (item && item.dataset.name) {
                selectedCharacter = item.dataset.name;
                renderPanel();
                return;
            }
            const cell = target.closest ? target.closest('.eca-cell') : null;
            if (cell && cell.dataset.emotion && selectedCharacter) {
                fileInputEl.dataset.emotion = cell.dataset.emotion;
                fileInputEl.click();
            }
        });
        // 组名双击重命名
        root.addEventListener('dblclick', function (ev) {
            const name = ev.target.closest ? ev.target.closest('.eca-group-name') : null;
            if (name) renameGroupFlow(name.closest('.eca-group').dataset.gid);
        });
        // 拖拽：角色 → 组（dragstart/dragover/drop 事件不冒泡为 click）
        root.addEventListener('dragstart', function (ev) {
            const item = ev.target.closest ? ev.target.closest('.eca-char-item') : null;
            if (!item || !item.dataset.name) return;
            ev.dataTransfer.setData('text/plain', item.dataset.name);
            ev.dataTransfer.effectAllowed = 'move';
            item.classList.add('eca-dragging');
        });
        root.addEventListener('dragend', function (ev) {
            const item = ev.target.closest ? ev.target.closest('.eca-char-item') : null;
            if (item) item.classList.remove('eca-dragging');
            root.querySelectorAll('.eca-drop-hover').forEach(function (el) { el.classList.remove('eca-drop-hover'); });
        });
        root.addEventListener('dragover', function (ev) {
            const body = ev.target.closest ? ev.target.closest('.eca-group-body') : null;
            if (!body) return;
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
            body.classList.add('eca-drop-hover');
        });
        root.addEventListener('dragleave', function (ev) {
            const body = ev.target.closest ? ev.target.closest('.eca-group-body') : null;
            if (body) body.classList.remove('eca-drop-hover');
        });
        root.addEventListener('drop', function (ev) {
            const body = ev.target.closest ? ev.target.closest('.eca-group-body') : null;
            if (!body) return;
            ev.preventDefault();
            body.classList.remove('eca-drop-hover');
            const name = ev.dataTransfer.getData('text/plain');
            const gid = body.closest('.eca-group').dataset.gid;
            if (name && moveCharacterToGroup(name, gid)) {
                renderPanel();
                const g = groups.filter(function (x) { return x.id === gid; })[0];
                toast('「' + name + '」已移入「' + (g ? g.name : '') + '」');
            }
        });
        fileInputEl.addEventListener('change', function () {
            const files = fileInputEl.files ? Array.prototype.slice.call(fileInputEl.files) : [];
            const emotion = fileInputEl.dataset.emotion;
            fileInputEl.value = '';
            if (!files.length || !emotion || !selectedCharacter) return;
            // 单文件：归入所点格子的情绪（点格子选一张，意图明确）
            if (files.length === 1) {
                uploadAvatarFile(selectedCharacter, emotion, files[0])
                    .then(function () {
                        renderPanel();
                        toast('已更新「' + selectedCharacter + '·' + emotion + '」');
                    })
                    .catch(function (e) { toast('上传失败：' + (e && e.message || e), true); });
                return;
            }
            // 多文件：按文件名包含的情绪词自动匹配，未匹配的跳过
            let done = 0;
            let failed = 0;
            const skipped = [];
            const finish = function () {
                renderPanel();
                let msg = '已导入 ' + done + ' 张（' + selectedCharacter + '）';
                if (failed) msg += '，失败 ' + failed + ' 张';
                toast(msg, failed > 0);
                if (skipped.length) {
                    toast('未匹配到情绪词，已跳过：' + skipped.join('、'), true);
                }
            };
            files.forEach(function (file) {
                const matched = matchEmotionFromName(file.name);
                if (!matched) { skipped.push(file.name); return; }
                uploadAvatarFile(selectedCharacter, matched, file)
                    .then(function () { done++; })
                    .catch(function () { failed++; })
                    .then(function () {
                        if (done + failed + skipped.length === files.length) finish();
                    });
            });
            // 全部文件都未匹配时没有异步任务，直接收尾
            if (skipped.length === files.length) finish();
        });
        const enabledCb = root.querySelector('#eca-enabled');
        enabledCb.addEventListener('change', function () {
            setEnabled(enabledCb.checked);
            toast(enabledCb.checked ? '提示词注入已开启' : '提示词注入已关闭');
        });
        const range = root.querySelector('#eca-size-range');
        range.addEventListener('input', function () {
            setSize(parseFloat(range.value));
            syncPanelControls();
            updateSizePreview();
        });
    }

    function buildSizePreviewEl() {
        let sample = null;
        if (selectedCharacter) {
            for (let i = 0; i < EMOTIONS.length; i++) {
                const src = avatarCache.get(selectedCharacter + '_' + EMOTIONS[i]);
                if (src) { sample = src; break; }
            }
        }
        if (sample) {
            const img = doc.createElement('img');
            img.className = 'eca-avatar';
            img.src = sample;
            img.alt = '预览';
            return img;
        }
        const span = doc.createElement('span');
        span.className = 'eca-avatar eca-placeholder';
        return span;
    }

    function updateSizePreview() {
        if (!panelEl) return;
        const box = panelEl.querySelector('#eca-size-preview');
        if (!box) return;
        box.textContent = '预览 ';
        box.appendChild(buildSizePreviewEl());
    }

    function syncPanelControls() {
        if (!panelEl) return;
        const cb = panelEl.querySelector('#eca-enabled');
        if (cb) cb.checked = settings.enabled;
        const range = panelEl.querySelector('#eca-size-range');
        if (range) range.value = String(settings.size);
        const val = panelEl.querySelector('#eca-size-val');
        if (val) val.textContent = Number(settings.size).toFixed(1) + 'em';
    }

    function renderPanel() {
        if (!panelEl) return;
        if (selectedCharacter && characters.indexOf(selectedCharacter) === -1) {
            selectedCharacter = characters[0] || null;
        }
        if (!selectedCharacter && characters.length) selectedCharacter = characters[0];
        // 角色列表：按组渲染手风琴
        const listBox = panelEl.querySelector('#eca-char-list');
        listBox.innerHTML = groups.map(function (g) {
            const collapsed = collapsedGroups[g.id] ? ' collapsed' : '';
            const off = g.enabled ? '' : ' eca-group-off';
            const head = '<div class="eca-group-head">'
                + '<span class="eca-group-arrow">▼</span>'
                + '<input type="checkbox" class="eca-group-toggle" data-gid="' + g.id + '"'
                + (g.enabled ? ' checked' : '') + ' title="组开关：关闭后组内角色不注入提示词（头像渲染不受影响）">'
                + '<span class="eca-group-name" title="双击重命名">' + escapeHtml(g.name) + '</span>'
                + '<span class="eca-group-count">' + g.members.length + '</span>'
                + '<button class="eca-group-btn" data-act="grp-rename" data-gid="' + g.id + '" title="重命名组">✎</button>'
                + '<button class="eca-group-btn" data-act="grp-del" data-gid="' + g.id + '" title="删除组（组内角色迁回第一个组）">✕</button>'
                + '</div>';
            const members = g.members.length
                ? g.members.map(function (name) {
                    return '<div class="eca-char-item' + (name === selectedCharacter ? ' active' : '') + '" draggable="true" data-name="' + escapeHtml(name) + '">'
                        + '<span class="eca-char-name">' + escapeHtml(name) + '</span>'
                        + '<button class="eca-char-del" data-name="' + escapeHtml(name) + '" title="删除角色及头像">✕</button>'
                        + '</div>';
                }).join('')
                : '<div class="eca-detail-empty" style="padding:8px 0;color:#556;font-size:11px;">拖人物到此（空组）</div>';
            return '<div class="eca-group' + collapsed + off + '" data-gid="' + g.id + '">'
                + head
                + '<div class="eca-group-body">' + members + '</div>'
                + '</div>';
        }).join('');
        // 角色详情
        const detail = panelEl.querySelector('#eca-detail');
        if (!selectedCharacter) {
            detail.innerHTML = '<div class="eca-detail-empty">左侧新增一个角色后，在这里为十种情绪配置头像</div>';
        } else {
            const cells = EMOTIONS.map(function (emotion) {
                const src = avatarCache.get(selectedCharacter + '_' + emotion);
                const imgHtml = src
                    ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(emotion) + '">'
                    : '<div class="eca-cell-empty">' + escapeHtml(emotion) + '</div>';
                return '<div class="eca-cell" data-emotion="' + escapeHtml(emotion) + '" title="点击上传/更换「' + escapeHtml(emotion) + '」头像">'
                    + '<div class="eca-cell-img">' + imgHtml + '</div>'
                    + '<div class="eca-cell-name">' + escapeHtml(emotion) + '</div>'
                    + '</div>';
            }).join('');
            detail.innerHTML = ''
                + '<div class="eca-detail-head"><b>' + escapeHtml(selectedCharacter) + '</b>'
                + '<button class="eca-mini-btn" id="eca-batch-btn">批量导入大图</button>'
                + '<button class="eca-mini-btn" id="eca-rename-btn">改名</button></div>'
                + '<div class="eca-detail-tip">点击格子上传 / 更换单张头像；多选文件时按文件名自动匹配情绪；十种情绪缺图时自动回落「默认」</div>'
                + '<div class="eca-grid">' + cells + '</div>';
        }
        syncPanelControls();
        updateSizePreview();
    }

    function openPanel() {
        ensurePanelStyles();
        if (!panelEl) {
            panelEl = buildPanelSkeleton();
            doc.body.appendChild(panelEl);
        }
        renderPanel();
        panelEl.style.display = 'flex';
    }

    function closePanel() {
        if (panelEl) panelEl.style.display = 'none';
    }

    // ---------- 面板交互流程（prompt/confirm 走顶层窗口） ----------
    function uiPrompt(message, defaultValue) {
        if (typeof topWindow.prompt !== 'function') { toast('当前环境不支持输入框', true); return null; }
        return topWindow.prompt(message, defaultValue);
    }
    function uiConfirm(message) {
        if (typeof topWindow.confirm !== 'function') return true;
        return topWindow.confirm(message);
    }

    function addCharacterFlow() {
        const name = uiPrompt('新增角色名（须与 AI 输出的角色名逐字一致）：', '');
        if (name === null) return;
        if (addCharacter(name)) {
            selectedCharacter = characters[characters.length - 1];
            renderPanel();
            toast('已登记角色「' + selectedCharacter + '」');
        } else {
            toast('角色名无效（1-30 字，不含花括号/圆括号）或已存在', true);
        }
    }

    function addGroupFlow() {
        const name = uiPrompt('新增分组名（如：本卡角色 / 备用角色）：', '');
        if (name === null) return;
        const g = addGroup(name);
        if (g) {
            collapsedGroups[g.id] = false;
            renderPanel();
            toast('已新建分组「' + g.name + '」，可拖拽角色进入');
        } else {
            toast('分组名无效或已存在', true);
        }
    }

    function removeGroupFlow(gid) {
        const g = groups.filter(function (x) { return x.id === gid; })[0];
        if (!g) return;
        if (groups.length <= 1) { toast('至少保留一个分组', true); return; }
        if (!uiConfirm('删除分组「' + g.name + '」？组内角色会迁回第一个分组（头像保留）')) return;
        if (removeGroup(gid)) { renderPanel(); toast('已删除分组「' + g.name + '」'); }
    }

    function renameGroupFlow(gid) {
        const g = groups.filter(function (x) { return x.id === gid; })[0];
        if (!g) return;
        const newName = uiPrompt('修改分组名：', g.name);
        if (newName === null || newName === g.name) return;
        if (renameGroup(gid, newName)) { renderPanel(); toast('已改名「' + newName + '」'); }
        else toast('分组名无效或已存在', true);
    }

    function removeCharacterFlow(name) {
        if (!name) return;
        if (!uiConfirm('删除角色「' + name + '」及其全部头像？')) return;
        removeCharacter(name).then(function (ok) {
            if (ok) { renderPanel(); toast('已删除「' + name + '」'); }
        });
    }

    function renameCharacterFlow(name) {
        if (!name) return;
        const newName = uiPrompt('修改角色名（头像会一并迁移）：', name);
        if (newName === null || newName === name) return;
        renameCharacter(name, newName).then(function (ok) {
            if (ok) { renderPanel(); toast('已改名「' + newName + '」'); }
            else toast('新名字无效或已存在', true);
        });
    }

    // ============================================
    // 单图批量网格导入（M5）：移植自 galgame v2.2，核心逻辑与对话框 UI 分离
    // ============================================
    const CROP_RATIOS = ['1:1', '2:3', '3:4', '4:5', '9:16'];

    /** 按宽高比猜网格行列（galgame v2.2 同款），行 1-5、列 1-6 */
    function autoDetectGrid(img) {
        const ratio = img.width / img.height;
        let rows, cols;
        if (ratio > 2.5) { rows = 1; cols = Math.round(ratio * 1.5); }
        else if (ratio > 1.8) { rows = 2; cols = Math.round(ratio * 2); }
        else if (ratio > 1.2) { rows = 2; cols = 3; }
        else if (ratio > 0.8) { rows = 3; cols = 3; }
        else { rows = Math.round(3 / ratio); cols = 2; }
        return { rows: Math.max(1, Math.min(5, rows)), cols: Math.max(1, Math.min(6, cols)) };
    }

    /** '2:3' → 2/3（宽/高），非法输入回落 1 */
    function parseCropRatio(label) {
        const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(label || ''));
        const ratio = m ? parseFloat(m[1]) / parseFloat(m[2]) : 1;
        return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    }

    /**
     * 从合集大图切一个格子：等分定位 → 居中裁剪到目标比例 → 输出 PNG Blob
     * 输出长边 = min(256, 源裁剪区长边)，不做放大
     */
    function sliceGridCell(img, row, col, rows, cols, ratioLabel) {
        const dstAspect = parseCropRatio(ratioLabel);
        const cellWidth = img.width / cols;
        const cellHeight = img.height / rows;
        const sx = col * cellWidth;
        const sy = row * cellHeight;
        let cropWidth = cellWidth, cropHeight = cellHeight, cropX = 0, cropY = 0;
        if (cellWidth / cellHeight > dstAspect) {
            cropWidth = cellHeight * dstAspect;
            cropX = (cellWidth - cropWidth) / 2;
        } else {
            cropHeight = cellWidth / dstAspect;
            cropY = (cellHeight - cropHeight) / 2;
        }
        const longEdge = Math.max(1, Math.min(256, Math.round(Math.max(cropWidth, cropHeight))));
        const outW = Math.max(1, Math.round(dstAspect >= 1 ? longEdge : longEdge * dstAspect));
        const outH = Math.max(1, Math.round(dstAspect >= 1 ? longEdge / dstAspect : longEdge));
        const canvas = doc.createElement('canvas');
        canvas.width = outW; canvas.height = outH;
        canvas.getContext('2d').drawImage(img, sx + cropX, sy + cropY, cropWidth, cropHeight, 0, 0, outW, outH);
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error('切图编码失败')); }, 'image/png');
        });
    }

    /**
     * 批量导入核心（对话框只负责收集参数）：
     * config = { rows, cols, ratio, mappings: [{row, col, emotion}] }，返回 {saved, failed}
     */
    function runBatchImport(character, img, config) {
        const rows = config.rows;
        const cols = config.cols;
        const ratio = config.ratio || '1:1';
        const mappings = (config.mappings || []).filter(function (m) {
            return m && m.emotion && EMOTION_SET.has(m.emotion);
        });
        let saved = 0, failed = 0;
        let chain = Promise.resolve();
        mappings.forEach(function (m) {
            chain = chain.then(function () {
                return sliceGridCell(img, m.row, m.col, rows, cols, ratio)
                    .then(function (blob) { return saveAvatar(character, m.emotion, blob); })
                    .then(function () { saved++; })
                    .catch(function (e) {
                        failed++;
                        console.warn('[' + SCRIPT_NAME + '] 批量导入失败:', character, m.emotion, e);
                    });
            });
        });
        return chain.then(function () { return { saved: saved, failed: failed }; });
    }

    // ---------- 批量导入对话框 ----------
    let batchEl = null;
    let batchFileInput = null;
    let batchCharacter = null;
    let batchImage = null;
    let batchRows = 2, batchCols = 5;
    let batchMappings = [];

    function openBatchDialog(character) {
        ensurePanelStyles();
        if (!character) { toast('请先选择角色', true); return; }
        batchCharacter = character;
        if (!batchEl) {
            batchEl = buildBatchSkeleton();
            doc.body.appendChild(batchEl);
        }
        batchEl.querySelector('#eca-batch-title').textContent = '批量导入「' + character + '」';
        const ratioSel = batchEl.querySelector('#eca-batch-ratio');
        ratioSel.innerHTML = CROP_RATIOS.map(function (r) {
            const cur = settings.batchCropRatio || '1:1';
            return '<option value="' + r + '"' + (r === cur ? ' selected' : '') + '>' + r + '</option>';
        }).join('');
        resetBatchImage();
        batchEl.style.display = 'flex';
    }

    function closeBatchDialog() {
        if (batchEl) batchEl.style.display = 'none';
    }

    function resetBatchImage() {
        batchImage = null;
        batchMappings = [];
        if (!batchEl) return;
        batchEl.querySelector('#eca-batch-hint').style.display = '';
        batchEl.querySelector('#eca-batch-canvas').style.display = 'none';
        batchEl.querySelector('#eca-batch-ctrl').style.display = 'none';
        batchEl.querySelector('#eca-batch-mapping').style.display = 'none';
        batchEl.querySelector('#eca-batch-tip').textContent = '';
    }

    function loadBatchImage(img) {
        batchImage = img;
        const detected = autoDetectGrid(img);
        batchRows = detected.rows;
        batchCols = detected.cols;
        renderBatchAll();
    }

    function loadBatchImageFromFile(file) {
        const reader = new topWindow.FileReader();
        reader.onload = function () {
            const img = new topWindow.Image();
            img.onload = function () { loadBatchImage(img); };
            img.onerror = function () { toast('图片加载失败', true); };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    function renderBatchAll() {
        if (!batchEl || !batchImage) return;
        batchEl.querySelector('#eca-batch-hint').style.display = 'none';
        batchEl.querySelector('#eca-batch-canvas').style.display = '';
        batchEl.querySelector('#eca-batch-ctrl').style.display = '';
        batchEl.querySelector('#eca-batch-mapping').style.display = '';
        batchEl.querySelector('#eca-batch-rows').textContent = String(batchRows);
        batchEl.querySelector('#eca-batch-cols').textContent = String(batchCols);
        renderBatchPreview();
        rebuildBatchMapping();
    }

    /** 网格预览：缩放绘制 + 青色虚线 + 序号圆点（galgame v2.2 同款画法） */
    function renderBatchPreview() {
        const canvas = batchEl.querySelector('#eca-batch-canvas');
        const wrap = batchEl.querySelector('#eca-batch-drop');
        const maxWidth = Math.max(200, (wrap.clientWidth || 800) - 20);
        const maxHeight = 320;
        const scale = Math.min(maxWidth / batchImage.width, maxHeight / batchImage.height, 1);
        const dw = batchImage.width * scale;
        const dh = batchImage.height * scale;
        canvas.width = dw; canvas.height = dh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(batchImage, 0, 0, dw, dh);
        ctx.strokeStyle = '#00d2ff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        const cw = dw / batchCols, ch = dh / batchRows;
        for (let i = 1; i < batchCols; i++) {
            ctx.beginPath(); ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, dh); ctx.stroke();
        }
        for (let i = 1; i < batchRows; i++) {
            ctx.beginPath(); ctx.moveTo(0, i * ch); ctx.lineTo(dw, i * ch); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = 'bold 15px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let index = 0;
        for (let row = 0; row < batchRows; row++) {
            for (let col = 0; col < batchCols; col++) {
                const x = col * cw + cw / 2, y = row * ch + ch / 2;
                ctx.fillStyle = 'rgba(0,0,0,.6)';
                ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = '#fff';
                ctx.fillText(String(index + 1), x, y);
                index++;
            }
        }
    }

    /** 重建映射：前 10 格按情绪表顺序默认填，超出默认跳过；调整行列会重置（galgame 同款行为） */
    function rebuildBatchMapping() {
        const box = batchEl.querySelector('#eca-batch-mapping');
        const total = batchRows * batchCols;
        batchMappings = [];
        let html = '';
        for (let i = 0; i < total; i++) {
            const row = Math.floor(i / batchCols);
            const col = i % batchCols;
            const emotion = EMOTIONS[i] || '';
            batchMappings.push({ row: row, col: col, emotion: emotion, skip: !emotion });
            html += '<div class="eca-bcell' + (emotion ? '' : ' skipped') + '" data-index="' + i + '">'
                + '<img alt="格 ' + (i + 1) + '" data-index="' + i + '">'
                + '<select data-index="' + i + '"></select>'
                + '</div>';
        }
        box.innerHTML = html;
        updateAllBatchSelectOptions();
        updateBatchTip();
        // 逐格延迟生成缩略图，避免大图一次性卡顿
        for (let i = 0; i < total; i++) {
            setTimeout(function (idx) { renderBatchCellPreview(idx); }, 50 + i * 30, i);
        }
    }

    function renderBatchCellPreview(index) {
        if (!batchImage || !batchEl) return;
        const img = batchEl.querySelector('.eca-bcell img[data-index="' + index + '"]');
        if (!img) return;
        const cw = batchImage.width / batchCols;
        const ch = batchImage.height / batchRows;
        const row = Math.floor(index / batchCols);
        const col = index % batchCols;
        const c = doc.createElement('canvas');
        c.width = Math.max(1, Math.round(cw));
        c.height = Math.max(1, Math.round(ch));
        c.getContext('2d').drawImage(batchImage, col * cw, row * ch, cw, ch, 0, 0, c.width, c.height);
        img.src = c.toDataURL();
    }

    /** 互斥下拉：已被其他格选走的情绪不再出现在选项里 */
    function updateAllBatchSelectOptions() {
        const used = {};
        batchMappings.forEach(function (m) { if (m.emotion) used[m.emotion] = true; });
        batchEl.querySelectorAll('.eca-bcell select').forEach(function (sel) {
            const index = parseInt(sel.dataset.index, 10);
            const current = batchMappings[index].emotion;
            let html = '<option value="">-- 跳过 --</option>';
            EMOTIONS.forEach(function (emo) {
                if (used[emo] && emo !== current) return;
                html += '<option value="' + escapeHtml(emo) + '"' + (emo === current ? ' selected' : '') + '>' + emo + '</option>';
            });
            sel.innerHTML = html;
        });
    }

    function updateBatchTip() {
        if (!batchEl) return;
        const mapped = batchMappings.filter(function (m) { return !m.skip && m.emotion; }).length;
        batchEl.querySelector('#eca-batch-tip').textContent =
            '已映射 ' + mapped + '/' + batchMappings.length + ' 格；保存时按 ' + (settings.batchCropRatio || '1:1')
            + ' 居中裁剪，长边 ≤256px';
    }

    function saveBatchFlow() {
        if (!batchImage || !batchCharacter) { toast('请先上传图片', true); return; }
        const valid = batchMappings.filter(function (m) { return !m.skip && m.emotion; });
        if (!valid.length) { toast('请至少为一个格子选择情绪', true); return; }
        const saveBtn = batchEl.querySelector('#eca-batch-save');
        saveBtn.disabled = true;
        saveBtn.textContent = '处理中…';
        runBatchImport(batchCharacter, batchImage, {
            rows: batchRows,
            cols: batchCols,
            ratio: settings.batchCropRatio || '1:1',
            mappings: valid,
        }).then(function (r) {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存全部头像';
            closeBatchDialog();
            renderPanel();
            scanAll();
            toast('批量导入完成：成功 ' + r.saved + ' 张' + (r.failed ? '，失败 ' + r.failed + ' 张' : ''), r.failed > 0);
        });
    }

    function buildBatchSkeleton() {
        const root = doc.createElement('div');
        root.id = 'eca-batch-panel';
        root.innerHTML = ''
            + '<div class="eca-modal">'
            + '  <div class="eca-header"><span id="eca-batch-title">批量导入</span><button class="eca-close" title="关闭">×</button></div>'
            + '  <div class="eca-batch-body">'
            + '    <div class="eca-batch-canvas-wrap" id="eca-batch-drop" title="点击选择图片（可重新上传）">'
            + '      <div class="eca-batch-hint" id="eca-batch-hint">点击此处上传表情合集大图（如 2×5、3×3 排列的多表情图，仅支持均匀网格）</div>'
            + '      <canvas id="eca-batch-canvas" style="display:none;"></canvas>'
            + '    </div>'
            + '    <div class="eca-batch-ctrl" id="eca-batch-ctrl" style="display:none;">'
            + '      <div class="eca-stepper" title="调整行列会重置映射">行 <button data-act="row-dec">−</button><b id="eca-batch-rows">2</b><button data-act="row-inc">＋</button></div>'
            + '      <div class="eca-stepper" title="调整行列会重置映射">列 <button data-act="col-dec">−</button><b id="eca-batch-cols">5</b><button data-act="col-inc">＋</button></div>'
            + '      <button id="eca-batch-auto">自动检测</button>'
            + '      <label class="eca-stepper">裁剪比例 <select id="eca-batch-ratio"></select></label>'
            + '    </div>'
            + '    <div class="eca-batch-mapping" id="eca-batch-mapping" style="display:none;"></div>'
            + '  </div>'
            + '  <div class="eca-footer">'
            + '    <span class="eca-detail-tip" id="eca-batch-tip"></span>'
            + '    <button class="eca-primary" id="eca-batch-save">保存全部头像</button>'
            + '  </div>'
            + '</div>';
        batchFileInput = doc.createElement('input');
        batchFileInput.type = 'file';
        batchFileInput.accept = 'image/*';
        batchFileInput.style.display = 'none';
        root.appendChild(batchFileInput);
        bindBatchEvents(root);
        return root;
    }

    function bindBatchEvents(root) {
        root.querySelector('.eca-close').addEventListener('click', closeBatchDialog);
        root.addEventListener('click', function (ev) {
            if (ev.target === root) { closeBatchDialog(); return; }
            if (ev.target.closest && ev.target.closest('#eca-batch-drop')) {
                batchFileInput.click();
                return;
            }
            const step = ev.target.closest ? ev.target.closest('.eca-batch-ctrl button[data-act]') : null;
            if (step) {
                const act = step.dataset.act;
                if (act === 'row-inc' && batchRows < 5) batchRows++;
                if (act === 'row-dec' && batchRows > 1) batchRows--;
                if (act === 'col-inc' && batchCols < 6) batchCols++;
                if (act === 'col-dec' && batchCols > 1) batchCols--;
                renderBatchAll();
                return;
            }
            if (ev.target.closest && ev.target.closest('#eca-batch-auto')) {
                if (batchImage) {
                    const detected = autoDetectGrid(batchImage);
                    batchRows = detected.rows;
                    batchCols = detected.cols;
                    renderBatchAll();
                }
                return;
            }
            if (ev.target.closest && ev.target.closest('#eca-batch-save')) {
                saveBatchFlow();
            }
        });
        batchFileInput.addEventListener('change', function () {
            const file = batchFileInput.files && batchFileInput.files[0];
            batchFileInput.value = '';
            if (file) loadBatchImageFromFile(file);
        });
        root.querySelector('#eca-batch-ratio').addEventListener('change', function (ev) {
            settings.batchCropRatio = ev.target.value;
            persistSettings();
            updateBatchTip();
        });
        root.querySelector('#eca-batch-mapping').addEventListener('change', function (ev) {
            const sel = ev.target;
            if (!sel.dataset || sel.dataset.index === undefined) return;
            const index = parseInt(sel.dataset.index, 10);
            batchMappings[index].emotion = sel.value;
            batchMappings[index].skip = !sel.value;
            sel.closest('.eca-bcell').classList.toggle('skipped', !sel.value);
            updateAllBatchSelectOptions();
            updateBatchTip();
        });
    }

    /** 调试桥：带图打开对话框（harness 与控制台排查用） */
    function openBatchDialogWithImage(character, dataUrl) {
        openBatchDialog(character);
        const img = new topWindow.Image();
        img.onload = function () { loadBatchImage(img); };
        img.src = dataUrl;
    }

    // ============================================
    // 调试 / 测试桥（控制台排查与 harness 种子用）
    // ============================================
    topWindow.EmoAvatar = {
        version: VERSION,
        emotions: EMOTIONS.slice(),
        /** 调试/harness 桥：直接向内存缓存塞头像（不落库） */
        seedAvatar(name, emotion, src) { avatarCache.set(name + '_' + emotion, src); },
        /** 调试/harness 桥：整体替换登记名单（不落 localStorage，但会同步重注提示词） */
        setCharacters(list) {
            groups = [{ id: makeGroupId(), name: '默认组', enabled: true, members: list.slice() }];
            rebuildCharacterIndex();
            applyInjection();
        },
        getCharacters() { return characters.slice(); },
        setEnabled: setEnabled,
        setSize: setSize,
        scanAll: scanAll,
        applyInjection: applyInjection,
        /* 存储层桥（面板与 harness 共用） */
        saveAvatar: saveAvatar,
        deleteAvatar: deleteAvatar,
        deleteCharacterAvatars: deleteCharacterAvatars,
        renameCharacterAvatars: renameCharacterAvatars,
        getAllAvatarRecords: getAllAvatarRecords,
        preloadAvatars: preloadAvatars,
        clearMemoryCache() {
            avatarCache.forEach(function (url) { revokeCacheUrl(url); });
            avatarCache.clear();
        },
        /* 登记操作桥（持久化） */
        setCharactersPersist(list) {
            groups = [{ id: makeGroupId(), name: '默认组', enabled: true, members: list.slice() }];
            rebuildCharacterIndex();
            persistCharacters();
            applyInjection();
        },
        addCharacter: addCharacter,
        removeCharacter: removeCharacter,
        renameCharacter: renameCharacter,
        uploadAvatarFile: uploadAvatarFile,
        matchEmotionFromName: matchEmotionFromName,
        /* 人物组桥 */
        getGroups() { return JSON.parse(JSON.stringify(groups)); },
        addGroup: addGroup,
        removeGroup: removeGroup,
        toggleGroup: toggleGroup,
        renameGroup: renameGroup,
        moveCharacterToGroup: moveCharacterToGroup,
        getInjectionCharacters: getInjectionCharacters,
        /* 面板桥 */
        openPanel: openPanel,
        closePanel: closePanel,
        /* 批量导入桥 */
        autoDetectGrid: autoDetectGrid,
        sliceGridCell: sliceGridCell,
        runBatchImport: runBatchImport,
        openBatchDialog: openBatchDialog,
        closeBatchDialog: closeBatchDialog,
        openBatchDialogWithImage: openBatchDialogWithImage,
    };

    // ============================================
    // 入口
    // ============================================
    function init() {
        loadState();
        injectStyles();
        applySizeVar();
        addMenuButton();
        hookEvents();
        applyInjection();
        scanAll();
        // 预热完成后重扫一次，让已有楼层换上真实头像
        preloadAvatars().then(scanAll);
    }
    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
