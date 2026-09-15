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
        + '#eca-panel{display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);align-items:center;justify-content:center;font-size:14px;font-family:system-ui,"Microsoft YaHei",sans-serif;}'
        + '#eca-panel .eca-modal{width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;background:#23262e;color:#e6e6e6;border:1px solid #3a3f4b;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);}'
        + '#eca-panel .eca-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #3a3f4b;font-weight:600;}'
        + '#eca-panel .eca-close{background:none;border:0;color:#999;font-size:20px;cursor:pointer;line-height:1;padding:0 4px;}'
        + '#eca-panel .eca-close:hover{color:#fff;}'
        + '#eca-panel .eca-body{display:flex;min-height:320px;overflow:hidden;}'
        + '#eca-panel .eca-side{width:170px;border-right:1px solid #3a3f4b;padding:10px;display:flex;flex-direction:column;gap:6px;overflow-y:auto;}'
        + '#eca-panel .eca-side-title{color:#8ab;font-size:12px;}'
        + '#eca-panel .eca-char-item{display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;cursor:pointer;background:#2a2e37;}'
        + '#eca-panel .eca-char-item:hover{background:#323744;}'
        + '#eca-panel .eca-char-item.active{background:#2d5f8a;}'
        + '#eca-panel .eca-char-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}'
        + '#eca-panel .eca-char-del{background:none;border:0;color:#c66;cursor:pointer;font-size:12px;padding:0 2px;}'
        + '#eca-panel .eca-add{margin-top:auto;padding:6px;border-radius:6px;border:1px dashed #555;background:none;color:#9bd;cursor:pointer;}'
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
        + '#eca-panel .eca-footer{display:flex;align-items:center;gap:18px;padding:10px 16px;border-top:1px solid #3a3f4b;flex-wrap:wrap;}'
        + '#eca-panel .eca-switch{display:flex;align-items:center;gap:6px;cursor:pointer;}'
        + '#eca-panel .eca-size{display:flex;align-items:center;gap:8px;}'
        + '#eca-panel .eca-size input[type=range]{width:140px;}'
        + '#eca-panel .eca-size-val{min-width:3.5em;color:#9bd;}'
        + '#eca-panel .eca-size-preview{margin-left:auto;display:flex;align-items:center;gap:8px;color:#889;}'
        + '.eca-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:#2d5f8a;color:#fff;padding:8px 18px;border-radius:6px;z-index:100000;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .4s;}'
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

    // ---------- 角色登记操作（面板与调试桥共用，全部持久化） ----------
    function addCharacter(name) {
        name = String(name || '').trim();
        if (!name || name.length > 30 || /[{}()]/.test(name)) return false;
        if (characters.indexOf(name) !== -1) return false;
        characters.push(name);
        persistCharacters();
        applyInjection();
        return true;
    }

    function removeCharacter(name) {
        const i = characters.indexOf(name);
        if (i === -1) return Promise.resolve(false);
        characters.splice(i, 1);
        persistCharacters();
        if (selectedCharacter === name) selectedCharacter = characters[0] || null;
        applyInjection();
        return deleteCharacterAvatars(name).then(function () { return true; });
    }

    function renameCharacter(oldName, newName) {
        newName = String(newName || '').trim();
        if (!newName || newName.length > 30 || /[{}()]/.test(newName)) return Promise.resolve(false);
        if (characters.indexOf(newName) !== -1) return Promise.resolve(false);
        const i = characters.indexOf(oldName);
        if (i === -1) return Promise.resolve(false);
        characters[i] = newName;
        persistCharacters();
        if (selectedCharacter === oldName) selectedCharacter = newName;
        applyInjection();
        return renameCharacterAvatars(oldName, newName).then(function () { return true; });
    }

    /** 单格上传入口：降采样（长边 256）后入库 */
    function uploadAvatarFile(character, emotion, file) {
        if (!EMOTION_SET.has(emotion)) return Promise.reject(new Error('非法情绪词：' + emotion));
        return downscaleBlob(file, 256).then(function (blob) {
            return saveAvatar(character, emotion, blob);
        });
    }

    // ---------- 面板 DOM ----------
    let panelEl = null;
    let selectedCharacter = null;
    let fileInputEl = null;

    function addMenuButton() {
        if (doc.getElementById('eca-menu-btn')) return;
        const mount = doc.getElementById('extensionsMenu') || doc.getElementById('top-bar');
        if (!mount) return;
        const btn = doc.createElement('div');
        btn.id = 'eca-menu-btn';
        btn.className = 'menu_button';
        btn.title = '情绪头像管理';
        const icon = doc.createElement('i');
        icon.className = 'fa-solid fa-face-smile';
        icon.setAttribute('aria-hidden', 'true');
        btn.appendChild(icon);
        btn.appendChild(doc.createTextNode(' 情绪头像'));
        btn.addEventListener('click', openPanel);
        mount.appendChild(btn);
    }

    function buildPanelSkeleton() {
        const root = doc.createElement('div');
        root.id = 'eca-panel';
        root.innerHTML = ''
            + '<div class="eca-modal">'
            + '  <div class="eca-header"><span>情绪头像管理</span><button class="eca-close" title="关闭">×</button></div>'
            + '  <div class="eca-body">'
            + '    <div class="eca-side">'
            + '      <div class="eca-side-title">已登记角色</div>'
            + '      <div id="eca-char-list"></div>'
            + '      <button class="eca-add" id="eca-add-char">＋ 新增角色</button>'
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
        fileInputEl.style.display = 'none';
        root.appendChild(fileInputEl);
        bindPanelEvents(root);
        return root;
    }

    function bindPanelEvents(root) {
        root.querySelector('.eca-close').addEventListener('click', closePanel);
        root.addEventListener('click', function (ev) {
            const target = ev.target;
            if (target.id === 'eca-add-char') { addCharacterFlow(); return; }
            const del = target.closest ? target.closest('.eca-char-del') : null;
            if (del) { removeCharacterFlow(del.dataset.name); return; }
            const rename = target.closest ? target.closest('#eca-rename-btn') : null;
            if (rename) { renameCharacterFlow(selectedCharacter); return; }
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
        fileInputEl.addEventListener('change', function () {
            const file = fileInputEl.files && fileInputEl.files[0];
            const emotion = fileInputEl.dataset.emotion;
            fileInputEl.value = '';
            if (!file || !emotion || !selectedCharacter) return;
            uploadAvatarFile(selectedCharacter, emotion, file)
                .then(function () {
                    renderPanel();
                    toast('已更新「' + selectedCharacter + '·' + emotion + '」');
                })
                .catch(function (e) { toast('上传失败：' + (e && e.message || e), true); });
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
        // 角色列表
        const listBox = panelEl.querySelector('#eca-char-list');
        listBox.innerHTML = characters.length
            ? characters.map(function (name) {
                return '<div class="eca-char-item' + (name === selectedCharacter ? ' active' : '') + '" data-name="' + escapeHtml(name) + '">'
                    + '<span class="eca-char-name">' + escapeHtml(name) + '</span>'
                    + '<button class="eca-char-del" data-name="' + escapeHtml(name) + '" title="删除角色及头像">✕</button>'
                    + '</div>';
            }).join('')
            : '<div class="eca-detail-empty" style="padding:12px 0;">暂无角色</div>';
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
                + '<button class="eca-mini-btn" id="eca-rename-btn">改名</button></div>'
                + '<div class="eca-detail-tip">点击格子上传 / 更换单张头像；十种情绪缺图时自动回落「默认」</div>'
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
        setCharactersPersist(list) { characters = list.slice(); persistCharacters(); applyInjection(); },
        addCharacter: addCharacter,
        removeCharacter: removeCharacter,
        renameCharacter: renameCharacter,
        uploadAvatarFile: uploadAvatarFile,
        /* 面板桥 */
        openPanel: openPanel,
        closePanel: closePanel,
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
