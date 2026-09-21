/**
 * 情绪头像 EmotionAvatar — SillyTavern 酒馆助手脚本
 *
 * AI 在角色对话的自然段前输出 {角色名(情绪)} 标签，本脚本在显示层把标签替换为行内头像：
 * - 不修改消息原文（chat[i].mes 永不触碰），卸载脚本即回到原始文本
 * - 提示词经 injectPrompts 以 system / in_chat / depth 0 注入（MiniMapStatus 早期同款通道）
 * - 固定十个情绪词：默认、微笑、愤怒、悲伤、惊讶、轻蔑、杀意、思考、大笑、害羞；另可按角色新增自定义情绪
 * - 一组头像可绑定多个姓名（别名），AI 输出任一姓名都渲染同一套头像
 * - 支持一张表情合集大图按网格切分批量导入
 */
(function () {
    'use strict';

    // ============================================
    // 常量定义
    // ============================================
    const SCRIPT_NAME = '情绪头像';
    const VERSION = '0.4.0';
    const DB_NAME = 'EmotionAvatarDB';
    const DB_VERSION = 1;
    const STORE_AVATARS = 'avatars';
    const TTS_DB_NAME = 'EmotionAvatarTtsDB';
    const TTS_DB_VERSION = 2;
    const TTS_STORE = 'audio';
    const TTS_CLONE_STORE = 'clones';
    const INJECT_ID = 'emoavatar-prompt';
    const LS_CHARACTERS = 'emoavatar_characters';
    const LS_SETTINGS = 'emoavatar_settings';
    const LS_ALIASES = 'emoavatar_aliases';
    const LS_TTS_VOICES = 'emoavatar_tts_voices';
    const LS_TTS_CONFIG = 'emoavatar_tts_config';
    /** 固定情绪词十个；顺序即批量导入网格的默认映射顺序。自定义情绪按角色独立（有图才算，见 getCustomEmotions） */
    const EMOTIONS = ['默认', '微笑', '愤怒', '悲伤', '惊讶', '轻蔑', '杀意', '思考', '大笑', '害羞'];
    const EMOTION_SET = new Set(EMOTIONS);
    /** 已知情绪全集（固定 + 出现过的自定义），随头像记录同步；供提示词罗列与文件名匹配 */
    let allEmotions = new Set(EMOTIONS);
    /** 自定义情绪名校验：1-8 字，不含花括号/圆括号/下划线（下划线会破坏 `角色_情绪` 主键切分） */
    function validateEmotionName(name) {
        const s = String(name || '').trim();
        return !!s && s.length <= 8 && !/[{}()_]/.test(s);
    }
    /** 标签匹配：{角色名(情绪)}；角色名 1-30 字（不含花括号/圆括号），情绪 1-8 字 */
    const TAG_RE = /\{([^{}()]{1,30})\(([^{}()]{1,8})\)\}/g;
    /** 头像显示高度默认值（em），面板可调 */
    const DEFAULT_SIZE = 2.5;
    const TTS_ENGINES = ['edge', 'minimax', 'doubao', 'mimo'];
    const EDGE_VOICES = [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓（女）', lang: '中文（普通话）', styles: ['general', 'assistant', 'chat', 'customerservice', 'newscast', 'affectionate', 'angry', 'calm', 'cheerful', 'disgruntled', 'fearful', 'gentle', 'lyrical', 'sad', 'serious', 'poetry-reading'] },
        { id: 'zh-CN-XiaoyiNeural', name: '晓伊（女）', lang: '中文（普通话）', styles: ['general', 'angry', 'disgruntled', 'affectionate', 'cheerful', 'fearful', 'gentle', 'sad', 'serious'] },
        { id: 'zh-CN-XiaochenNeural', name: '晓辰（女）', lang: '中文（普通话）', styles: ['general', 'livecommercial'] },
        { id: 'zh-CN-XiaohanNeural', name: '晓涵（女）', lang: '中文（普通话）', styles: ['general', 'calm', 'fearful', 'cheerful', 'disgruntled', 'serious', 'angry', 'sad', 'gentle', 'affectionate', 'embarrassed'] },
        { id: 'zh-CN-XiaomengNeural', name: '晓梦（女）', lang: '中文（普通话）', styles: ['general', 'chat'] },
        { id: 'zh-CN-XiaomoNeural', name: '晓墨（女）', lang: '中文（普通话）', styles: ['general', 'embarrassed', 'calm', 'fearful', 'cheerful', 'disgruntled', 'serious', 'angry', 'sad', 'depressed', 'affectionate', 'gentle', 'envious'] },
        { id: 'zh-CN-XiaoqiuNeural', name: '晓秋（女）', lang: '中文（普通话）', styles: ['general'] },
        { id: 'zh-CN-XiaoruiNeural', name: '晓睿（女）', lang: '中文（普通话）', styles: ['general', 'calm', 'fearful', 'angry', 'sad'] },
        { id: 'zh-CN-XiaoshuangNeural', name: '晓双（儿童·女）', lang: '中文（普通话）', styles: ['general', 'chat'] },
        { id: 'zh-CN-XiaoxuanNeural', name: '晓萱（女）', lang: '中文（普通话）', styles: ['general', 'calm', 'fearful', 'cheerful', 'disgruntled', 'serious', 'angry', 'gentle', 'depressed'] },
        { id: 'zh-CN-XiaoyanNeural', name: '晓颜（女）', lang: '中文（普通话）', styles: ['general'] },
        { id: 'zh-CN-XiaozhenNeural', name: '晓甄（女）', lang: '中文（普通话）', styles: ['general', 'angry', 'disgruntled', 'cheerful', 'fearful', 'sad', 'serious'] },
        { id: 'zh-CN-YunxiNeural', name: '云希（男）', lang: '中文（普通话）', styles: ['general', 'narration-relaxed', 'embarrassed', 'fearful', 'cheerful', 'disgruntled', 'serious', 'angry', 'sad', 'depressed', 'chat', 'assistant', 'newscast'] },
        { id: 'zh-CN-YunjianNeural', name: '云健（男）', lang: '中文（普通话）', styles: ['general', 'narration-relaxed', 'sports-commentary', 'sports-commentary-excited'] },
        { id: 'zh-CN-YunyangNeural', name: '云扬（男）', lang: '中文（普通话）', styles: ['general', 'customerservice', 'narration-professional', 'newscast-casual'] },
        { id: 'zh-CN-YunyeNeural', name: '云野（男）', lang: '中文（普通话）', styles: ['general', 'embarrassed', 'calm', 'fearful', 'cheerful', 'disgruntled', 'serious', 'angry', 'sad'] },
        { id: 'zh-CN-YunzeNeural', name: '云泽（男）', lang: '中文（普通话）', styles: ['general', 'calm', 'fearful', 'cheerful', 'disgruntled', 'serious', 'angry', 'sad', 'depressed', 'documentary-narration'] },
        { id: 'zh-CN-YunhaoNeural', name: '云皓（男）', lang: '中文（普通话）', styles: ['general', 'advertisement-upbeat'] },
        { id: 'zh-CN-YunfengNeural', name: '云枫（男）', lang: '中文（普通话）', styles: ['general', 'angry', 'disgruntled', 'cheerful', 'fearful', 'sad', 'serious'] },
        { id: 'zh-CN-YunxiaNeural', name: '云夏（儿童·男）', lang: '中文（普通话）', styles: ['general'] },
        { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（东北话·女）', lang: '中文（方言）', styles: ['general', 'angry', 'cheerful', 'sad'] },
        { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西话·女）', lang: '中文（方言）', styles: ['general', 'angry', 'cheerful', 'sad'] },
        { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（女）', lang: '中文（台湾）', styles: ['general'] },
        { id: 'zh-TW-HsiaoYuNeural', name: '曉雨（女）', lang: '中文（台湾）', styles: ['general'] },
        { id: 'zh-TW-YunJheNeural', name: '雲哲（男）', lang: '中文（台湾）', styles: ['general'] },
        { id: 'zh-HK-HiuGaaiNeural', name: '曉佳（女）', lang: '粤语', styles: ['general'] },
        { id: 'zh-HK-HiuMaanNeural', name: '曉曼（女）', lang: '粤语', styles: ['general'] },
        { id: 'zh-HK-WanLungNeural', name: '雲龍（男）', lang: '粤语', styles: ['general'] },
        { id: 'en-US-JennyNeural', name: 'Jenny', lang: '英语', styles: ['general', 'assistant', 'chat', 'customerservice', 'newscast', 'angry', 'cheerful', 'sad', 'excited', 'friendly', 'terrified', 'shouting', 'unfriendly', 'whispering', 'hopeful'] },
        { id: 'en-US-GuyNeural', name: 'Guy', lang: '英语', styles: ['general', 'newscast', 'angry', 'cheerful', 'sad', 'excited', 'friendly', 'terrified', 'shouting', 'unfriendly', 'whispering', 'hopeful'] },
        { id: 'en-US-AriaNeural', name: 'Aria', lang: '英语', styles: ['general', 'chat', 'customerservice', 'narration-professional', 'newscast-casual', 'newscast-formal', 'cheerful', 'empathetic', 'angry', 'sad', 'excited', 'friendly', 'terrified', 'shouting', 'unfriendly', 'whispering', 'hopeful'] },
        { id: 'ja-JP-NanamiNeural', name: '七海（女）', lang: '日语', styles: ['general', 'chat', 'customerservice', 'cheerful'] },
        { id: 'ja-JP-KeitaNeural', name: '圭太（男）', lang: '日语', styles: ['general'] },
        { id: 'ko-KR-SunHiNeural', name: 'SunHi（女）', lang: '韩语', styles: ['general', 'cheerful'] },
        { id: 'ko-KR-InJoonNeural', name: 'InJoon（男）', lang: '韩语', styles: ['general'] },
    ];
    /** MiMo（小米）预置音色：voice 字段直接透传给接口 */
    const MIMO_VOICES = [
        { id: 'mimo_default', name: 'MiMo · 默认' },
        { id: '冰糖', name: '冰糖（中文女）' },
        { id: '茉莉', name: '茉莉（中文女）' },
        { id: '苏打', name: '苏打（中文男）' },
        { id: '白桦', name: '白桦（中文男）' },
        { id: 'Mia', name: 'Mia（英文女）' },
        { id: 'Chloe', name: 'Chloe（英文女）' },
        { id: 'Milo', name: 'Milo（英文男）' },
        { id: 'Dean', name: 'Dean（英文男）' },
    ];
    const MIMO_FORMATS = ['wav', 'mp3'];
    /** 复刻音色在角色配置里的 voiceId 形态：clone:<id>；参考音频存在 IndexedDB，localStorage 只留元数据 */
    const MIMO_CLONE_PREFIX = 'clone:';
    const MIMO_CLONE_MAX_BYTES = 10 * 1024 * 1024;
    const EDGE_EMOTION_STYLES = {
        '默认': 'general', '微笑': 'cheerful', '愤怒': 'angry', '悲伤': 'sad', '惊讶': 'cheerful',
        '轻蔑': 'disgruntled', '杀意': 'serious', '思考': 'calm', '大笑': 'cheerful', '害羞': 'affectionate',
    };
    const MINIMAX_EMOTIONS = {
        '微笑': 'happy', '愤怒': 'angry', '悲伤': 'sad', '惊讶': 'surprised', '轻蔑': 'disgusted',
        '杀意': 'angry', '思考': 'calm', '大笑': 'happy',
    };
    /** Edge TTS 公开代理池（移植自 st-immersive-sound）。proxyUrl 留空时自动探活择优，失败逐个轮换 */
    const EDGE_PROXY_SERVERS = [
        // HTTPS 代理能避开 mixed-content，HTTPS 页面下只有这些可用
        { name: 'SkyBook', url: 'https://skybook.qzz.io/tts' },
        { name: '德国法兰克福', url: 'http://5.45.99.149:8075/tts' },
        { name: '美国洛杉矶', url: 'http://64.112.42.45:9080/tts' },
        { name: '中国', url: 'http://t.leftsite.cn/tts' },
        { name: '中国杭州', url: 'http://60.205.243.148:8080/tts' },
        { name: '韩国首尔', url: 'http://193.122.107.44:9090/tts' },
        { name: '美国德克萨斯州', url: 'http://104.214.168.83:8080/tts' },
        { name: '美国纽约', url: 'http://74.48.40.244:8010/tts' },
        { name: '美国加利福尼亚州', url: 'http://47.79.92.215:18080/tts' },
        { name: '中国湖北', url: 'http://171.113.113.119:8085/tts' },
        { name: '中国江苏', url: 'http://47.119.125.172:8080/tts' },
        { name: '中国广东', url: 'http://36.248.181.23:22335/tts' },
        { name: '中国上海', url: 'http://124.71.164.73:8085/tts' },
        { name: '荷兰阿姆斯特丹', url: 'http://146.56.188.115:8080/tts' },
        { name: '日本东京', url: 'http://180.114.35.250:1080/tts' },
        { name: '巴西圣保罗', url: 'http://190.92.218.92:8080/tts' },
    ];
    /** 曾是默认值但已下线的代理（返回 404 且无 CORS 头），命中时迁移为自动选择 */
    const LEGACY_EDGE_PROXIES = ['https://skybook.qzz.io/tts'];
    const EDGE_PING_TIMEOUT = 5000;
    const EDGE_PING_TTL = 30 * 60 * 1000;
    const DEFAULT_TTS_CONFIG = {
        edge: { proxyUrl: '', rate: 0, pitch: 0, volume: 100, persist: false },
        minimax: { apiKey: '', platform: 'cn', model: 'speech-2.8-hd', sampleRate: 32000, persist: true },
        doubao: { appId: '', accessKey: '', uid: '1222356', sampleRate: 24000, persist: true },
        mimo: { apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-tts', format: 'wav', cloneVoices: [], persist: true },
        cacheDays: 30, cacheMaxEntries: 200, cacheMaxMb: 512,
    };
    let voiceMap = {};
    let ttsConfig = JSON.parse(JSON.stringify(DEFAULT_TTS_CONFIG));
    let ttsDbPromise = null;
    const ttsMemoryCache = new Map();
    const audioEntries = new Map();
    let audioEntrySeq = 1;
    let currentAudio = null;
    let currentAudioUrl = null;
    let currentAudioButton = null;
    let currentAudioState = null;
    let audioRequestSeq = 0;

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
    // 打标埋点（排障用）：默认关闭，只记录判定链，不改变任何行为
    // 打开：EmoAvatar.setDebug(true)；取日志：EmoAvatar.debugLogs()（环形缓冲，
    // 控制台抓不到 iframe 日志时用）；状态快照：EmoAvatar.debugStatus()
    // ============================================
    const LS_DEBUG = 'emoavatar_debug';
    const DBG_BUFFER_MAX = 500;
    let debugOn = false;
    try { debugOn = topWindow.localStorage.getItem(LS_DEBUG) === '1'; } catch (e) { debugOn = false; }
    let dbgReplaced = 0;
    let dbgSplit = 0;
    const dbgBuffer = [];
    const dbgCounts = {};
    const dbgStartedAt = Date.now();

    function dbg() {
        if (!debugOn) return;
        try {
            const line = '[ECA-DBG +' + (Date.now() - dbgStartedAt) + 'ms] ' + Array.prototype.join.call(arguments, ' ');
            console.log(line);
            dbgBuffer.push(line);
            if (dbgBuffer.length > DBG_BUFFER_MAX) dbgBuffer.shift();
        } catch (e) { /* 埋点异常不得干扰主流程 */ }
    }

    /** 高频埋点节流：前 5 次 + 每 20 次各记一条，避免逐 token 风暴刷屏 */
    function dbgHot(key, message) {
        if (!debugOn) return;
        const n = (dbgCounts[key] || 0) + 1;
        dbgCounts[key] = n;
        if (n <= 5 || n % 20 === 0) dbg(message + '（该状态第 ' + n + ' 次）');
    }

    /** 计数窗口复位：生成开始/完成时调用，让每轮生成的埋点从 1 开始计 */
    function dbgReset() {
        for (let i = 0; i < arguments.length; i++) delete dbgCounts[arguments[i]];
    }

    function dbgNow() {
        return (topWindow.performance && topWindow.performance.now) ? topWindow.performance.now() : Date.now();
    }

    // ============================================
    // 设置与角色登记表（localStorage）
    // groups: [{id, name, enabled, members:[角色名]}]；characters 为拍平索引（isRegistered 等零改动）
    // 组开关只控制提示词注入（角色卡切换用），不影响已渲染头像与素材库
    // ============================================
    let settings = { enabled: true, size: DEFAULT_SIZE, batchCropRatio: '1:1', topAlign: false, delayRender: false, ttsEnabled: true };
    let characters = [];
    let groups = [];
    let groupSeq = 1;
    /** 别名表：主名 → [其它姓名]；{别名(情绪)} 与 {主名(情绪)} 渲染同一套头像 */
    let aliases = {};
    let aliasToPrimary = {};
    const LS_GROUPS = 'emoavatar_groups';

    function makeGroupId() { return 'g' + Date.now().toString(36) + (groupSeq++); }

    /** 由 groups 重建拍平索引与别名反向索引（任何组结构/别名变更后调用） */
    function rebuildCharacterIndex() {
        characters = [];
        groups.forEach(function (g) {
            Array.prototype.push.apply(characters, g.members);
        });
        aliasToPrimary = {};
        characters.forEach(function (primary) {
            (aliases[primary] || []).forEach(function (alias) {
                if (characters.indexOf(alias) === -1) aliasToPrimary[alias] = primary;
            });
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
        try {
            const storedAliases = JSON.parse(topWindow.localStorage.getItem(LS_ALIASES));
            if (storedAliases && typeof storedAliases === 'object') {
                Object.keys(storedAliases).forEach(function (key) {
                    if (Array.isArray(storedAliases[key])) {
                        aliases[key] = storedAliases[key].filter(function (a) { return typeof a === 'string' && a; });
                    }
                });
            }
        } catch (e) { /* 保持空 */ }
        rebuildCharacterIndex();
        try {
            const s = JSON.parse(topWindow.localStorage.getItem(LS_SETTINGS));
            if (s && typeof s === 'object') Object.assign(settings, s);
        } catch (e) { /* 保持默认 */ }
        loadTtsState();
    }

    function persistCharacters() {
        try {
            topWindow.localStorage.setItem(LS_GROUPS, JSON.stringify(groups));
            // 兼容旧字段同步写一份扁平表（回滚旧版脚本不丢人）
            topWindow.localStorage.setItem(LS_CHARACTERS, JSON.stringify(characters));
        } catch (e) { /* 存储失败不阻塞 */ }
    }
    function persistSettings() {
        try { topWindow.localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* 保持默认 */ }
    }
    function persistAliases() {
        try { topWindow.localStorage.setItem(LS_ALIASES, JSON.stringify(aliases)); } catch (e) { /* 存储失败不阻塞 */ }
    }

    function mergeTtsConfig(stored) {
        const next = JSON.parse(JSON.stringify(DEFAULT_TTS_CONFIG));
        if (!stored || typeof stored !== 'object') return next;
        ['edge', 'minimax', 'doubao', 'mimo'].forEach(function (engine) {
            if (stored[engine] && typeof stored[engine] === 'object') Object.assign(next[engine], stored[engine]);
        });
        ['cacheDays', 'cacheMaxEntries', 'cacheMaxMb'].forEach(function (key) {
            if (stored[key] !== undefined) next[key] = Number(stored[key]) || next[key];
        });
        if (LEGACY_EDGE_PROXIES.indexOf(String(next.edge.proxyUrl || '').trim()) !== -1) next.edge.proxyUrl = '';
        return next;
    }

    function loadTtsState() {
        try {
            const storedMap = JSON.parse(topWindow.localStorage.getItem(LS_TTS_VOICES));
            if (storedMap && typeof storedMap === 'object') voiceMap = storedMap;
        } catch (e) { voiceMap = {}; }
        try {
            ttsConfig = mergeTtsConfig(JSON.parse(topWindow.localStorage.getItem(LS_TTS_CONFIG)));
        } catch (e) { ttsConfig = mergeTtsConfig(null); }
    }

    function persistVoiceMap() {
        try { topWindow.localStorage.setItem(LS_TTS_VOICES, JSON.stringify(voiceMap)); } catch (e) { /* 存储失败不阻塞 */ }
    }

    function persistTtsConfig() {
        try { topWindow.localStorage.setItem(LS_TTS_CONFIG, JSON.stringify(ttsConfig)); } catch (e) { /* 存储失败不阻塞 */ }
    }

    function getVoiceConfig(displayName) {
        const primary = resolveName(displayName) || displayName;
        const value = voiceMap[primary];
        return value && typeof value === 'object' ? value : null;
    }

    function setVoiceConfig(name, value) {
        const primary = resolveName(name) || name;
        if (!value || !value.engine || !value.voiceId) delete voiceMap[primary];
        else {
            const entry = { engine: value.engine, voiceId: String(value.voiceId).trim(), resourceId: String(value.resourceId || '').trim() };
            // 角色级语速/音调：留空即沿用音频设置里的全局默认
            if (String(value.rate === undefined || value.rate === null ? '' : value.rate).trim() !== '') entry.rate = Number(value.rate);
            if (String(value.pitch === undefined || value.pitch === null ? '' : value.pitch).trim() !== '') entry.pitch = Number(value.pitch);
            voiceMap[primary] = entry;
        }
        persistVoiceMap();
        if (panelEl) renderPanel();
    }

    // ============================================
    // TTS 持久化缓存与三引擎合成
    // ============================================
    function openTtsDb() {
        if (ttsDbPromise) return ttsDbPromise;
        ttsDbPromise = new Promise(function (resolve, reject) {
            const request = indexedDB.open(TTS_DB_NAME, TTS_DB_VERSION);
            request.onupgradeneeded = function () {
                const db = request.result;
                if (!db.objectStoreNames.contains(TTS_STORE)) {
                    db.createObjectStore(TTS_STORE, { keyPath: 'key' }).createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!db.objectStoreNames.contains(TTS_CLONE_STORE)) {
                    db.createObjectStore(TTS_CLONE_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
        });
        return ttsDbPromise;
    }

    function ttsStore(mode, name) {
        const storeName = name || TTS_STORE;
        return openTtsDb().then(function (db) { return db.transaction(storeName, mode).objectStore(storeName); });
    }

    function ttsGet(key) {
        return ttsStore('readonly').then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.get(key);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function ttsPut(record) {
        return ttsStore('readwrite').then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.put(record);
                req.onsuccess = function () { resolve(record); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function ttsGetAll() {
        return ttsStore('readonly').then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.getAll();
                req.onsuccess = function () { resolve(req.result || []); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function ttsDelete(key) {
        return ttsStore('readwrite').then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.delete(key);
                req.onsuccess = function () { resolve(); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function ttsClear() {
        return ttsStore('readwrite').then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.clear();
                req.onsuccess = function () { resolve(); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function ttsKeyPart(value) {
        return encodeURIComponent(String(value === undefined || value === null ? '' : value));
    }

    /* 复刻参考音频与语音缓存共用同一个库，但分开存放：清空语音缓存不应删掉复刻音色 */
    function cloneAudioGet(key) {
        return ttsStore('readonly', TTS_CLONE_STORE).then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.get(key);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function cloneAudioPut(record) {
        return ttsStore('readwrite', TTS_CLONE_STORE).then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.put(record);
                req.onsuccess = function () { resolve(record); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function cloneAudioDelete(key) {
        return ttsStore('readwrite', TTS_CLONE_STORE).then(function (store) {
            return new Promise(function (resolve, reject) {
                const req = store.delete(key);
                req.onsuccess = function () { resolve(); };
                req.onerror = function () { reject(req.error); };
            });
        });
    }

    function buildTtsKey(request) {
        return [request.engine, request.platform, request.model, request.resourceId, request.voiceId, request.text, request.emotionParam || '', request.style || '', request.contextText || '', request.rate, request.pitch, request.volume].map(ttsKeyPart).join('|');
    }

    function getEdgeVoice(id) {
        return EDGE_VOICES.filter(function (voice) { return voice.id === id; })[0] || null;
    }

    function edgeStyleFor(emotion, voiceId) {
        const voice = getEdgeVoice(voiceId);
        const candidate = EDGE_EMOTION_STYLES[emotion] || 'general';
        return voice && voice.styles.indexOf(candidate) !== -1 ? candidate : 'general';
    }

    function minimaxEmotionFor(emotion) {
        return MINIMAX_EMOTIONS[emotion] || '';
    }

    function buildEmotionRequest(engine, emotion, voiceId) {
        if (!emotion || emotion === '默认') return {};
        if (engine === 'edge') return { style: edgeStyleFor(emotion, voiceId) };
        if (engine === 'minimax') return { emotionParam: minimaxEmotionFor(emotion) };
        return { contextText: '请用“' + emotion + '”的语气朗读这段话。' };
    }

    function fetchWithTimeout(url, options, timeout) {
        const controller = typeof topWindow.AbortController === 'function' ? new topWindow.AbortController() : null;
        const opts = Object.assign({}, options || {});
        if (controller) opts.signal = controller.signal;
        let timer = null;
        const promise = topWindow.fetch(url, opts);
        if (!controller) return promise;
        return Promise.race([
            promise,
            new Promise(function (_, reject) { timer = setTimeout(function () { controller.abort(); reject(new Error('请求超时')); }, timeout || 15000); }),
        ]).then(function (result) { clearTimeout(timer); return result; }, function (error) { clearTimeout(timer); throw error; });
    }

    function ensureAudioResponse(response) {
        if (!response || !response.ok) throw new Error('服务返回 HTTP ' + (response && response.status || '未知'));
        const type = response.headers && response.headers.get ? response.headers.get('content-type') : '';
        if (type && type.indexOf('audio') === -1 && type.indexOf('octet-stream') === -1) throw new Error('响应不是音频');
        return response.blob();
    }

    // ============================================
    // Edge 代理池：留空 proxyUrl 时自动探活择优，失败逐个轮换
    // ============================================
    let edgeServers = [];
    let edgePingPromise = null;

    /** HTTPS 页面下 HTTP 代理会被 mixed-content 拦掉，探活前先剔除，免得白等超时 */
    function edgeProxyCandidates() {
        const isHttps = String(topWindow.location && topWindow.location.protocol) === 'https:';
        return EDGE_PROXY_SERVERS.filter(function (server) { return !isHttps || server.url.indexOf('https://') === 0; });
    }

    function restoreEdgePingCache() {
        const cache = ttsConfig.edge && ttsConfig.edge.pingCache;
        if (!cache || !Array.isArray(cache.servers) || !cache.pingTime) return 0;
        if (Date.now() - Number(cache.pingTime) > EDGE_PING_TTL) return 0;
        edgeServers = cache.servers.filter(function (s) { return s && s.url; }).map(function (s) {
            return { name: String(s.name || s.url), url: String(s.url), latency: Number(s.latency) || 0 };
        });
        return edgeServers.length;
    }

    function persistEdgePingCache() {
        ttsConfig.edge.pingCache = {
            servers: edgeServers.map(function (s) { return { name: s.name, url: s.url, latency: s.latency }; }),
            pingTime: Date.now(),
        };
        persistTtsConfig();
    }

    function markEdgeServerFailed(server) {
        const index = edgeServers.findIndex(function (s) { return s.url === server.url; });
        if (index === -1) return;
        edgeServers.splice(index, 1);
        persistEdgePingCache();
    }

    /**
     * 并发探活全部候选代理，返回按延迟升序的可用列表。
     * 只认 response.ok：这一条同时滤掉 404（端点已下线）与缺 CORS 头被浏览器拦截两类死法。
     */
    function pingEdgeServers(force) {
        if (edgePingPromise) return edgePingPromise;
        if (!force && edgeServers.length) return Promise.resolve(edgeServers.slice());
        if (!force && restoreEdgePingCache()) return Promise.resolve(edgeServers.slice());
        const probeCfg = { rate: 0, pitch: 0, volume: 100 };
        edgePingPromise = Promise.all(edgeProxyCandidates().map(function (server) {
            const start = dbgNow();
            return fetchWithTimeout(buildEdgeUrl(server.url, '测试', 'zh-CN-XiaoxiaoNeural', probeCfg, 'general'), { headers: { Accept: 'audio/*' } }, EDGE_PING_TIMEOUT)
                .then(function (response) {
                    return response && response.ok ? { name: server.name, url: server.url, latency: dbgNow() - start } : null;
                })
                .catch(function () { return null; });
        })).then(function (results) {
            edgeServers = results.filter(Boolean).sort(function (a, b) { return a.latency - b.latency; });
            persistEdgePingCache();
            edgePingPromise = null;
            return edgeServers.slice();
        });
        return edgePingPromise;
    }

    function buildEdgeUrl(baseUrl, text, voiceId, cfg, style) {
        const params = new URLSearchParams();
        params.set('t', text); params.set('v', voiceId);
        params.set('r', String(Number(cfg.rate) || 0)); params.set('p', String(Number(cfg.pitch) || 0));
        params.set('s', style || 'general'); params.set('vol', String(Number(cfg.volume) || 100));
        return baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + params.toString();
    }

    /** fetch 的网络层失败（CORS 拦截 / 连接不通）在浏览器里都是同一句 "Failed to fetch"，这里换成能照着做的中文 */
    function isFetchBlocked(error) {
        return /Failed to fetch|NetworkError|Load failed/i.test(String((error && error.message) || error || ''));
    }

    /** Edge 合成参数：对象上带角色级取值时优先，缺失则回落到音频设置里的全局默认。对 request 与 voice 配置都适用 */
    function edgeSpeechParams(source) {
        const cfg = ttsConfig.edge;
        function pick(value, fallback) {
            const n = Number(value);
            return value === undefined || value === null || value === '' || isNaN(n) ? fallback : n;
        }
        return {
            rate: pick(source && source.rate, Number(cfg.rate) || 0),
            pitch: pick(source && source.pitch, Number(cfg.pitch) || 0),
            volume: pick(source && source.volume, Number(cfg.volume) || 100),
        };
    }

    function synthesizeEdgeVia(serverUrl, label, text, request) {
        return fetchWithTimeout(buildEdgeUrl(serverUrl, text, request.voiceId, edgeSpeechParams(request), request.style), { headers: { Accept: 'audio/*' } }, 15000)
            .then(ensureAudioResponse)
            .then(function (blob) { return { blob: blob, mime: blob.type || 'audio/mpeg', server: label }; })
            .catch(function (error) {
                if (!isFetchBlocked(error)) throw error;
                throw new Error('代理「' + label + '」无法访问（已下线或被浏览器拦截）');
            });
    }

    /** 自定义地址 = 固定单地址、不轮换；留空 = 自动代理池 */
    function synthesizeEdge(text, request) {
        const custom = String(ttsConfig.edge.proxyUrl || '').trim();
        if (!request.voiceId) return Promise.reject(new Error('Edge 音色未配置'));
        if (custom) return synthesizeEdgeVia(custom, custom, text, request);

        const tried = {};
        let lastError = null;
        function tryList(servers) {
            const server = servers.filter(function (s) { return !tried[s.url]; })[0];
            if (!server) return Promise.resolve(null);
            tried[server.url] = true;
            return synthesizeEdgeVia(server.url, server.name, text, request).catch(function (error) {
                lastError = error;
                markEdgeServerFailed(server);
                return tryList(servers);
            });
        }
        return pingEdgeServers(false).then(tryList).then(function (result) {
            if (result) return result;
            // 池子试完了 → 强制重探一次，只多试这一轮，避免死循环
            return pingEdgeServers(true).then(tryList).then(function (retried) {
                if (retried) return retried;
                if (lastError) console.warn('[' + SCRIPT_NAME + '] Edge 代理全部失败，最后一个错误：', lastError);
                throw new Error('Edge 代理全部不可用，请在音频设置里点「检测代理」后重试');
            });
        });
    }

    function hexToBlob(hex, mime) {
        const clean = String(hex || '').replace(/^0x/, '');
        const bytes = new Uint8Array(Math.floor(clean.length / 2));
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
        return new Blob([bytes], { type: mime || 'audio/mpeg' });
    }

    function synthesizeMinimax(text, request) {
        const cfg = ttsConfig.minimax;
        const keys = String(cfg.apiKey || '').split(/[\n,，]+/).map(function (x) { return x.trim(); }).filter(Boolean);
        if (!keys.length) return Promise.reject(new Error('MiniMax API Key 未配置'));
        const base = cfg.platform === 'io' ? 'https://api.minimax.io/v1' : 'https://api.minimaxi.com/v1';
        const body = {
            model: cfg.model || 'speech-2.8-hd', text: text, stream: false,
            voice_setting: { voice_id: request.voiceId, speed: 1, vol: 1, pitch: 0 },
            audio_setting: { format: 'mp3', sample_rate: Number(cfg.sampleRate) || 32000, channel: 1, bitrate: 128000 },
            output_format: 'hex',
        };
        if (request.emotionParam) body.voice_setting.emotion = request.emotionParam;
        let index = 0;
        function attempt() {
            const key = keys[index++ % keys.length];
            return fetchWithTimeout(base + '/t2a_v2', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 30000)
                .then(function (response) {
                    if (!response.ok) throw new Error('MiniMax HTTP ' + response.status);
                    return response.json();
                }).then(function (data) {
                    if (!data || !data.base_resp || data.base_resp.status_code !== 0 || !data.data || !data.data.audio) throw new Error((data && data.base_resp && data.base_resp.status_msg) || 'MiniMax 合成失败');
                    const audio = data.data.audio;
                    const blob = typeof audio === 'string' && /^[0-9a-f]+$/i.test(audio) ? hexToBlob(audio, 'audio/mpeg') : null;
                    if (!blob) throw new Error('MiniMax 未返回可用音频');
                    return { blob: blob, mime: blob.type };
                });
        }
        return attempt();
    }

    function base64ToBytes(value) {
        const binary = topWindow.atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function synthesizeDoubao(text, request) {
        const cfg = ttsConfig.doubao;
        if (!cfg.appId || !cfg.accessKey || !request.voiceId || !request.resourceId) return Promise.reject(new Error('豆包 App ID、Access Key、音色和 Resource ID 均需配置'));
        const payload = {
            user: { uid: cfg.uid || '1222356' },
            req_params: {
                text: text, speaker: request.voiceId,
                audio_params: { format: 'mp3', sample_rate: Number(cfg.sampleRate) || 24000 },
                additions: JSON.stringify({ context_texts: request.contextText ? [request.contextText] : [] }),
            },
        };
        return fetchWithTimeout('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
            method: 'POST',
            headers: { 'X-Api-App-Key': cfg.appId, 'X-Api-Access-Key': cfg.accessKey, 'X-Api-Resource-Id': request.resourceId, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }, 30000).then(function (response) {
            if (!response.ok) throw new Error('豆包 HTTP ' + response.status);
            return response.text();
        }).then(function (raw) {
            const chunks = [];
            raw.split(/\r?\n/).forEach(function (line) {
                if (!line.trim()) return;
                let item;
                try { item = JSON.parse(line); } catch (e) { return; }
                if (item.code && item.code !== 0 && item.code !== 20000000) throw new Error(item.message || '豆包合成失败');
                if (item.data) chunks.push(base64ToBytes(item.data));
            });
            if (!chunks.length) throw new Error('豆包未返回可用音频');
            const blob = new Blob(chunks, { type: 'audio/mpeg' });
            return { blob: blob, mime: blob.type };
        });
    }

    // ── MiMo 复刻音色：参考音频存 IndexedDB，localStorage 只留元数据 ──
    function getMimoClones() {
        const list = ttsConfig.mimo.cloneVoices;
        return Array.isArray(list) ? list : [];
    }

    function persistMimoClones(list) {
        ttsConfig.mimo.cloneVoices = list;
        persistTtsConfig();
    }

    function makeMimoCloneId() {
        return 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /** 新增复刻音色；base64 为不含 data: 前缀的纯 base64 */
    function addMimoCloneVoice(input) {
        const nickname = String((input && input.nickname) || '').trim();
        const b64 = String((input && input.base64) || '');
        if (!nickname) return Promise.reject(new Error('请填写复刻音色昵称'));
        if (!b64) return Promise.reject(new Error('请选择参考音频文件'));
        const sizeBytes = Number((input && input.sizeBytes) || 0);
        if (sizeBytes > MIMO_CLONE_MAX_BYTES) return Promise.reject(new Error('参考音频超过 10 MB'));
        const id = makeMimoCloneId();
        const mime = String((input && input.mime) || 'audio/mpeg');
        return cloneAudioPut({ key: 'mimo_audio_' + id, b64: b64, mime: mime, createdAt: Date.now() }).then(function () {
            persistMimoClones(getMimoClones().concat([{ id: id, nickname: nickname, mime: mime, sizeBytes: sizeBytes, createdAt: Date.now() }]));
            return id;
        });
    }

    function deleteMimoCloneVoice(id) {
        const list = getMimoClones();
        if (!list.some(function (v) { return v.id === id; })) return Promise.resolve(false);
        persistMimoClones(list.filter(function (v) { return v.id !== id; }));
        return cloneAudioDelete('mimo_audio_' + id).then(function () { return true; }, function () { return true; });
    }

    /** 把 voiceId 解析成 MiMo 的 model + voice；复刻音色需读回参考音频拼 data URL，故为异步 */
    function resolveMimoVoice(voiceId) {
        const raw = String(voiceId || '').trim();
        if (raw.indexOf(MIMO_CLONE_PREFIX) !== 0) {
            return Promise.resolve({ model: ttsConfig.mimo.model || 'mimo-v2.5-tts', voice: raw || 'mimo_default' });
        }
        const id = raw.slice(MIMO_CLONE_PREFIX.length);
        const entry = getMimoClones().filter(function (v) { return v.id === id; })[0];
        if (!entry) return Promise.reject(new Error('复刻音色已不存在，请在音频设置里重新添加'));
        return cloneAudioGet('mimo_audio_' + id).then(function (record) {
            if (!record || !record.b64) throw new Error('复刻音色「' + entry.nickname + '」的参考音频已丢失，请重新添加');
            return { model: 'mimo-v2.5-tts-voiceclone', voice: 'data:' + (record.mime || 'audio/mpeg') + ';base64,' + record.b64 };
        });
    }

    /** MiMo（小米）走 OpenAI 风格 /chat/completions，音频以 base64 放在 choices[0].message.audio */
    function synthesizeMimo(text, request) {
        const cfg = ttsConfig.mimo;
        const key = String(cfg.apiKey || '').split(/[\n,，]+/).map(function (x) { return x.trim(); }).filter(Boolean)[0] || '';
        if (!key) return Promise.reject(new Error('MiMo API Key 未配置'));
        const format = MIMO_FORMATS.indexOf(cfg.format) === -1 ? 'wav' : cfg.format;
        const base = String(cfg.baseUrl || 'https://api.xiaomimimo.com/v1').trim().replace(/\/+$/, '');
        const messages = [];
        if (request.contextText) messages.push({ role: 'user', content: request.contextText });
        messages.push({ role: 'assistant', content: text });
        return resolveMimoVoice(request.voiceId).then(function (resolved) {
            const body = { model: resolved.model, messages: messages, audio: { format: format, voice: resolved.voice } };
            return fetchWithTimeout(base + '/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'api-key': key, Authorization: 'Bearer ' + key },
                body: JSON.stringify(body),
            }, 30000);
        }).then(function (response) {
            if (!response.ok) throw new Error('MiMo HTTP ' + response.status);
            return response.json();
        }).then(function (data) {
            const choice = data && data.choices && data.choices[0];
            const message = choice && choice.message;
            if (String(choice && choice.finish_reason || '') === 'content_filter') {
                throw new Error('MiMo 内容过滤拦截：' + String(message && message.content || '').slice(0, 120));
            }
            if (!message || !message.audio || !message.audio.data) {
                throw new Error((data && data.error && data.error.message) || 'MiMo 未返回音频数据');
            }
            const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/wav';
            return { blob: new Blob([base64ToBytes(message.audio.data)], { type: mime }), mime: mime };
        });
    }

    function synthesizeTts(text, request) {
        if (request.engine === 'edge') return synthesizeEdge(text, request);
        if (request.engine === 'minimax') return synthesizeMinimax(text, request);
        if (request.engine === 'doubao') return synthesizeDoubao(text, request);
        if (request.engine === 'mimo') return synthesizeMimo(text, request);
        return Promise.reject(new Error('未知语音引擎'));
    }

    function shouldPersist(engine) { return !!(ttsConfig[engine] && ttsConfig[engine].persist); }

    function loadPersistentTts(key) {
        if (!shouldPersist(key.split('|')[0])) return Promise.resolve(null);
        return ttsGet(key).catch(function () { return null; });
    }

    function savePersistentTts(record) {
        if (!shouldPersist(record.engine)) return Promise.resolve();
        return ttsPut(record).then(function () { return pruneTtsCache(); }).catch(function (e) { toast('语音缓存写入失败：' + (e.message || e), true); });
    }

    function pruneTtsCache() {
        return ttsGetAll().then(function (records) {
            const now = Date.now();
            const maxAge = Math.max(1, Number(ttsConfig.cacheDays) || 30) * 86400000;
            const maxEntries = Math.max(1, Number(ttsConfig.cacheMaxEntries) || 200);
            const maxBytes = Math.max(1, Number(ttsConfig.cacheMaxMb) || 512) * 1024 * 1024;
            const remove = records.filter(function (r) { return now - r.createdAt > maxAge; });
            let kept = records.filter(function (r) { return remove.indexOf(r) === -1; }).sort(function (a, b) { return b.createdAt - a.createdAt; });
            let total = kept.reduce(function (sum, r) { return sum + (r.size || r.blob.size || 0); }, 0);
            while (kept.length > maxEntries || total > maxBytes) {
                const old = kept.pop();
                if (!old) break;
                total -= old.size || old.blob.size || 0;
                remove.push(old);
            }
            return Promise.all(remove.map(function (r) { return ttsDelete(r.key); }));
        }).catch(function () { return undefined; });
    }

    /** 取音频：内存 → 持久化 → 真正合成；命中任一层都不再消耗合成额度 */
    function getOrCreateAudio(text, request) {
        const key = buildTtsKey(request);
        if (ttsMemoryCache.has(key)) {
            const hit = ttsMemoryCache.get(key);
            return Promise.resolve({ key: key, blob: hit.blob, mime: hit.mime, cached: true });
        }
        return loadPersistentTts(key).then(function (record) {
            if (record) {
                ttsMemoryCache.set(key, { blob: record.blob, mime: record.mime });
                return { key: key, blob: record.blob, mime: record.mime, cached: true };
            }
            return synthesizeTts(text, request).then(function (result) {
                ttsMemoryCache.set(key, result);
                const record = {
                    key: key, engine: request.engine, platform: request.platform || '', model: request.model || '',
                    resourceId: request.resourceId || '', voiceId: request.voiceId, text: text,
                    emotion: request.emotion || '', emotionParam: request.emotionParam || '', contextText: request.contextText || '',
                    mime: result.mime, blob: result.blob, size: result.blob.size, createdAt: Date.now(),
                };
                return savePersistentTts(record).then(function () {
                    return { key: key, blob: result.blob, mime: result.mime, cached: false };
                });
            });
        });
    }

    function extractQuotedText(text) {
        const pairs = { '“': '”', '"': '"', '「': '」', '『': '』', '«': '»' };
        const closers = new Set(['”', '」', '』', '»']);
        const source = String(text || '');
        const parts = [];
        let start = -1;
        let close = '';
        let buffer = '';
        for (let i = 0; i < source.length; i++) {
            const ch = source[i];
            if (start < 0) {
                if (pairs[ch]) { start = i; close = pairs[ch]; buffer = ''; }
                continue;
            }
            if (ch === close) {
                const value = buffer.trim();
                if (value) parts.push(value);
                start = -1; close = ''; buffer = '';
            } else {
                // 外层双引号中的单引号与其它字符均保留，不改变状态机。
                buffer += ch;
            }
        }
        return parts;
    }

    function textFromRange(root) {
        if (!root) return '';
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const chunks = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (node.parentElement && node.parentElement.closest('.eca-avatar, .eca-audio-overlay')) continue;
            chunks.push(node.nodeValue || '');
        }
        return chunks.join('');
    }

    function getAvatarSpeech(avatar) {
        if (!avatar || avatar.classList.contains('eca-placeholder')) return null;
        const mes = avatar.closest('.mes');
        if (!mes || mes.classList.contains('is_user')) return null;
        const paragraph = avatar.closest('.eca-p');
        let source = null;
        if (paragraph) {
            const directText = paragraph.querySelector(':scope > .eca-text');
            if (directText) {
                const nested = Array.prototype.slice.call(directText.querySelectorAll('.eca-avatar'));
                const directAvatar = paragraph.querySelector(':scope > .eca-avatar');
                if (avatar === directAvatar) {
                    const range = doc.createRange();
                    range.selectNodeContents(directText);
                    if (nested.length) range.setEndBefore(nested[0]);
                    const holder = doc.createElement('div');
                    holder.appendChild(range.cloneContents());
                    source = textFromRange(holder);
                } else {
                    const index = nested.indexOf(avatar);
                    if (index !== -1) {
                        // 同一 .eca-text 内：本头像的区间 = 自身之后 → 下一个头像之前
                        const range = doc.createRange();
                        range.selectNodeContents(directText);
                        range.setStartAfter(avatar);
                        if (index + 1 < nested.length) range.setEndBefore(nested[index + 1]);
                        const holder = doc.createElement('div');
                        holder.appendChild(range.cloneContents());
                        source = textFromRange(holder);
                    } else {
                        source = textFromRange(directText);
                    }
                }
            }
        }
        if (source === null) {
            const parent = avatar.parentElement;
            if (!parent) return null;
            const siblings = Array.prototype.slice.call(parent.querySelectorAll(':scope > .eca-avatar'));
            const index = siblings.indexOf(avatar);
            const nodes = [];
            let started = false;
            for (let i = 0; i < parent.childNodes.length; i++) {
                const node = parent.childNodes[i];
                if (node === avatar) { started = true; continue; }
                if (started && node.nodeType === 1 && node.classList.contains('eca-avatar')) break;
                if (started) nodes.push(node.cloneNode(true));
            }
            const holder = doc.createElement('div');
            nodes.forEach(function (node) { holder.appendChild(node); });
            source = textFromRange(holder);
            if (index < 0) source = '';
        }
        const quotes = extractQuotedText(source);
        if (!quotes.length) return null;
        return { text: quotes.join('\n'), emotion: avatar.dataset.ecaEmotion || '默认', name: avatar.dataset.ecaName || '' };
    }

    function resetAudioButton(button) {
        if (!button) return;
        button.classList.remove('eca-audio-loading', 'eca-audio-playing');
        if (button.tagName === 'BUTTON') button.textContent = '🔊';
    }

    /** 每次重扫都会恢复状态，播放结束必须复位文档里所有头像与兼容按钮 */
    function resetAllAudioButtons() {
        doc.querySelectorAll('.eca-avatar.eca-audio-loading, .eca-avatar.eca-audio-playing, .eca-audio-btn').forEach(resetAudioButton);
    }

    function stopCurrentAudio() {
        if (currentAudio) {
            try { currentAudio.pause(); } catch (e) { /* 已停止 */ }
            currentAudio.onended = null;
            currentAudio.onerror = null;
        }
        if (currentAudioUrl) {
            try { topWindow.URL.revokeObjectURL(currentAudioUrl); } catch (e) { /* 已释放 */ }
        }
        if (currentAudioButton) resetAudioButton(currentAudioButton);
        resetAllAudioButtons();
        currentAudio = null; currentAudioUrl = null; currentAudioButton = null;
        currentAudioState = null;
    }

    /** 视听状态按「角色 + 文本」记录：重扫恢复头像的播放/合成态 */
    function applyAudioStateToAvatar(avatar, speech) {
        if (!currentAudioState) return;
        if (currentAudioState.name !== speech.name || currentAudioState.text !== speech.text) return;
        avatar.classList.add(currentAudioState.phase === 'playing' ? 'eca-audio-playing' : 'eca-audio-loading');
    }

    function playAvatarSpeech(button, avatar) {
        const targetAvatar = avatar || button;
        if (!targetAvatar) return;
        if (currentAudioButton === targetAvatar && (currentAudio || targetAvatar.classList.contains('eca-audio-loading'))) {
            stopCurrentAudio();
            return;
        }
        stopCurrentAudio();
        const speech = getAvatarSpeech(targetAvatar);
        if (!speech) return;
        const voice = getVoiceConfig(speech.name);
        if (!voice) { toast('请先为「' + speech.name + '」配置语音引擎和音色', true); return; }
        if (TTS_ENGINES.indexOf(voice.engine) === -1) { toast('语音引擎配置无效，请重新选择', true); return; }
        const emotionRequest = buildEmotionRequest(voice.engine, speech.emotion, voice.voiceId);
        const request = Object.assign({ engine: voice.engine, voiceId: voice.voiceId, resourceId: voice.resourceId || '', text: speech.text, emotion: speech.emotion, platform: voice.engine === 'minimax' ? ttsConfig.minimax.platform : '', model: voice.engine === 'minimax' ? ttsConfig.minimax.model : (voice.engine === 'mimo' ? ttsConfig.mimo.model : '') }, emotionRequest);
        // 把生效的语速/音调/音量固化进 request：既供合成使用，也进缓存键，避免改了参数还回放旧音频
        if (voice.engine === 'edge') Object.assign(request, edgeSpeechParams(voice));
        targetAvatar.classList.add('eca-audio-loading');
        currentAudioButton = targetAvatar;
        currentAudioState = { name: speech.name, text: speech.text, phase: 'loading' };
        const seq = ++audioRequestSeq;
        getOrCreateAudio(speech.text, request).then(function (result) {
            if (seq !== audioRequestSeq) return;
            const audio = new topWindow.Audio();
            const url = (topWindow.URL || URL).createObjectURL(result.blob);
            currentAudio = audio; currentAudioUrl = url;
            currentAudioState = { name: speech.name, text: speech.text, phase: 'playing' };
            audio.src = url; audio.preload = 'auto';
            if (currentAudioButton) {
                currentAudioButton.classList.remove('eca-audio-loading');
                currentAudioButton.classList.add('eca-audio-playing');
            }
            audio.onended = function () { if (currentAudio === audio) stopCurrentAudio(); };
            audio.onerror = function () { if (currentAudio === audio) { stopCurrentAudio(); toast('音频播放失败，请重试', true); } };
            const playResult = audio.play();
            if (playResult && typeof playResult.catch === 'function') playResult.catch(function () { if (currentAudio === audio) { stopCurrentAudio(); toast('浏览器阻止了音频播放，请再次点击', true); } });
        }).catch(function (error) {
            if (seq !== audioRequestSeq) return;
            stopCurrentAudio();
            const detail = String((error && error.message) || error || '未知错误');
            toast('语音生成失败：' + (isFetchBlocked(error) ? '网络请求被拦截（CORS 或网络不通），请检查网络或代理设置' : detail) + '（可重试）', true);
        });
    }

    function positionAudioButton() {
        // 兼容保留
    }

    function syncAudioButtons(root) {
        const scope = root || doc;
        const old = scope.querySelector('.eca-audio-overlay');
        if (old) old.remove();
        const avatars = Array.prototype.slice.call(scope.querySelectorAll('.eca-avatar:not(.eca-placeholder)'));
        if (!avatars.length) return;
        const mes = scope.closest && scope.closest('.mes');
        const isAiFloor = mes ? !mes.classList.contains('is_user') : true;

        avatars.forEach(function (avatar) {
            if (!settings.ttsEnabled || !isAiFloor) {
                avatar.classList.remove('eca-has-speech', 'eca-audio-loading', 'eca-audio-playing');
                if (avatar.dataset.ecaAudioBound) {
                    delete avatar.dataset.ecaAudioBound;
                }
                return;
            }
            const speech = getAvatarSpeech(avatar);
            if (!speech) {
                avatar.classList.remove('eca-has-speech', 'eca-audio-loading', 'eca-audio-playing');
                return;
            }
            avatar.classList.add('eca-has-speech');
            avatar.title = '点击播放「' + speech.name + '」对白';
            avatar.setAttribute('aria-label', avatar.title);
            applyAudioStateToAvatar(avatar, speech);

            if (!avatar.dataset.ecaAudioBound) {
                avatar.dataset.ecaAudioBound = '1';
                avatar.addEventListener('click', function (event) {
                    if (!settings.ttsEnabled) return;
                    event.preventDefault();
                    event.stopPropagation();
                    playAvatarSpeech(avatar);
                });
            }
        });
    }

    function refreshAudioButtons() {
        doc.querySelectorAll('.mes_text').forEach(function (root) { syncAudioButtons(root); });
    }

    const CSS_TEXT = ''
        + '.eca-avatar{display:inline-block;height:var(--eca-size,2.5em);width:auto;'
        + 'max-width:calc(var(--eca-size,2.5em)*1.6);object-fit:cover;vertical-align:text-bottom;'
        + 'margin:0 .18em;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.15),0 0 0 1px rgba(120,95,60,.22);'
        + 'transition:box-shadow .2s ease,transform .15s ease;}'
        + '.eca-avatar.eca-has-speech{cursor:pointer;}'
        + '.eca-avatar.eca-has-speech:hover{box-shadow:0 2px 8px rgba(195,152,77,.35),0 0 0 1px rgba(195,152,77,.55);transform:translateY(-1px);}'
        // 加载态：头像周围暖金微光呼吸闪烁
        + '.eca-avatar.eca-audio-loading{animation:eca-avatar-glow 1.2s ease-in-out infinite alternate;}'
        + '@keyframes eca-avatar-glow{0%{box-shadow:0 0 4px rgba(195,152,77,.4),0 0 0 1px rgba(195,152,77,.45);}100%{box-shadow:0 0 14px rgba(195,152,77,.85),0 0 4px rgba(255,235,175,.9),0 0 0 2px rgba(195,152,77,.7);}}'
        // 播放态：头像周围典雅暖金色双重涟漪波纹扩散
        + '.eca-avatar.eca-audio-playing{animation:eca-avatar-ripple 1.8s cubic-bezier(.25,.46,.45,.94) infinite;}'
        + '@keyframes eca-avatar-ripple{'
        + '0%{box-shadow:0 0 0 0 rgba(195,152,77,.75),0 0 0 0 rgba(195,152,77,.45),0 1px 4px rgba(0,0,0,.15);}'
        + '40%{box-shadow:0 0 0 6px rgba(195,152,77,.5),0 0 0 2px rgba(195,152,77,.35),0 1px 4px rgba(0,0,0,.15);}'
        + '70%{box-shadow:0 0 0 13px rgba(195,152,77,0),0 0 0 7px rgba(195,152,77,.25),0 1px 4px rgba(0,0,0,.15);}'
        + '100%{box-shadow:0 0 0 14px rgba(195,152,77,0),0 0 0 14px rgba(195,152,77,0),0 1px 4px rgba(0,0,0,.15);}}'
        // 占位符不可在自身上改 font-size：height 的 em 会按放大后的字号解析，导致尺寸超标
        + '.eca-avatar.eca-placeholder{width:var(--eca-size,2.5em);height:var(--eca-size,2.5em);'
        + 'max-width:none;box-sizing:border-box;display:inline-flex;align-items:center;'
        + 'justify-content:center;background:rgba(128,128,128,.28);'
        + 'color:rgba(190,190,190,.75);border:1px solid rgba(128,128,128,.35);border-radius:6px;'
        + 'user-select:none;overflow:hidden;}'
        + '.eca-avatar.eca-placeholder::after{content:"?";'
        + 'font-size:calc(var(--eca-size,2.5em)*.5);}'
        // 方案一：精装书志 · 典雅文学风
        // 段首头像两列布局：默认 align-items: center 全行强制垂直居中（单行/多行一致）；
        // 置顶开关打开时由 #eca-align-style 覆盖为 flex-start + 头像 margin-top:.18em 首行平齐。
        // 多行台词下头像悬于段中的外观是已知取舍；结合 2px 暖咖色左侧引言呼吸线，
        // 普通叙述旁白适度微退，形成清晰典雅的阅读层次
        + '.mes_text p.eca-p{display:flex;align-items:center;gap:.75em;margin:1.25em 0;}'
        + '.mes_text p.eca-p > .eca-avatar:first-child{flex:0 0 auto;'
        + 'width:var(--eca-size,2.5em);height:var(--eca-size,2.5em);max-width:none;margin:0;'
        + 'border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.15),0 0 0 1px rgba(120,95,60,.25);object-fit:cover;}'
        + '.mes_text p.eca-p > .eca-text{flex:1 1 auto;min-width:0;line-height:1.85;'
        + 'border-left:2px solid rgba(140,105,65,.32);padding-left:.65em;}'
        + '.mes_text p:not(.eca-p){opacity:.88;padding-left:.2em;}'
        // 非 p 容器（.mes_text 直接子节点等，无 JS 包裹）顶对齐兜底布局
        + '.mes_text :has(> .eca-avatar:first-child):not(p):not(.mes_text),'
        + '.mes_text:has(> .eca-avatar:first-child){position:relative;'
        + 'padding-left:calc(var(--eca-size,2.5em) + .75em);'
        + 'min-height:var(--eca-size,2.5em);}'
        + '.mes_text :has(> .eca-avatar:first-child):not(p):not(.mes_text) > .eca-avatar:first-child,'
        + '.mes_text:has(> .eca-avatar:first-child) > .eca-avatar:first-child{'
        + 'position:absolute;left:0;top:.18em;margin:0;'
        + 'width:var(--eca-size,2.5em);height:var(--eca-size,2.5em);max-width:none;border-radius:6px;'
        + 'box-shadow:0 1px 4px rgba(0,0,0,.15),0 0 0 1px rgba(120,95,60,.25);object-fit:cover;}';

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

    /** 姓名解析：主名原样返回；别名映射到主名；未登记返回 null */
    function resolveName(name) {
        if (characters.indexOf(name) !== -1) return name;
        const primary = aliasToPrimary[name];
        return primary && characters.indexOf(primary) !== -1 ? primary : null;
    }

    function isRegistered(name) { return resolveName(name) !== null; }

    /** 情绪对该角色是否有效：固定词，或该角色已上传过该自定义情绪的图 */
    function isValidEmotionFor(character, emotion) {
        return EMOTION_SET.has(emotion) || avatarCache.has(character + '_' + emotion);
    }

    /** 某角色当前实际存在的自定义情绪（有图才算） */
    function getCustomEmotions(character) {
        const list = [];
        allEmotions.forEach(function (emo) {
            if (!EMOTION_SET.has(emo) && avatarCache.has(character + '_' + emo)) list.push(emo);
        });
        return list;
    }

    /**
     * 三级容错解析，返回可用于 <img> 的 src，null 表示渲染占位头像：
     * 未注册（含未绑定别名）→ null；该角色无效情绪/缺图 → 回落其"默认"图；默认也缺 → null
     */
    function resolveTag(name, emotion) {
        const primary = resolveName(name);
        if (!primary) return null;
        if (!isValidEmotionFor(primary, emotion)) emotion = '默认';
        let src = avatarCache.get(primary + '_' + emotion);
        if (!src && emotion !== '默认') src = avatarCache.get(primary + '_默认');
        return src || null;
    }

    function buildAvatarEl(name, emotion, src) {
        if (src) {
            const img = doc.createElement('img');
            img.className = 'eca-avatar';
            img.src = src;
            img.loading = 'eager';
            img.decoding = 'sync';
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

    /** 已渲染头像只更新自身，避免流式期间重建整段 DOM。 */
    function syncRenderedAvatars(root) {
        const scope = root || doc;
        const list = scope.querySelectorAll('.eca-avatar[data-eca-name][data-eca-emotion]');
        for (let i = 0; i < list.length; i++) {
            const avatar = list[i];
            const src = resolveTag(avatar.dataset.ecaName, avatar.dataset.ecaEmotion);
            if (src) {
                if (avatar.tagName !== 'IMG') {
                    const img = buildAvatarEl(avatar.dataset.ecaName, avatar.dataset.ecaEmotion, src);
                    avatar.replaceWith(img);
                } else if (avatar.src !== src) {
                    avatar.src = src;
                    avatar.classList.remove('eca-placeholder');
                }
            } else if (avatar.tagName === 'IMG') {
                avatar.replaceWith(buildAvatarEl(avatar.dataset.ecaName, avatar.dataset.ecaEmotion, null));
            }
        }
    }

    /** 替换单个文本节点中的全部完整标签；只切分命中片段，其余文本原样保留 */
    function processTextNode(node) {
        const text = node.nodeValue;
        if (!text || text.indexOf('{') === -1) return;
        TAG_RE.lastIndex = 0;
        let match;
        let frag = null;
        let lastIdx = 0;
        let hits = 0;
        while ((match = TAG_RE.exec(text)) !== null) {
            const name = match[1].trim();
            const emotion = match[2].trim();
            if (!name || !emotion) continue; // 畸形标签保留为文本
            if (frag === null) frag = doc.createDocumentFragment();
            frag.appendChild(doc.createTextNode(text.slice(lastIdx, match.index)));
            frag.appendChild(buildAvatarEl(name, emotion, resolveTag(name, emotion)));
            lastIdx = match.index + match[0].length;
            hits++;
        }
        if (frag === null) return;
        frag.appendChild(doc.createTextNode(text.slice(lastIdx)));
        node.parentNode.replaceChild(frag, node);
        dbgReplaced += hits;
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

    /** 行首判定：跳过行首空白文本，第一个元素若是头像则视为「行首标签行」 */
    function rowStartsWithAvatar(rowNodes) {
        for (let i = 0; i < rowNodes.length; i++) {
            const n = rowNodes[i];
            if (n.nodeType === 1) return n.classList.contains('eca-avatar');
            if (n.nodeType === 3 && n.nodeValue.trim() !== '') return false;
        }
        return false;
    }

    /**
     * 标签行拆段：酒馆 showdown 开启 simpleLineBreaks 后，标签前只有单换行（无空行）
     * 时标签会留在同一 <p> 里、前面隔一个 <br>，导致头像不满足
     * `p > .eca-avatar:first-child`，两列布局失效。这里把「行首是头像」的视觉行
     * 从原 <p> 拆出成独立 <p>（前后切点 <br> 从文档删除、由段边界替代，段内 <br> 保留），
     * 使双列单元只含标签行本身，标签行之后同段的内容（无标签行）排除出右列、
     * 独立成段；行内文字中的标签（前面无换行）不拆。
     * 随后交给 wrapLeadingAvatarParagraphs 走既有两列逻辑。
     * 幂等：已 eca-p 的段跳过；无可拆点时不动 DOM。
     */
    function splitMidParagraphAvatarLines(root) {
        const scope = root || doc;
        const list = scope.querySelectorAll('.mes_text p');
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (p.classList.contains('eca-p')) continue;
            if (!p.querySelector(':scope > .eca-avatar')) continue;
            const children = Array.prototype.slice.call(p.childNodes);
            const rows = [];
            let row = [];
            for (let k = 0; k < children.length; k++) {
                row.push(children[k]);
                if (children[k].nodeType === 1 && children[k].tagName === 'BR') { rows.push(row); row = []; }
            }
            if (row.length) rows.push(row);
            const segs = [];
            let seg = [];
            for (let r = 0; r < rows.length; r++) {
                if (rowStartsWithAvatar(rows[r])) {
                    if (seg.length) { segs.push(seg); seg = []; }
                    segs.push([rows[r]]);
                } else {
                    seg.push(rows[r]);
                }
            }
            if (seg.length) segs.push(seg);
            if (segs.length < 2) continue;
            // 段边界：删除每段（除最后一段）末尾行末尾的 <br>，由段边界替代换行
            for (let s = 0; s < segs.length - 1; s++) {
                const segLastRow = segs[s][segs[s].length - 1];
                const cutBr = segLastRow[segLastRow.length - 1];
                if (cutBr && cutBr.nodeType === 1 && cutBr.tagName === 'BR' && cutBr.parentNode) {
                    cutBr.parentNode.removeChild(cutBr);
                }
            }
            let anchor = p;
            for (let s = 1; s < segs.length; s++) {
                const np = doc.createElement('p');
                const segRows = segs[s];
                for (let r = 0; r < segRows.length; r++) {
                    const nodes = segRows[r];
                    for (let k = 0; k < nodes.length; k++) {
                        const nd = nodes[k];
                        if (!nd.parentNode) continue; // 上面已删除的切点 <br>
                        np.appendChild(nd);
                    }
                }
                anchor.parentNode.insertBefore(np, anchor.nextSibling);
                anchor = np;
            }
            dbgSplit += segs.length - 1;
        }
    }

    /**
     * 段首头像两列化：p 的首个子节点是头像时，把头像后的全部兄弟内容
     * （文本、<q>、<em> 等）包进单个 .eca-text，使段落成为
     * 「头像 + 文字块」两个 flex 项（配合 p.eca-p 样式，默认垂直居中），
     * 文字块内部行内流不变，<q>/<em> 不会被拆成并排 flex 项压扁。
     * 幂等：已处理（.eca-p）或头像后无内容则跳过
     */
    function wrapLeadingAvatarParagraphs(root) {
        const scope = root || doc;
        const list = scope.querySelectorAll('.mes_text p > .eca-avatar:first-child');
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
            span.dataset.speaker = avatar.dataset.ecaName || '';
            for (let k = 0; k < nodes.length; k++) span.appendChild(nodes[k]);
            p.appendChild(span);
        }
    }

    const STREAM_IDLE_DELAY = 250;
    const DELAY_COMPLETE_WAIT = 200;
    const DELAY_FALLBACK_WAIT = 1000;
    let scanTimer = null;
    let streamTimer = null;
    let completeTimer = null;
    let delayFallbackTimer = null;
    let streamObserver = null;
    /** 宿主生成状态：由 GENERATION_STARTED / 完成事件维护，用于打标与状态快照 */
    let generationActive = false;
    let pendingFullScan = false;
    const dirtyRoots = new Set();

    function isConnectedToDocument(el) {
        return !!(el && doc.documentElement && doc.documentElement.contains(el));
    }

    function findMesTextRoot(node) {
        if (!node) return null;
        let el = node.nodeType === 1 ? node : node.parentElement;
        if (!el) return null;
        return el.matches('.mes_text') ? el : el.closest('.mes_text');
    }

    function addMutationRoots(node, roots) {
        if (!node) return;
        const root = findMesTextRoot(node);
        if (root) roots.add(root);
        if (node.nodeType !== 1) return;
        if (node.matches('.mes_text')) roots.add(node);
        const nested = node.querySelectorAll('.mes_text');
        for (let i = 0; i < nested.length; i++) roots.add(nested[i]);
    }

    function collectMutationRoots(records) {
        const roots = new Set();
        let full = false;
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            addMutationRoots(record.target, roots);
            for (let k = 0; k < record.addedNodes.length; k++) addMutationRoots(record.addedNodes[k], roots);
            if (!findMesTextRoot(record.target) && !record.addedNodes.length) full = true;
        }
        return { roots: roots, full: full || roots.size === 0 };
    }

    function scanRoot(root) {
        if (!isConnectedToDocument(root)) return;
        const t0 = debugOn ? dbgNow() : 0;
        const before = dbgReplaced;
        const beforeSplit = dbgSplit;
        syncRenderedAvatars(root);
        processMesText(root);
        syncRenderedAvatars(root);
        splitMidParagraphAvatarLines(root);
        wrapLeadingAvatarParagraphs(root);
        syncAudioButtons(root);
        if (debugOn) {
            dbg('scanRoot：实际替换标签 ' + (dbgReplaced - before) + ' 个，拆段 ' + (dbgSplit - beforeSplit) + ' 个，耗时 ' + (dbgNow() - t0).toFixed(1) + 'ms，楼层现有头像元素 ' + root.querySelectorAll('.eca-avatar').length + ' 个');
        }
    }

    /** 幂等全扫：初始化、切聊天和完成事件使用的全量入口。 */
    function scanAll() {
        runPendingScan(true, new Set());
    }

    function runPendingScan(forceFull, roots) {
        const observer = streamObserver;
        if (observer) observer.disconnect();
        const t0 = debugOn ? dbgNow() : 0;
        try {
            if (forceFull) {
                const list = doc.querySelectorAll('.mes_text');
                dbg('runPendingScan：全量扫描 .mes_text × ' + list.length);
                for (let i = 0; i < list.length; i++) scanRoot(list[i]);
            } else {
                dbg('runPendingScan：仅扫描脏楼层 × ' + roots.size);
                roots.forEach(scanRoot);
            }
        } finally {
            if (observer) {
                const chatEl = doc.getElementById('chat');
                if (chatEl) observer.observe(chatEl, { childList: true, subtree: true, characterData: true });
                dbg('runPendingScan：完成，耗时 ' + (dbgNow() - t0).toFixed(1) + 'ms，observer 重挂=' + !!chatEl);
            }
        }
    }

    function flushPendingScan(force) {
        dbg('flush 进入：force=' + !!force + ' delayRender=' + !!settings.delayRender + ' generationActive=' + generationActive + ' pendingFull=' + pendingFullScan + ' dirty=' + dirtyRoots.size);
        if (settings.delayRender && !force) {
            dbg('flush ✗ 延时模式拦截，改走 armDelayFallback');
            armDelayFallback();
            return;
        }
        if (streamTimer !== null) { clearTimeout(streamTimer); streamTimer = null; }
        if (completeTimer !== null) { clearTimeout(completeTimer); completeTimer = null; }
        if (delayFallbackTimer !== null) { clearTimeout(delayFallbackTimer); delayFallbackTimer = null; }
        if (!pendingFullScan && dirtyRoots.size === 0) {
            dbg('flush ✗ 脏标记为空，无事可做');
            return;
        }
        const full = pendingFullScan;
        const roots = new Set(dirtyRoots);
        pendingFullScan = false;
        dirtyRoots.clear();
        dbg('flush ✓ 执行扫描：full=' + full + ' roots=' + roots.size);
        runPendingScan(full, roots);
    }

    function armDelayFallback() {
        if (delayFallbackTimer !== null) clearTimeout(delayFallbackTimer);
        delayFallbackTimer = setTimeout(function () {
            delayFallbackTimer = null;
            dbg('延时兜底触发（静默 ' + DELAY_FALLBACK_WAIT + 'ms）');
            flushPendingScan(true);
        }, DELAY_FALLBACK_WAIT);
        dbgHot('arm', 'armDelayFallback：重置型去抖，流式不停则永不触发');
    }

    function queueMutationScan(info) {
        if (info.full) pendingFullScan = true;
        info.roots.forEach(function (root) { dirtyRoots.add(root); });
        dbgHot('mut', 'mutation 到达：roots=' + info.roots.size + ' full=' + info.full + ' delayRender=' + !!settings.delayRender + ' generationActive=' + generationActive);
        if (settings.delayRender) {
            dbgHot('arm', 'mutation → 延时模式分支：只登记不渲染');
            armDelayFallback();
            return;
        }
        // 生成期酒馆每个 token 会重写楼层 innerHTML，等节流窗口会看到原始标签闪现；
        // 在观察器回调内同帧渲染，把"被抹掉"和"补插回"压进同一帧，绘制前就恢复头像。
        if (generationActive) {
            dbgHot('sync', 'mutation → 生成期同帧渲染：立即处理脏楼层 roots=' + info.roots.size + ' full=' + info.full);
            flushPendingScan(false);
            return;
        }
        if (streamTimer !== null) {
            dbgHot('timer', 'mutation → 并入在途 ' + STREAM_IDLE_DELAY + 'ms 节流窗口');
            return;
        }
        streamTimer = setTimeout(function () {
            streamTimer = null;
            flushPendingScan(false);
        }, STREAM_IDLE_DELAY);
        dbgHot('timer', 'mutation → 开启 ' + STREAM_IDLE_DELAY + 'ms 节流窗口，到点渲染脏楼层');
    }

    /** 事件触发的重扫：正常模式 50ms 尾部合并，延时模式只登记待处理楼层。 */
    function scheduleScan() {
        dbg('scheduleScan 进入：delayRender=' + !!settings.delayRender + ' generationActive=' + generationActive + ' scanTimer=' + (scanTimer !== null));
        if (settings.delayRender) {
            pendingFullScan = true;
            dbg('scheduleScan → 延时模式：只登记待处理');
            armDelayFallback();
            return;
        }
        if (scanTimer !== null) {
            dbg('scheduleScan → 已有 50ms 定时器，跳过');
            return;
        }
        scanTimer = setTimeout(function () {
            scanTimer = null;
            hookStreamObserver();
            pendingFullScan = true;
            flushPendingScan(false);
        }, 50);
        dbg('scheduleScan → 50ms 后 flush');
    }

    function scheduleCompletionScan() {
        dbg('完成事件到达：generationActive ' + generationActive + ' → false，pendingFullScan=true，delayRender=' + !!settings.delayRender);
        generationActive = false;
        dbgReset('mut', 'timer', 'arm', 'sync');
        pendingFullScan = true;
        if (!settings.delayRender) {
            scheduleScan();
            return;
        }
        if (delayFallbackTimer !== null) { clearTimeout(delayFallbackTimer); delayFallbackTimer = null; }
        if (completeTimer !== null) clearTimeout(completeTimer);
        completeTimer = setTimeout(function () {
            completeTimer = null;
            flushPendingScan(true);
        }, DELAY_COMPLETE_WAIT);
        dbg('完成事件 → 延时模式：' + DELAY_COMPLETE_WAIT + 'ms 后统一 flush');
    }

    /** 流式观察只收集发生变化的楼层，按节流窗口统一处理（延时模式只登记）。 */
    function hookStreamObserver() {
        if (streamObserver) return;
        const chatEl = doc.getElementById('chat');
        if (!chatEl) {
            dbg('hookStreamObserver：#chat 未就绪，本轮不挂载（由下次 scheduleScan 重试）');
            return; // #chat 未就绪时由下次 scheduleScan 重试
        }
        streamObserver = new MutationObserver(function (records) {
            if (streamObserver === null) return;
            queueMutationScan(collectMutationRoots(records));
        });
        streamObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });
        dbg('hookStreamObserver：MutationObserver 已挂载到 #chat');
    }

    /** 生成开始：登记生成状态（默认模式据此同帧渲染，延时模式据此取消在途渲染窗口） */
    function onGenerationStarted(type, params, dryRun) {
        if (dryRun || (type === 'quiet' && !(params && params.quietToLoud))) {
            dbg('generation_started 忽略：type=' + type + ' dryRun=' + !!dryRun + ' quietToLoud=' + !!(params && params.quietToLoud));
            return;
        }
        dbgReset('mut', 'timer', 'arm', 'sync');
        generationActive = true;
        if (settings.delayRender && streamTimer !== null) {
            clearTimeout(streamTimer);
            streamTimer = null;
            dbg('generation_started：generationActive=true；延时模式，清除在途 streamTimer（生成期间不渲染）');
        } else {
            dbg('generation_started：generationActive=true（默认模式流式期间同帧渲染，防原始标签闪现）');
        }
    }

    function hookEvents() {
        if (debugOn) {
            const evKeys = ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED',
                'MORE_MESSAGES_LOADED', 'MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
                'GENERATION_STARTED', 'APP_READY', 'CHAT_CHANGED'];
            const missing = evKeys.filter(function (k) { return !Env.events[k]; });
            dbg('hookEvents v' + VERSION + '：宿主事件缺失=' + (missing.length ? missing.join('/') : '无')
                + '；delayRender=' + !!settings.delayRender + '；#chat=' + !!doc.getElementById('chat'));
        }
        [
            'CHARACTER_MESSAGE_RENDERED',
            'USER_MESSAGE_RENDERED',
            'MESSAGE_EDITED',
            'MESSAGE_SWIPED',
            'MORE_MESSAGES_LOADED',
        ].forEach(function (key) {
            const ev = Env.events[key];
            if (ev) Env.on(ev, scheduleScan);
        });
        ['MESSAGE_RECEIVED', 'GENERATION_ENDED', 'GENERATION_STOPPED'].forEach(function (key) {
            const ev = Env.events[key];
            if (ev) Env.on(ev, scheduleCompletionScan);
        });
        const generationStarted = Env.events.GENERATION_STARTED;
        if (generationStarted) Env.on(generationStarted, onGenerationStarted);
        const appReady = Env.events.APP_READY;
        if (appReady) Env.on(appReady, function () { addMenuButton(); scheduleScan(); });
        const resize = topWindow.addEventListener;
        if (resize) topWindow.addEventListener('resize', refreshAudioButtons);
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
        hookEscapeCloser();
    }

    /** Esc 关闭顶层弹窗：批量对话框优先，其次管理面板；输入框聚焦时不抢 */
    let escapeCloserHooked = false;
    function hookEscapeCloser() {
        if (escapeCloserHooked) return;
        escapeCloserHooked = true;
        doc.addEventListener('keydown', function (ev) {
            const key = ev.key || ev.keyCode;
            if (key !== 'Escape' && key !== 'Esc' && key !== 27) return;
            const tag = ev.target && ev.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (batchEl && batchEl.style.display === 'flex') { closeBatchDialog(); return; }
            if (panelEl && panelEl.style.display === 'flex') closePanel();
        });
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

    /** 提示词情绪表：固定十个 + 启用组各角色实际已传图的自定义情绪（按角色独立，无图不罗列） */
    function getInjectionEmotions() {
        const tags = EMOTIONS.slice();
        const seen = {};
        getInjectionCharacters().forEach(function (name) {
            getCustomEmotions(name).forEach(function (emo) {
                if (!seen[emo]) { seen[emo] = true; tags.push(emo); }
            });
        });
        return tags;
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
            + '情绪词限定：' + getInjectionEmotions().join('、') + '\n'
            + '无法确定或该角色缺少某情绪时，优先使用默认。\n'
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
        }
    }

    /** 对齐模式即时生效：置顶开 = 覆盖为顶端首行平齐；关 = 移除覆盖回到默认垂直居中 */
    function applyAlignMode() {
        let el = doc.getElementById('eca-align-style');
        if (!settings.topAlign) {
            if (el) el.textContent = '';
            return;
        }
        if (!el) {
            el = doc.createElement('style');
            el.id = 'eca-align-style';
            doc.head.appendChild(el);
        }
        el.textContent = '.mes_text p.eca-p{align-items:flex-start !important;}'
            + '.mes_text p.eca-p > .eca-avatar:first-child{margin:.18em 0 0 !important;}';
    }

    /** 置顶开关：开 = 段首头像与文字首行平齐；关（默认）= 全行强制垂直居中 */
    function setTopAlign(topAlign) {
        settings.topAlign = !!topAlign;
        persistSettings();
        applyAlignMode();
        syncPanelControls();
    }

    /** 延时渲染开关：流式期间只保留原始标签，完成或静默超时后统一替换。 */
    function setDelayRender(delayRender) {
        settings.delayRender = !!delayRender;
        persistSettings();
        dbg('setDelayRender → ' + settings.delayRender + '；generationActive=' + generationActive + ' dirty=' + dirtyRoots.size);
        if (settings.delayRender) {
            if (scanTimer !== null) { clearTimeout(scanTimer); scanTimer = null; }
            if (streamTimer !== null) { clearTimeout(streamTimer); streamTimer = null; }
            pendingFullScan = true;
            armDelayFallback();
        } else {
            if (delayFallbackTimer !== null) { clearTimeout(delayFallbackTimer); delayFallbackTimer = null; }
            pendingFullScan = true;
            flushPendingScan(true);
        }
        syncPanelControls();
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

    /** 保存并同步更新内存缓存（覆盖时先回写楼层，再 revoke 旧 URL） */
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
                    const oldUrl = avatarCache.get(id);
                    const nextUrl = createBlobUrl(blob);
                    avatarCache.set(id, nextUrl);
                    allEmotions.add(emotion);
                    syncRenderedAvatars(doc);
                    revokeCacheUrl(oldUrl);
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
                    const oldUrl = avatarCache.get(id);
                    avatarCache.delete(id);
                    syncRenderedAvatars(doc);
                    revokeCacheUrl(oldUrl);
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
                    const oldUrls = keys.map(function (key) { return avatarCache.get(key); });
                    keys.forEach(function (key) {
                        avatarCache.delete(key);
                        store.delete(key);
                    });
                    syncRenderedAvatars(doc);
                    oldUrls.forEach(revokeCacheUrl);
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
                allEmotions.add(r.emotion);
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
        // 两个弹窗（管理面板 / 批量导入）共用的羊皮纸骨架样式。
        // 遮罩用 absolute 而非 fixed：酒馆移动端 html 为高度 0 的变换元素，
        // fixed 会以它为基准被压成一条；absolute 跟随 body（top/left 0 宽视口）即可全屏。
        + '#eca-panel,#eca-batch-panel{display:none;position:absolute;top:0;left:0;width:100%;min-height:100%;z-index:99999;background:rgba(18,13,8,.65);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);align-items:flex-start;justify-content:center;padding:4vh 0;box-sizing:border-box;font-size:13px;font-family:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}'
        + '#eca-batch-panel{z-index:100001;background:rgba(18,13,8,.7);}'
        + '#eca-panel .eca-modal,#eca-batch-panel .eca-modal{width:min(820px,94vw);max-height:calc(100vh - 8vh);max-height:calc(100dvh - 8vh);display:flex;flex-direction:column;background:#f5f0e3;background-image:linear-gradient(145deg,#fbf7ee 0%,#f4eddc 45%,#ecdfc7 100%);color:#493725;border:1px solid #cdbea2;border-radius:12px;box-shadow:0 20px 60px rgba(35,22,10,.45),0 0 0 1px rgba(160,130,90,.25);position:relative;overflow:hidden;flex:0 0 auto;}'
        + '#eca-panel .eca-modal::before,#eca-batch-panel .eca-modal::before{content:"";position:absolute;inset:3px;border:1px solid #ded2bd;border-radius:9px;pointer-events:none;box-shadow:inset 0 0 16px rgba(150,115,75,.1);}'
        + '#eca-batch-panel .eca-modal{width:min(880px,94vw);}'
        // 批量对话框主体自身可滚：内容超高时内部滚，底栏保存按钮不出视口
        + '#eca-batch-panel .eca-batch-body{min-height:0;}'
        + '#eca-panel .eca-header,#eca-batch-panel .eca-header{display:flex;align-items:center;justify-content:space-between;padding:11px 18px;border-bottom:1px solid #ded2bd;background:rgba(246,238,222,.7);position:relative;z-index:2;font-weight:700;color:#2b1f13;font-family:"Cinzel","STSong","Songti SC","Noto Serif SC",Georgia,serif;font-size:15px;letter-spacing:.02em;}'
        + '#eca-panel .eca-close,#eca-batch-panel .eca-close{background:none;border:1px solid transparent;color:#7d6b56;font-size:18px;cursor:pointer;line-height:1;padding:0 5px;border-radius:5px;transition:all .15s ease;}'
        + '#eca-panel .eca-close:hover,#eca-batch-panel .eca-close:hover{color:#943325;background:rgba(148,51,37,.1);border-color:rgba(148,51,37,.25);}'
        + '#eca-panel .eca-footer,#eca-batch-panel .eca-footer{display:flex;align-items:center;padding:8px 16px;border-top:1px solid #ded2bd;background:rgba(244,235,218,.8);position:relative;z-index:2;font-size:13px;min-height:44px;box-sizing:border-box;}'
        + '#eca-panel .eca-footer{justify-content:space-between;gap:12px;flex-wrap:wrap;}'
        + '#eca-batch-panel .eca-footer{gap:16px;flex-wrap:wrap;padding:10px 18px;}'
        // 管理面板主体
        + '#eca-panel .eca-body{display:flex;min-height:360px;max-height:calc(100vh - 220px);max-height:calc(100dvh - 220px);overflow:hidden;position:relative;z-index:1;}'
        + '#eca-panel .eca-side{width:210px;flex:0 0 210px;border-right:1px solid #ded2bd;background:rgba(244,235,218,.55);padding:10px 10px 8px;display:flex;flex-direction:column;gap:6px;min-height:0;}'
        + '#eca-panel .eca-side-title{color:#2b1f13;font-size:12px;font-weight:700;font-family:"Cinzel","STSong","Songti SC","Noto Serif SC",serif;padding:0 2px 4px;border-bottom:1px solid rgba(205,190,162,.45);}'
        + '#eca-panel #eca-char-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px;}'
        + '#eca-panel .eca-char-item{display:flex;align-items:center;justify-content:space-between;padding:5px 8px;border-radius:5px;cursor:pointer;background:rgba(255,255,255,.6);border:1px solid transparent;transition:all .12s ease;user-select:none;flex-shrink:0;}'
        + '#eca-panel .eca-char-item:hover{background:#fff;border-color:#ded2bd;box-shadow:0 1px 3px rgba(60,40,20,.05);}'
        + '#eca-panel .eca-char-item.active{background:linear-gradient(90deg,#f2e4cb 0%,#fbf6ec 100%);border-color:#c3984d;box-shadow:0 1px 4px rgba(156,113,56,.15);font-weight:600;position:relative;}'
        + '#eca-panel .eca-char-item.active::before{content:"";position:absolute;left:0;top:3px;bottom:3px;width:3px;background:#9c7138;border-radius:2px;}'
        + '#eca-panel .eca-char-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#493725;}'
        + '#eca-panel .eca-char-del{background:none;border:0;color:#9d8c78;cursor:pointer;font-size:11px;padding:1px 3px;border-radius:3px;opacity:.6;transition:all .12s ease;}'
        + '#eca-panel .eca-char-del:hover{color:#943325;background:rgba(148,51,37,.12);opacity:1;}'
        // 底栏双区布局与分割线
        + '#eca-panel .eca-footer-left{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:nowrap;}'
        + '#eca-panel .eca-footer-tools{display:flex;align-items:center;gap:8px;flex:0 0 auto;}'
        + '#eca-panel .eca-footer-divider{width:1px;height:18px;background:#ded2bd;flex:0 0 auto;margin:0 2px;}'
        + '#eca-panel .eca-footer-right{display:flex;align-items:center;gap:12px;flex:1 1 auto;justify-content:flex-end;white-space:nowrap;flex-wrap:nowrap;}'
        + '#eca-panel .eca-add{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:5px 13px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s ease;text-shadow:0 1px 0 rgba(255,255,255,.7);user-select:none;white-space:nowrap;}'
        + '#eca-panel .eca-add.eca-add-char{background:linear-gradient(180deg,#fefaf0 0%,#ebe0c8 100%);border:1px solid #c3984d;color:#2b1f13;box-shadow:0 1px 3px rgba(110,75,30,.15),inset 0 1px 0 #fff;}'
        + '#eca-panel .eca-add.eca-add-char:hover{background:linear-gradient(180deg,#fffdf8 0%,#f4e8d0 100%);border-color:#9c7138;transform:translateY(-1px);box-shadow:0 2px 6px rgba(156,113,56,.25);}'
        + '#eca-panel .eca-add.eca-add-group{background:rgba(245,237,222,.7);border:1px solid #ded2bd;color:#6d5b46;box-shadow:0 1px 2px rgba(60,40,20,.05);}'
        + '#eca-panel .eca-add.eca-add-group:hover{background:#faf6ec;border-color:#b8a584;color:#493725;box-shadow:0 1px 4px rgba(70,50,20,.1);}'
        // 人物组手风琴
        + '#eca-panel .eca-group{border:1px solid #ded2bd;border-radius:7px;background:rgba(251,247,238,.7);box-shadow:0 1px 3px rgba(60,40,20,.04);overflow:hidden;flex-shrink:0;transition:border-color .15s ease;}'
        + '#eca-panel .eca-group:hover{border-color:#b8a584;}'
        + '#eca-panel .eca-group-head{display:flex;align-items:center;gap:5px;padding:6px 8px;cursor:pointer;user-select:none;background:rgba(244,234,217,.5);transition:background .12s ease;}'
        + '#eca-panel .eca-group-head:hover{background:rgba(238,224,203,.85);}'
        + '#eca-panel .eca-group-arrow{width:14px;color:#9c7138;transition:transform .18s cubic-bezier(.16,1,.3,1);flex:0 0 auto;text-align:center;font-size:10px;}'
        + '#eca-panel .eca-group.collapsed .eca-group-arrow{transform:rotate(-90deg);}'
        + '#eca-panel .eca-group-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;color:#2b1f13;}'
        + '#eca-panel .eca-group-count{color:#9d8c78;font-size:10px;flex:0 0 auto;background:rgba(180,150,110,.15);padding:1px 5px;border-radius:10px;}'
        + '#eca-panel .eca-group-off .eca-group-name,#eca-panel .eca-group-off .eca-group-count{color:#9d8c78;text-decoration:line-through;opacity:.75;}'
        + '#eca-panel .eca-group-toggle{flex:0 0 auto;cursor:pointer;accent-color:#9c7138;margin:0;}'
        + '#eca-panel .eca-group-btn{background:none;border:0;color:#9d8c78;cursor:pointer;font-size:11px;padding:1px 3px;border-radius:3px;flex:0 0 auto;transition:all .12s ease;}'
        + '#eca-panel .eca-group-btn:hover{color:#2b1f13;background:rgba(180,150,110,.2);}'
        + '#eca-panel .eca-group-btn[data-act="grp-del"]:hover{color:#943325;background:rgba(148,51,37,.15);}'
        + '#eca-panel .eca-group-body{padding:4px 6px 6px;display:flex;flex-direction:column;gap:3px;min-height:16px;border-top:1px solid rgba(222,210,189,.6);}'
        + '#eca-panel .eca-group.collapsed .eca-group-body{display:none;}'
        + '#eca-panel .eca-group-body.eca-drop-hover{background:rgba(195,152,77,.15);outline:1px dashed #9c7138;outline-offset:-2px;border-radius:4px;}'
        + '#eca-panel .eca-char-item[draggable]{cursor:grab;}'
        + '#eca-panel .eca-char-item.eca-dragging{opacity:.35;}'
        // 右侧详情区
        + '#eca-panel .eca-detail{flex:1 1 auto;min-width:0;padding:16px 20px;overflow-y:auto;display:flex;flex-direction:column;min-height:0;}'
        + '#eca-panel .eca-detail-empty{color:#7d6b56;padding:40px 0;text-align:center;font-size:13px;}'
        + '#eca-panel .eca-detail-head{display:flex;align-items:center;gap:10px;margin-bottom:8px;padding-bottom:10px;border-bottom:1px solid #ded2bd;flex:0 0 auto;}'
        + '#eca-panel .eca-detail-head b{font-size:18px;font-family:"Cinzel","STSong","Songti SC","Noto Serif SC",serif;color:#2b1f13;letter-spacing:.02em;}'
        + '#eca-panel .eca-detail-tip{color:#7d6b56;font-size:12px;margin-bottom:10px;line-height:1.5;background:rgba(246,237,220,.6);border-left:3px solid #9c7138;padding:6px 12px;border-radius:0 5px 5px 0;flex:0 0 auto;}'
        + '#eca-panel .eca-mini-btn{padding:4px 12px;border-radius:6px;border:1px solid #b8a584;background:#fcf8f0;color:#493725;cursor:pointer;font-size:12px;font-weight:500;transition:all .15s ease;box-shadow:0 1px 2px rgba(60,40,20,.05);}'
        + '#eca-panel .eca-mini-btn:hover{background:#fff;border-color:#9c7138;color:#9c7138;box-shadow:0 2px 5px rgba(156,113,56,.18);}'
        + '#eca-panel #eca-batch-btn{background:linear-gradient(180deg,#fbf5e6,#ecdcb9);border-color:#c3984d;color:#2b1f13;font-weight:600;}'
        + '#eca-panel #eca-batch-btn:hover{background:#fff;border-color:#9c7138;color:#1a1109;}'
        // 十情绪相框网格（大头像、贴合边框）
        + '#eca-panel .eca-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;align-content:start;margin-top:2px;}'
        + '#eca-panel .eca-cell{border:1px solid #ded2bd;border-radius:7px;padding:5px 5px 6px;text-align:center;cursor:pointer;background:#fbf8f2;transition:all .18s cubic-bezier(.16,1,.3,1);box-shadow:0 1px 3px rgba(60,40,20,.05);display:flex;flex-direction:column;align-items:center;position:relative;box-sizing:border-box;}'
        + '#eca-panel .eca-cell:hover{border-color:#9c7138;background:#fff;box-shadow:0 4px 12px rgba(156,113,56,.22);transform:translateY(-2px);}'
        + '#eca-panel .eca-cell-img{width:100%;aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;margin-bottom:4px;border-radius:5px;overflow:hidden;background:rgba(235,224,205,.3);}'
        + '#eca-panel .eca-cell-img img{width:100%;height:100%;object-fit:cover;border-radius:5px;border:1px solid rgba(160,130,90,.25);box-shadow:0 1px 3px rgba(60,40,20,.1);display:block;}'
        + '#eca-panel .eca-cell-empty{width:100%;height:100%;border:1px dashed #b8a584;border-radius:5px;display:flex;align-items:center;justify-content:center;color:#7d6b56;font-size:12px;font-family:"Cinzel","STSong","Songti SC",serif;background:rgba(240,230,210,.25);transition:all .15s ease;}'
        + '#eca-panel .eca-cell:hover .eca-cell-empty{border-color:#9c7138;color:#9c7138;background:rgba(195,152,77,.1);}'
        // 情绪名不允许竖排压字：窄宽下省略而非逐字换行
        + '#eca-panel .eca-cell-name{font-size:12px;font-weight:600;color:#493725;font-family:"Cinzel","STSong","Songti SC",serif;line-height:1.2;padding-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}'
        // 自定义情绪格删除钮与「＋新增情绪」格
        + '#eca-panel .eca-cell-del{position:absolute;top:3px;right:3px;z-index:2;width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;border:0;background:rgba(148,51,37,.85);color:#fff;font-size:10px;cursor:pointer;opacity:0;transition:opacity .15s ease;padding:0;}'
        + '#eca-panel .eca-cell:hover .eca-cell-del{opacity:1;}'
        + '#eca-panel .eca-cell.eca-cell-add{border-style:dashed;background:rgba(251,248,242,.5);}'
        + '#eca-panel .eca-cell.eca-cell-add .eca-cell-empty{font-size:20px;font-weight:600;}'
        + '#eca-panel .eca-cell.eca-cell-add .eca-cell-name{color:#7d6b56;font-weight:500;}'
        // 角色项别名角标
        + '#eca-panel .eca-char-alias{flex:0 0 auto;color:#9c7138;font-size:10px;background:rgba(195,152,77,.16);border-radius:8px;padding:0 5px;}'
        // 底栏控件
        + '#eca-panel .eca-switch{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-weight:500;color:#2b1f13;}'
        + '#eca-panel .eca-switch input{accent-color:#3f684c;cursor:pointer;margin:0;}'
        + '#eca-panel .eca-size{display:flex;align-items:center;gap:6px;color:#493725;font-size:12px;white-space:nowrap;}'
        + '#eca-panel .eca-size input[type=range]{width:95px;accent-color:#9c7138;cursor:pointer;margin:0;}'
        + '#eca-panel .eca-size-val{min-width:3.2em;color:#9c7138;font-weight:600;font-family:Consolas,monospace;}'
        // 批量导入对话框（羊皮纸风格）
        + '#eca-batch-panel .eca-batch-body{padding:14px 18px;overflow-y:auto;}'
        + '#eca-batch-panel .eca-batch-canvas-wrap{background:rgba(255,255,255,.5);border:2px dashed #b8a584;border-radius:8px;padding:12px;text-align:center;cursor:pointer;transition:all .15s ease;}'
        + '#eca-batch-panel .eca-batch-canvas-wrap:hover{background:#fff;border-color:#9c7138;}'
        + '#eca-batch-panel .eca-batch-canvas-wrap canvas{max-width:100%;height:auto;border-radius:4px;}'
        + '#eca-batch-panel .eca-batch-hint{color:#7d6b56;padding:24px 0;font-size:13px;}'
        + '#eca-batch-panel .eca-batch-ctrl{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0;background:rgba(244,235,218,.7);padding:8px 12px;border-radius:6px;border:1px solid #ded2bd;}'
        + '#eca-batch-panel .eca-stepper{display:flex;align-items:center;gap:4px;color:#493725;font-size:12px;}'
        + '#eca-batch-panel .eca-stepper b{min-width:1.2em;text-align:center;color:#2b1f13;font-weight:700;}'
        + '#eca-batch-panel .eca-batch-ctrl button{padding:3px 10px;border-radius:4px;border:1px solid #b8a584;background:#fcf8f0;color:#2b1f13;cursor:pointer;font-size:12px;}'
        + '#eca-batch-panel .eca-batch-ctrl button:hover{background:#fff;border-color:#9c7138;color:#9c7138;}'
        + '#eca-batch-panel .eca-batch-ctrl select,#eca-batch-panel .eca-bcell select{background:#fcf8f0;color:#2b1f13;border:1px solid #b8a584;border-radius:4px;padding:3px 6px;font-size:12px;}'
        + '#eca-batch-panel .eca-batch-mapping{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;}'
        + '#eca-batch-panel .eca-bcell{border:1px solid #ded2bd;border-radius:8px;padding:6px;text-align:center;background:#fbf8f2;box-shadow:0 1px 3px rgba(60,40,20,.05);}'
        + '#eca-batch-panel .eca-bcell.skipped{opacity:.45;}'
        + '#eca-batch-panel .eca-bcell img{width:100%;height:60px;object-fit:contain;border-radius:4px;background:#ede3cc;}'
        + '#eca-batch-panel .eca-bcell select{width:100%;margin-top:4px;font-size:12px;}'
        + '#eca-batch-panel .eca-primary{background:linear-gradient(180deg,#fefaf0 0%,#ebe0c8 100%);color:#2b1f13;border:1px solid #c3984d;border-radius:6px;padding:6px 18px;cursor:pointer;font-size:13px;font-weight:600;box-shadow:0 1px 3px rgba(110,75,30,.15);}'
        + '#eca-batch-panel .eca-primary:hover{background:#fff;border-color:#9c7138;transform:translateY(-1px);}'
        + '#eca-batch-panel .eca-primary:disabled{opacity:.5;cursor:wait;transform:none;}'
        // toast
        + '.eca-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:linear-gradient(145deg,#fcf8ee,#ebdcc0);color:#2b1f13;padding:9px 22px;border-radius:8px;border:1px solid #c3984d;z-index:100002;box-shadow:0 6px 20px rgba(50,30,10,.25);font-size:13px;font-weight:600;transition:opacity .4s,transform .4s;}'
        + '.eca-toast.eca-toast-warn{border-color:#943325;color:#943325;}'
        + '.eca-toast.eca-toast-out{opacity:0;transform:translate(-50%,15px);}'
        // 羊皮纸滚动条
        + '#eca-panel ::-webkit-scrollbar,#eca-batch-panel ::-webkit-scrollbar{width:6px;height:6px;}'
        + '#eca-panel ::-webkit-scrollbar-track,#eca-batch-panel ::-webkit-scrollbar-track{background:rgba(220,205,180,.3);border-radius:3px;}'
        + '#eca-panel ::-webkit-scrollbar-thumb,#eca-batch-panel ::-webkit-scrollbar-thumb{background:#cfbea0;border-radius:3px;}'
        + '#eca-panel ::-webkit-scrollbar-thumb:hover,#eca-batch-panel ::-webkit-scrollbar-thumb:hover{background:#b5a281;}'
        // 移动端窄屏：纵向堆叠 + 网格降列 + 底栏收紧，避免左右挤压与竖排单字；
        // 遮罩顶部对齐 + 头栏粘顶，保证窄屏下关闭按钮始终可达；
        // 弹窗限高 + 主体内滚 + 遮罩可滚，保证底栏按钮可达
        + '@media (max-width:640px){'
        + '#eca-panel .eca-modal,#eca-batch-panel .eca-modal{width:min(820px,96vw);max-height:calc(100dvh - 8vh);}'
        + '#eca-panel,#eca-batch-panel{overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;}'
        + '#eca-panel .eca-header,#eca-batch-panel .eca-header{position:sticky;top:0;}'
        + '#eca-panel .eca-body{flex-direction:column;min-height:0;max-height:none;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;flex:1 1 auto;}'
        + '#eca-panel .eca-side{width:auto;flex:0 0 auto;border-right:0;border-bottom:1px solid #ded2bd;max-height:32vh;}'
        + '#eca-panel .eca-detail{padding:12px;}'
        + '#eca-panel .eca-grid{grid-template-columns:repeat(3,1fr);gap:8px;}'
        + '#eca-panel .eca-cell-name{font-size:11px;}'
        + '#eca-panel .eca-footer{flex-wrap:wrap;gap:8px;padding:8px 12px;min-height:auto;}'
        + '#eca-panel .eca-footer-divider{display:none;}'
        + '#eca-panel .eca-footer-left,#eca-panel .eca-footer-right,#eca-panel .eca-footer-tools{width:100%;justify-content:flex-start;flex-wrap:wrap;gap:8px;}'
        + '#eca-panel .eca-size input[type=range]{width:80px;}'
        + '}'
        // 排障诊断弹窗（复用羊皮纸骨架）
        + '#eca-diag-panel{display:none;position:absolute;top:0;left:0;width:100%;min-height:100%;z-index:100003;background:rgba(18,13,8,.7);align-items:flex-start;justify-content:center;padding:4vh 0;box-sizing:border-box;font-size:13px;font-family:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}'
        + '#eca-diag-panel .eca-modal{width:min(720px,94vw);max-height:calc(100dvh - 8vh);display:flex;flex-direction:column;background:#f5f0e3;background-image:linear-gradient(145deg,#fbf7ee 0%,#f4eddc 45%,#ecdfc7 100%);color:#493725;border:1px solid #cdbea2;border-radius:12px;box-shadow:0 20px 60px rgba(35,22,10,.45);position:relative;overflow:hidden;}'
        + '#eca-diag-panel .eca-header{display:flex;align-items:center;justify-content:space-between;padding:11px 18px;border-bottom:1px solid #ded2bd;background:rgba(246,238,222,.7);font-weight:700;color:#2b1f13;font-size:15px;}'
        + '#eca-diag-panel .eca-close{background:none;border:1px solid transparent;color:#7d6b56;font-size:18px;cursor:pointer;line-height:1;padding:0 5px;border-radius:5px;}'
        + '#eca-diag-panel .eca-close:hover{color:#943325;background:rgba(148,51,37,.1);}'
        + '#eca-diag-panel .eca-diag-body{padding:14px 18px;overflow-y:auto;flex:1 1 auto;min-height:0;}'
        + '#eca-diag-panel .eca-diag-tip{color:#7d6b56;font-size:12px;margin-bottom:8px;background:rgba(246,237,220,.6);border-left:3px solid #9c7138;padding:6px 12px;border-radius:0 5px 5px 0;}'
        + '#eca-diag-panel #eca-diag-report{white-space:pre-wrap;word-break:break-all;font-family:Consolas,monospace;font-size:12px;line-height:1.6;background:#fffdf8;border:1px solid #ded2bd;border-radius:8px;padding:12px;margin:0 0 10px;max-height:50vh;overflow-y:auto;color:#2b1f13;}'
        + '#eca-diag-panel .eca-diag-actions{display:flex;gap:10px;flex-wrap:wrap;}'
        + '@media (max-width:640px){'
        + '#eca-diag-panel{overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;}'
        + '#eca-diag-panel .eca-header{position:sticky;top:0;}'
        + '#eca-diag-panel .eca-modal{width:96vw;max-height:calc(100dvh - 6vh);}'
        + '}';

    function ensurePanelStyles() {
        if (doc.getElementById('eca-panel-styles')) return;
        const style = doc.createElement('style');
        style.id = 'eca-panel-styles';
        style.textContent = PANEL_CSS;
        doc.head.appendChild(style);
    }

    function ensureAudioPanelStyles() {
        if (doc.getElementById('eca-audio-panel-styles')) return;
        const style = doc.createElement('style');
        style.id = 'eca-audio-panel-styles';
        style.textContent = '#eca-audio-settings,#eca-voice-settings,#eca-cache-panel{display:none;position:absolute;inset:0;z-index:100004;background:rgba(18,13,8,.7);align-items:flex-start;justify-content:center;padding:4vh 0;box-sizing:border-box;font:13px system-ui,"Segoe UI","Microsoft YaHei",sans-serif;overflow-y:auto;}'
            + '#eca-audio-settings .eca-audio-modal,#eca-voice-settings .eca-audio-modal,#eca-cache-panel .eca-audio-modal{width:min(760px,94vw);max-height:calc(100dvh - 8vh);display:flex;flex-direction:column;background:#f5f0e3;background-image:linear-gradient(145deg,#fbf7ee,#ecdfc7);color:#493725;border:1px solid #cdbea2;border-radius:12px;box-shadow:0 20px 60px rgba(35,22,10,.45);overflow:hidden;} '
            + '.eca-audio-head{display:flex;align-items:center;justify-content:space-between;padding:11px 18px;border-bottom:1px solid #ded2bd;background:rgba(246,238,222,.7);font-weight:700;color:#2b1f13;font-family:"STSong","Songti SC",serif;font-size:15px;} '
            + '.eca-audio-head button{background:none;border:0;color:#7d6b56;font-size:18px;cursor:pointer;} .eca-audio-body{padding:14px 18px;overflow-y:auto;min-height:0;} '
            + '.eca-audio-section{border:1px solid #ded2bd;border-radius:7px;padding:10px 12px;margin-bottom:10px;background:rgba(251,247,238,.72);} .eca-audio-section h4{margin:0 0 8px;color:#2b1f13;} '
            + '.eca-audio-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:7px 0;} .eca-audio-row label{min-width:92px;color:#6d5b46;} '
            + '.eca-audio-row input,.eca-audio-row select{flex:1 1 180px;min-width:0;padding:5px 7px;border:1px solid #b8a584;border-radius:5px;background:#fffdf8;color:#2b1f13;box-sizing:border-box;} '
            + '.eca-audio-row input[type=checkbox]{flex:0 0 auto;min-width:auto;} .eca-audio-row input[type=number]{flex:0 0 88px;min-width:auto;} .eca-audio-tip{font-size:12px;color:#7d6b56;line-height:1.5;margin:6px 0;} '
            + '.eca-audio-footer{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #ded2bd;background:rgba(244,235,218,.8);} '
            + '.eca-audio-footer button,.eca-audio-row button,.eca-cache-action{padding:5px 12px;border:1px solid #b8a584;border-radius:5px;background:#fcf8f0;color:#493725;cursor:pointer;} .eca-audio-row button:disabled{opacity:.6;cursor:default;} .eca-audio-footer .primary{background:#ebe0c8;border-color:#c3984d;font-weight:600;} '
            + '.eca-cache-list{display:flex;flex-direction:column;gap:6px;} .eca-cache-item{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #ded2bd;border-radius:6px;background:#fffdf8;} .eca-cache-meta{flex:1;min-width:0;} .eca-cache-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#2b1f13;} .eca-cache-sub{font-size:11px;color:#7d6b56;margin-top:3px;} .eca-cache-item button{flex:0 0 auto;} '
            + '@media(max-width:640px){#eca-audio-settings,#eca-voice-settings,#eca-cache-panel{padding:3vh 0;} .eca-audio-modal{width:96vw!important;max-height:calc(100dvh - 6vh)!important;}}';
        doc.head.appendChild(style);
    }

    function setTtsEnabled(enabled) {
        settings.ttsEnabled = !!enabled;
        persistSettings();
        if (!settings.ttsEnabled) stopCurrentAudio();
        refreshAudioButtons();
        syncPanelControls();
    }

    function audioModal(id, title, body, footer) {
        ensureAudioPanelStyles();
        let root = doc.getElementById(id);
        if (root) root.remove();
        root = doc.createElement('div'); root.id = id;
        root.innerHTML = '<div class="eca-audio-modal"><div class="eca-audio-head"><span>' + title + '</span><button type="button" data-audio-close>×</button></div><div class="eca-audio-body">' + body + '</div><div class="eca-audio-footer">' + footer + '</div></div>';
        root.addEventListener('click', function (ev) {
            if (ev.target === root || ev.target.hasAttribute('data-audio-close')) { root.style.display = 'none'; return; }
        });
        doc.body.appendChild(root);
        root.style.display = 'flex';
        return root;
    }

    /** Edge 音色数量多，按语言分组展示 */
    function edgeVoiceOptionsHtml(selectedId) {
        const groups = [];
        EDGE_VOICES.forEach(function (voice) {
            const group = groups.filter(function (g) { return g.lang === voice.lang; })[0];
            if (group) group.items.push(voice); else groups.push({ lang: voice.lang, items: [voice] });
        });
        return groups.map(function (group) {
            return '<optgroup label="' + escapeHtml(group.lang) + '">' + group.items.map(function (voice) {
                return '<option value="' + escapeHtml(voice.id) + '"' + (selectedId === voice.id ? ' selected' : '') + '>' + escapeHtml(voice.name + ' · ' + voice.id) + '</option>';
            }).join('') + '</optgroup>';
        }).join('');
    }

    function mimoVoiceOptionsHtml(selectedId) {
        const preset = MIMO_VOICES.map(function (voice) {
            return '<option value="' + escapeHtml(voice.id) + '"' + (selectedId === voice.id ? ' selected' : '') + '>' + escapeHtml(voice.name) + '</option>';
        }).join('');
        const clones = getMimoClones();
        const cloneGroup = clones.length
            ? '<optgroup label="我的复刻">' + clones.map(function (voice) {
                const value = MIMO_CLONE_PREFIX + voice.id;
                return '<option value="' + escapeHtml(value) + '"' + (selectedId === value ? ' selected' : '') + '>' + escapeHtml(voice.nickname) + '</option>';
            }).join('') + '</optgroup>'
            : '';
        const known = MIMO_VOICES.some(function (v) { return v.id === selectedId; }) || clones.some(function (v) { return MIMO_CLONE_PREFIX + v.id === selectedId; });
        return preset + cloneGroup + (known || !selectedId ? '' : '<option value="' + escapeHtml(selectedId) + '" selected>' + escapeHtml(selectedId + '（自定义）') + '</option>');
    }

    /** 按引擎隔离显示：只露出当前引擎自己的字段，避免 Edge 音色串进 MiMo 下拉这类混淆 */
    function openVoiceSettings(name) {
        if (!name) return;
        const current = getVoiceConfig(name) || { engine: 'edge', voiceId: 'zh-CN-XiaoxiaoNeural', resourceId: '' };
        const currentEngine = current.engine;
        const params = edgeSpeechParams(current);
        const body = '<div class="eca-audio-tip">别名会继承主角色的配置。Edge 可直接使用；MiniMax / 豆包 / MiMo 需要在音频设置中填写凭据。自定义情绪会按引擎能力降级或传入语音指令。</div>'
            + '<div class="eca-audio-row"><label>引擎</label><select id="eca-voice-engine"><option value="edge"' + (currentEngine === 'edge' ? ' selected' : '') + '>Edge（免费）</option><option value="minimax"' + (currentEngine === 'minimax' ? ' selected' : '') + '>MiniMax</option><option value="doubao"' + (currentEngine === 'doubao' ? ' selected' : '') + '>豆包</option><option value="mimo"' + (currentEngine === 'mimo' ? ' selected' : '') + '>MiMo（小米）</option></select></div>'
            + '<div class="eca-audio-row" data-eca-for="edge"><label>Edge 音色</label><select id="eca-edge-voice">' + edgeVoiceOptionsHtml(currentEngine === 'edge' ? current.voiceId : '') + '</select></div>'
            + '<div class="eca-audio-row" data-eca-for="edge"><label>语速 %</label><input type="number" id="eca-edge-rate" min="-50" max="50" step="1" value="' + params.rate + '"><label>音调 Hz</label><input type="number" id="eca-edge-pitch" min="-50" max="50" step="1" value="' + params.pitch + '"><span class="eca-audio-tip">仅本角色生效，初始值取自音频设置的全局默认</span></div>'
            + '<div class="eca-audio-row" data-eca-for="mimo"><label>MiMo 音色</label><select id="eca-mimo-voice">' + mimoVoiceOptionsHtml(currentEngine === 'mimo' ? current.voiceId : '') + '</select></div>'
            + '<div class="eca-audio-row" data-eca-for="minimax doubao"><label>音色 ID</label><input id="eca-voice-id" value="' + escapeHtml(currentEngine === 'minimax' || currentEngine === 'doubao' ? current.voiceId : '') + '" placeholder="MiniMax voice_id / 豆包 speaker"></div>'
            + '<div class="eca-audio-row" data-eca-for="doubao"><label>豆包 Resource ID</label><input id="eca-resource-id" value="' + escapeHtml(current.resourceId || '') + '" placeholder="如 seed-tts-2.0"></div>';
        const root = audioModal('eca-voice-settings', '语音设置 · ' + escapeHtml(name), body, '<button type="button" data-audio-close>取消</button><button type="button" class="primary" id="eca-voice-save">保存</button>');
        const engineSelect = root.querySelector('#eca-voice-engine');
        const edgeSelect = root.querySelector('#eca-edge-voice');
        const mimoSelect = root.querySelector('#eca-mimo-voice');
        const voiceInput = root.querySelector('#eca-voice-id');
        const syncVoiceUi = function () {
            const value = engineSelect.value;
            root.querySelectorAll('[data-eca-for]').forEach(function (row) {
                row.style.display = row.getAttribute('data-eca-for').split(' ').indexOf(value) === -1 ? 'none' : '';
            });
        };
        engineSelect.addEventListener('change', syncVoiceUi); syncVoiceUi();
        root.querySelector('#eca-voice-save').addEventListener('click', function () {
            const engineValue = engineSelect.value;
            let voiceId = '';
            if (engineValue === 'edge') voiceId = edgeSelect.value;
            else if (engineValue === 'mimo') voiceId = mimoSelect.value;
            else voiceId = String(voiceInput.value || '').trim();
            const value = { engine: engineValue, voiceId: voiceId, resourceId: root.querySelector('#eca-resource-id').value.trim() };
            if (engineValue === 'edge') {
                value.rate = root.querySelector('#eca-edge-rate').value.trim();
                value.pitch = root.querySelector('#eca-edge-pitch').value.trim();
            }
            if (!value.voiceId || (engineValue === 'doubao' && !value.resourceId)) { toast('请填写音色 ID；豆包还需要 Resource ID', true); return; }
            setVoiceConfig(name, value); root.style.display = 'none'; refreshAudioButtons(); toast('已保存「' + name + '」的语音配置');
        });
    }

    function edgePingSummary() {
        if (String(ttsConfig.edge.proxyUrl || '').trim()) return '固定使用自定义代理，未启用自动选择';
        if (!edgeServers.length) return '尚未检测（首次合成时会自动检测）';
        const top = edgeServers.slice(0, 3).map(function (s) { return s.name + ' ' + Math.round(s.latency) + 'ms'; }).join('、');
        return '可用 ' + edgeServers.length + '/' + EDGE_PROXY_SERVERS.length + '：' + top + (edgeServers.length > 3 ? ' 等' : '');
    }

    function renderMimoCloneRows(root) {
        const box = root.querySelector('#eca-mimo-clones');
        if (!box) return;
        const clones = getMimoClones();
        box.innerHTML = clones.length ? clones.map(function (voice) {
            return '<div class="eca-cache-item"><div class="eca-cache-meta"><div class="eca-cache-text">' + escapeHtml(voice.nickname) + '</div><div class="eca-cache-sub">' + escapeHtml(String(voice.mime || 'audio')) + ' · ' + formatBytes(Number(voice.sizeBytes) || 0) + '</div></div><button class="eca-cache-action" data-clone-del="' + escapeHtml(voice.id) + '">✕</button></div>';
        }).join('') : '<div class="eca-audio-tip">还没有复刻音色。上传一段参考音频即可克隆音色，可添加多个、各自独立。</div>';
    }

    function openTtsSettings() {
        const c = ttsConfig;
        const body = '<div class="eca-audio-tip">凭据独立保存在情绪头像的 localStorage 中，不读取 st-immersive-sound。文本会发送到你配置的代理服务。</div>'
            + '<div class="eca-audio-section"><h4>Edge</h4><div class="eca-audio-tip">代理留空则由脚本自动探活择优、失败自动轮换；填入地址后固定只用该地址。</div><div class="eca-audio-row"><label>自定义代理</label><input id="eca-edge-proxy" value="' + escapeHtml(c.edge.proxyUrl) + '" placeholder="留空 = 自动选择可用代理"></div><div class="eca-audio-row"><label>代理状态</label><span class="eca-audio-tip" id="eca-edge-ping-status">' + escapeHtml(edgePingSummary()) + '</span><button type="button" id="eca-edge-ping">检测代理</button></div><div class="eca-audio-row"><label>持久化</label><input type="checkbox" id="eca-edge-persist"' + (c.edge.persist ? ' checked' : '') + '><span>默认关闭（仅内存缓存）</span></div></div>'
            + '<div class="eca-audio-section"><h4>MiniMax</h4><div class="eca-audio-row"><label>API Key</label><input type="password" id="eca-mm-key" value="' + escapeHtml(c.minimax.apiKey) + '"></div><div class="eca-audio-row"><label>平台</label><select id="eca-mm-platform"><option value="cn"' + (c.minimax.platform === 'cn' ? ' selected' : '') + '>国内</option><option value="io"' + (c.minimax.platform === 'io' ? ' selected' : '') + '>国际</option></select></div><div class="eca-audio-row"><label>模型</label><input id="eca-mm-model" value="' + escapeHtml(c.minimax.model) + '"></div><div class="eca-audio-row"><label>持久化</label><input type="checkbox" id="eca-mm-persist"' + (c.minimax.persist ? ' checked' : '') + '><span>默认开启</span></div></div>'
            + '<div class="eca-audio-section"><h4>豆包</h4><div class="eca-audio-row"><label>App ID</label><input id="eca-db-app" value="' + escapeHtml(c.doubao.appId) + '"></div><div class="eca-audio-row"><label>Access Key</label><input type="password" id="eca-db-key" value="' + escapeHtml(c.doubao.accessKey) + '"></div><div class="eca-audio-row"><label>UID</label><input id="eca-db-uid" value="' + escapeHtml(c.doubao.uid) + '"></div><div class="eca-audio-row"><label>持久化</label><input type="checkbox" id="eca-db-persist"' + (c.doubao.persist ? ' checked' : '') + '><span>默认开启</span></div></div>'
            + '<div class="eca-audio-section"><h4>MiMo（小米）</h4><div class="eca-audio-tip">在 api.xiaomimimo.com 申请 API Key；每个角色的音色在「语音设置」里选。可上传参考音频做音色复刻（见下方），voicedesign 文字描述音色未支持。</div><div class="eca-audio-row"><label>API Key</label><input type="password" id="eca-mimo-key" value="' + escapeHtml(c.mimo.apiKey) + '"></div><div class="eca-audio-row"><label>Base URL</label><input id="eca-mimo-base" value="' + escapeHtml(c.mimo.baseUrl) + '"></div><div class="eca-audio-row"><label>模型</label><input id="eca-mimo-model" value="' + escapeHtml(c.mimo.model) + '"></div><div class="eca-audio-row"><label>格式</label><select id="eca-mimo-format"><option value="wav"' + (c.mimo.format === 'wav' ? ' selected' : '') + '>wav</option><option value="mp3"' + (c.mimo.format === 'mp3' ? ' selected' : '') + '>mp3</option></select></div><div class="eca-audio-row"><label>持久化</label><input type="checkbox" id="eca-mimo-persist"' + (c.mimo.persist ? ' checked' : '') + '><span>默认开启</span></div><div class="eca-audio-row"><label>复刻音色</label></div><div class="eca-cache-list" id="eca-mimo-clones"></div><div class="eca-audio-row"><label>新增复刻</label><input id="eca-mimo-clone-nick" placeholder="音色昵称"><button type="button" id="eca-mimo-clone-pick">选择参考音频</button><button type="button" id="eca-mimo-clone-add">添加</button><input type="file" id="eca-mimo-clone-file" accept="audio/*" style="display:none"><span class="eca-audio-tip" id="eca-mimo-clone-file-label">未选择文件（≤10MB）</span></div></div>'
            + '<div class="eca-audio-section"><h4>缓存清理</h4><div class="eca-audio-row"><label>保留天数</label><input type="number" id="eca-cache-days" min="1" value="' + c.cacheDays + '"><label>最大条数</label><input type="number" id="eca-cache-count" min="1" value="' + c.cacheMaxEntries + '"><label>最大 MB</label><input type="number" id="eca-cache-mb" min="1" value="' + c.cacheMaxMb + '"></div></div>';
        const root = audioModal('eca-audio-settings', '音频设置', body, '<button type="button" data-audio-close>取消</button><button type="button" class="primary" id="eca-tts-save">保存</button>');
        const pingBtn = root.querySelector('#eca-edge-ping');
        pingBtn.addEventListener('click', function () {
            const status = root.querySelector('#eca-edge-ping-status');
            pingBtn.disabled = true; status.textContent = '检测中…';
            pingEdgeServers(true).then(function (servers) {
                pingBtn.disabled = false; status.textContent = edgePingSummary();
                toast(servers.length ? '检测完成：' + servers.length + ' 个代理可用' : '所有代理都不可用', !servers.length);
            });
        });
        const cloneFile = root.querySelector('#eca-mimo-clone-file');
        const cloneLabel = root.querySelector('#eca-mimo-clone-file-label');
        let pendingCloneFile = null;
        root.querySelector('#eca-mimo-clone-pick').addEventListener('click', function () { cloneFile.click(); });
        cloneFile.addEventListener('change', function () {
            pendingCloneFile = (cloneFile.files && cloneFile.files[0]) || null;
            cloneLabel.textContent = pendingCloneFile ? pendingCloneFile.name + ' · ' + formatBytes(pendingCloneFile.size) : '未选择文件（≤10MB）';
        });
        root.querySelector('#eca-mimo-clone-add').addEventListener('click', function () {
            if (!pendingCloneFile) { toast('请先选择参考音频文件', true); return; }
            if (pendingCloneFile.size > MIMO_CLONE_MAX_BYTES) { toast('参考音频超过 10 MB', true); return; }
            const nickname = root.querySelector('#eca-mimo-clone-nick').value.trim();
            const reader = new topWindow.FileReader();
            reader.onload = function () {
                addMimoCloneVoice({ nickname: nickname, base64: String(reader.result || '').split(',')[1] || '', mime: pendingCloneFile.type || 'audio/mpeg', sizeBytes: pendingCloneFile.size }).then(function () {
                    pendingCloneFile = null; cloneFile.value = '';
                    root.querySelector('#eca-mimo-clone-nick').value = '';
                    cloneLabel.textContent = '未选择文件（≤10MB）';
                    renderMimoCloneRows(root);
                    toast('已添加复刻音色「' + nickname + '」，可在角色「语音设置」里选用');
                }).catch(function (error) { toast('添加失败：' + (error && error.message || error), true); });
            };
            reader.onerror = function () { toast('读取参考音频失败', true); };
            reader.readAsDataURL(pendingCloneFile);
        });
        root.addEventListener('click', function (ev) {
            const del = ev.target.closest ? ev.target.closest('[data-clone-del]') : null;
            if (!del) return;
            const entry = getMimoClones().filter(function (v) { return v.id === del.dataset.cloneDel; })[0];
            if (!entry || !uiConfirm('删除复刻音色「' + entry.nickname + '」？参考音频会一并删除')) return;
            deleteMimoCloneVoice(entry.id).then(function () { renderMimoCloneRows(root); toast('已删除复刻音色'); });
        });
        renderMimoCloneRows(root);
        root.querySelector('#eca-tts-save').addEventListener('click', function () {
            c.edge.proxyUrl = root.querySelector('#eca-edge-proxy').value.trim(); c.edge.persist = root.querySelector('#eca-edge-persist').checked;
            c.minimax.apiKey = root.querySelector('#eca-mm-key').value.trim(); c.minimax.platform = root.querySelector('#eca-mm-platform').value; c.minimax.model = root.querySelector('#eca-mm-model').value.trim(); c.minimax.persist = root.querySelector('#eca-mm-persist').checked;
            c.doubao.appId = root.querySelector('#eca-db-app').value.trim(); c.doubao.accessKey = root.querySelector('#eca-db-key').value.trim(); c.doubao.uid = root.querySelector('#eca-db-uid').value.trim(); c.doubao.persist = root.querySelector('#eca-db-persist').checked;
            c.mimo.apiKey = root.querySelector('#eca-mimo-key').value.trim(); c.mimo.baseUrl = root.querySelector('#eca-mimo-base').value.trim() || 'https://api.xiaomimimo.com/v1'; c.mimo.model = root.querySelector('#eca-mimo-model').value.trim() || 'mimo-v2.5-tts'; c.mimo.format = root.querySelector('#eca-mimo-format').value; c.mimo.persist = root.querySelector('#eca-mimo-persist').checked;
            c.cacheDays = Math.max(1, Number(root.querySelector('#eca-cache-days').value) || 30); c.cacheMaxEntries = Math.max(1, Number(root.querySelector('#eca-cache-count').value) || 200); c.cacheMaxMb = Math.max(1, Number(root.querySelector('#eca-cache-mb').value) || 512);
            persistTtsConfig(); pruneTtsCache(); root.style.display = 'none'; toast('音频设置已保存');
        });
    }

    function formatBytes(size) { if (size < 1024) return size + ' B'; if (size < 1048576) return (size / 1024).toFixed(1) + ' KB'; return (size / 1048576).toFixed(1) + ' MB'; }

    function openTtsCachePanel() {
        ttsGetAll().then(function (records) {
            records.sort(function (a, b) { return b.createdAt - a.createdAt; });
            const rows = records.length ? records.map(function (record) {
                const id = 'eca-cache-' + (audioEntrySeq++); audioEntries.set(id, record);
                return '<div class="eca-cache-item"><div class="eca-cache-meta"><div class="eca-cache-text" title="' + escapeHtml(record.text) + '">' + escapeHtml(record.text) + '</div><div class="eca-cache-sub">' + escapeHtml(record.engine) + ' · ' + escapeHtml(record.voiceId) + ' · ' + formatBytes(record.size || record.blob.size) + ' · ' + new Date(record.createdAt).toLocaleString() + '</div></div><button class="eca-cache-action" data-cache-play="' + id + '">▶</button><button class="eca-cache-action" data-cache-download="' + id + '">⬇</button><button class="eca-cache-action" data-cache-delete="' + id + '">✕</button></div>';
            }).join('') : '<div class="eca-audio-tip">暂无持久化音频。</div>';
            const root = audioModal('eca-cache-panel', '语音缓存', '<div class="eca-audio-tip">共 ' + records.length + ' 条，Edge 默认不写入这里。</div><div class="eca-cache-list">' + rows + '</div>', '<button type="button" id="eca-cache-prune">清理过期</button><button type="button" id="eca-cache-clear">清空全部</button><button type="button" data-audio-close>关闭</button>');
            root.addEventListener('click', function (ev) {
                const play = ev.target.closest && ev.target.closest('[data-cache-play]');
                const download = ev.target.closest && ev.target.closest('[data-cache-download]');
                const del = ev.target.closest && ev.target.closest('[data-cache-delete]');
                if (play || download || del) {
                    const record = audioEntries.get((play || download || del).dataset[play ? 'cachePlay' : download ? 'cacheDownload' : 'cacheDelete']);
                    if (!record) return;
                    if (play) { stopCurrentAudio(); const audio = new topWindow.Audio(); const url = (topWindow.URL || URL).createObjectURL(record.blob); currentAudio = audio; currentAudioUrl = url; currentAudioButton = null; audio.src = url; audio.onended = function () { if (currentAudio === audio) stopCurrentAudio(); }; audio.play().catch(function () { stopCurrentAudio(); }); }
                    else if (download) { const url = (topWindow.URL || URL).createObjectURL(record.blob); const a = doc.createElement('a'); a.href = url; a.download = '情绪头像-' + String(record.voiceId || 'audio').replace(/[^\w\-一-龥]+/g, '_') + '.' + (record.mime && record.mime.indexOf('wav') !== -1 ? 'wav' : 'mp3'); a.click(); setTimeout(function () { (topWindow.URL || URL).revokeObjectURL(url); }, 1000); }
                    else { ttsDelete(record.key).then(function () { ttsMemoryCache.delete(record.key); root.style.display = 'none'; openTtsCachePanel(); }); }
                }
            });
            root.querySelector('#eca-cache-prune').addEventListener('click', function () { pruneTtsCache().then(function () { root.style.display = 'none'; openTtsCachePanel(); }); });
            root.querySelector('#eca-cache-clear').addEventListener('click', function () { if (uiConfirm('清空全部持久化语音缓存？')) ttsClear().then(function () { ttsMemoryCache.clear(); root.style.display = 'none'; openTtsCachePanel(); }); });
        }).catch(function (e) { toast('读取语音缓存失败：' + (e.message || e), true); });
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
        if (characters.indexOf(name) !== -1 || aliasToPrimary[name]) return false;
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
        delete aliases[name];
        persistAliases();
        rebuildCharacterIndex();
        persistCharacters();
        if (selectedCharacter === name) selectedCharacter = characters[0] || null;
        delete voiceMap[name];
        persistVoiceMap();
        applyInjection();
        return deleteCharacterAvatars(name).then(function () { return true; });
    }

    function renameCharacter(oldName, newName) {
        newName = String(newName || '').trim();
        if (!newName || newName.length > 30 || /[{}()]/.test(newName)) return Promise.resolve(false);
        if (characters.indexOf(newName) !== -1) return Promise.resolve(false);
        if (aliasToPrimary[newName] && aliasToPrimary[newName] !== oldName) return Promise.resolve(false);
        const group = findGroupByChar(oldName);
        if (!group) return Promise.resolve(false);
        // 别名表随主名迁移；新名若原是自己的别名则从列表移除
        if (aliases[oldName]) {
            const kept = aliases[oldName].filter(function (a) { return a !== newName; });
            delete aliases[oldName];
            if (kept.length) aliases[newName] = kept;
            persistAliases();
        }
        group.members[group.members.indexOf(oldName)] = newName;
        if (voiceMap[oldName]) {
            voiceMap[newName] = voiceMap[oldName];
            delete voiceMap[oldName];
            persistVoiceMap();
        }
        rebuildCharacterIndex();
        persistCharacters();
        if (selectedCharacter === oldName) selectedCharacter = newName;
        applyInjection();
        return renameCharacterAvatars(oldName, newName).then(function () { return true; });
    }

    /**
     * 写入某角色的别名列表（数组或逗号/顿号分隔字符串）。
     * 与主名同名、列表内重复的项静默忽略；格式非法或与其他主名/别名冲突则整体拒绝返回 null。
     * 空列表 = 清除该角色全部别名。成功返回去重后的别名数组。
     */
    function setAliases(name, list) {
        if (characters.indexOf(name) === -1) return null;
        const raw = Array.isArray(list) ? list : String(list || '').split(/[，,、]+/);
        const cleaned = [];
        for (let i = 0; i < raw.length; i++) {
            const alias = String(raw[i] || '').trim();
            if (!alias || alias === name || cleaned.indexOf(alias) !== -1) continue;
            if (alias.length > 30 || /[{}()]/.test(alias)) return null;
            if (characters.indexOf(alias) !== -1) return null;
            if (aliasToPrimary[alias] && aliasToPrimary[alias] !== name) return null;
            cleaned.push(alias);
        }
        if (cleaned.length) aliases[name] = cleaned;
        else delete aliases[name];
        rebuildCharacterIndex();
        persistAliases();
        return cleaned;
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

    /** 单格上传入口：降采样（长边 256）后入库；情绪词须为固定词或格式合法的自定义词 */
    function uploadAvatarFile(character, emotion, file) {
        if (!EMOTION_SET.has(emotion) && !validateEmotionName(emotion)) {
            return Promise.reject(new Error('非法情绪词：' + emotion));
        }
        return downscaleBlob(file, 256).then(function (blob) {
            return saveAvatar(character, emotion, blob);
        });
    }

    /**
     * 文件名含情绪名即命中（候选 = 固定 + 已知自定义），多个命中取最先出现者；
     * 未命中且传入 character 时，按「角色名-情绪.png」前缀派生新情绪（贴合拆图命名约定）。
     * 均无命中返回 null。
     */
    function matchEmotionFromName(name, character) {
        let best = null;
        let bestIdx = Infinity;
        const text = String(name || '');
        allEmotions.forEach(function (emo) {
            const idx = text.indexOf(emo);
            if (idx !== -1 && idx < bestIdx) { best = emo; bestIdx = idx; }
        });
        if (best || !character) return best;
        if (text.indexOf(character) !== 0) return null;
        let rest = text.slice(character.length);
        const sep = rest.charAt(0);
        if (sep !== '-' && sep !== '_' && sep !== ' ') return null;
        rest = rest.slice(1).trim();
        const dot = rest.lastIndexOf('.');
        if (dot > 0) rest = rest.slice(0, dot);
        rest = rest.trim();
        if (!validateEmotionName(rest) || EMOTION_SET.has(rest)) return null;
        return rest;
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
            + '    </div>'
            + '    <div class="eca-detail" id="eca-detail"></div>'
            + '  </div>'
            + '  <div class="eca-footer">'
            + '    <div class="eca-footer-left">'
            + '      <button class="eca-add eca-add-char" id="eca-add-char">＋ 新增角色</button>'
            + '      <button class="eca-add eca-add-group" id="eca-add-group">＋ 新增分组</button>'
            + '      <div class="eca-footer-divider"></div>'
            + '      <div class="eca-footer-tools">'
            + '        <button class="eca-add eca-add-group" id="eca-tts-settings-btn" title="配置三种语音引擎">音频设置</button>'
            + '        <button class="eca-add eca-add-group" id="eca-cache-btn" title="管理持久化语音">语音缓存</button>'
            + '        <button class="eca-add eca-add-char" id="eca-diag-btn" title="生成无控制台排障报告">⚙ 排障</button>'
            + '      </div>'
            + '    </div>'
            + '    <div class="eca-footer-right eca-footer-actions">'
            + '      <label class="eca-switch" title="开启后将头像标记规则注入酒馆上下文"><input type="checkbox" id="eca-enabled"> 启用提示词注入</label>'
            + '      <label class="eca-switch" title="开启后点击 AI 楼层头像可播放语音"><input type="checkbox" id="eca-tts-enabled"> 启用语音播放</label>'
            + '      <div class="eca-size"><span>头像大小</span>'
            + '        <input type="range" id="eca-size-range" min="1.5" max="5" step="0.1">'
            + '        <span class="eca-size-val" id="eca-size-val"></span></div>'
            + '      <label class="eca-switch" title="输出完成后统一替换头像，流式闪烁时使用"><input type="checkbox" id="eca-delay-render"> 延时渲染</label>'
            + '      <label class="eca-switch" title="勾选切为顶端首行平齐，不勾选为垂直居中"><input type="checkbox" id="eca-top-align"> 置顶</label>'
            + '    </div>'
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
        // 点遮罩空白关闭：只响应直接落在遮罩根节点上的点击，弹窗内部不误关
        root.addEventListener('click', function (ev) {
            if (ev.target === root) { closePanel(); return; }
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
            const aliasBtn = target.closest ? target.closest('#eca-alias-btn') : null;
            if (aliasBtn) { aliasFlow(selectedCharacter); return; }
            const batch = target.closest ? target.closest('#eca-batch-btn') : null;
            if (batch) { openBatchDialog(selectedCharacter); return; }
            const voiceBtn = target.closest ? target.closest('#eca-voice-btn') : null;
            if (voiceBtn) { openVoiceSettings(selectedCharacter); return; }
            const ttsSettingsBtn = target.closest ? target.closest('#eca-tts-settings-btn') : null;
            if (ttsSettingsBtn) { openTtsSettings(); return; }
            const cacheBtn = target.closest ? target.closest('#eca-cache-btn') : null;
            if (cacheBtn) { openTtsCachePanel(); return; }
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
            const cellDel = target.closest ? target.closest('.eca-cell-del') : null;
            if (cellDel && cellDel.dataset.emotion) { removeEmotionFlow(selectedCharacter, cellDel.dataset.emotion); return; }
            const addCell = target.closest ? target.closest('.eca-cell-add') : null;
            if (addCell) { addEmotionFlow(); return; }
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
                        applyInjection();
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
                applyInjection();
                renderPanel();
                let msg = '已导入 ' + done + ' 张（' + selectedCharacter + '）';
                if (failed) msg += '，失败 ' + failed + ' 张';
                toast(msg, failed > 0);
                if (skipped.length) {
                    toast('未匹配到情绪词，已跳过：' + skipped.join('、'), true);
                }
            };
            files.forEach(function (file) {
                const matched = matchEmotionFromName(file.name, selectedCharacter);
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
        });
        const delayRenderCb = root.querySelector('#eca-delay-render');
        delayRenderCb.addEventListener('change', function () {
            setDelayRender(delayRenderCb.checked);
            toast(delayRenderCb.checked ? '已开启延时渲染，输出完成后替换头像' : '已关闭延时渲染，恢复实时替换');
        });
        const topAlignCb = root.querySelector('#eca-top-align');
        topAlignCb.addEventListener('change', function () {
            setTopAlign(topAlignCb.checked);
            toast(topAlignCb.checked ? '已切换为顶端首行平齐' : '已切换为垂直居中');
        });
        const ttsCb = root.querySelector('#eca-tts-enabled');
        ttsCb.addEventListener('change', function () {
            setTtsEnabled(ttsCb.checked);
            toast(ttsCb.checked ? '语音按钮已开启' : '语音按钮已关闭');
        });
        const diagBtn = root.querySelector('#eca-diag-btn');
        if (diagBtn) diagBtn.addEventListener('click', openDiagDialog);
    }

    function syncPanelControls() {
        if (!panelEl) return;
        const cb = panelEl.querySelector('#eca-enabled');
        if (cb) cb.checked = settings.enabled;
        const ttsCb = panelEl.querySelector('#eca-tts-enabled');
        if (ttsCb) ttsCb.checked = settings.ttsEnabled !== false;
        const delayRenderCb = panelEl.querySelector('#eca-delay-render');
        if (delayRenderCb) delayRenderCb.checked = !!settings.delayRender;
        const topAlignCb = panelEl.querySelector('#eca-top-align');
        if (topAlignCb) topAlignCb.checked = !!settings.topAlign;
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
                    const aliasList = aliases[name] || [];
                    return '<div class="eca-char-item' + (name === selectedCharacter ? ' active' : '') + '" draggable="true" data-name="' + escapeHtml(name) + '">'
                        + '<span class="eca-char-name">' + escapeHtml(name) + '</span>'
                        + (aliasList.length ? '<span class="eca-char-alias" title="其它姓名：' + escapeHtml(aliasList.join('、')) + '">+' + aliasList.length + '</span>' : '')
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
            detail.innerHTML = '<div class="eca-detail-empty">左侧新增一个角色后，在这里为其配置各情绪头像</div>';
        } else {
            const renderCell = function (emotion, extraCls) {
                const src = avatarCache.get(selectedCharacter + '_' + emotion);
                const imgHtml = src
                    ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(emotion) + '">'
                    : '<div class="eca-cell-empty">' + escapeHtml(emotion) + '</div>';
                return '<div class="eca-cell' + (extraCls || '') + '" data-emotion="' + escapeHtml(emotion) + '" title="点击上传/更换「' + escapeHtml(emotion) + '」头像">'
                    + (extraCls ? '<button class="eca-cell-del" data-emotion="' + escapeHtml(emotion) + '" title="删除该情绪及头像">✕</button>' : '')
                    + '<div class="eca-cell-img">' + imgHtml + '</div>'
                    + '<div class="eca-cell-name">' + escapeHtml(emotion) + '</div>'
                    + '</div>';
            };
            const cells = EMOTIONS.map(function (emotion) { return renderCell(emotion); }).join('')
                + getCustomEmotions(selectedCharacter).map(function (emotion) { return renderCell(emotion, ' eca-cell-custom'); }).join('')
                + '<div class="eca-cell eca-cell-add" title="新增自定义情绪：输入名称后立即上传图片（仅作用于该角色）">'
                + '<div class="eca-cell-img"><div class="eca-cell-empty">＋</div></div>'
                + '<div class="eca-cell-name">新增情绪</div>'
                + '</div>';
            const aliasTip = aliases[selectedCharacter] && aliases[selectedCharacter].length
                ? '；其它姓名：' + escapeHtml(aliases[selectedCharacter].join('、')) : '';
            detail.innerHTML = ''
                + '<div class="eca-detail-head"><b>' + escapeHtml(selectedCharacter) + '</b>'
                + '<button class="eca-mini-btn" id="eca-voice-btn">语音设置</button>'
                + '<button class="eca-mini-btn" id="eca-batch-btn">批量导入大图</button>'
                + '<button class="eca-mini-btn" id="eca-rename-btn">改名</button>'
                + '<button class="eca-mini-btn" id="eca-alias-btn">多姓名</button></div>'
                + '<div class="eca-detail-tip">点击格子上传 / 更换单张头像；多选文件按文件名自动匹配情绪（「角色名-情绪.png」可直接落地新情绪）；缺图时自动回落「默认」' + aliasTip + '</div>'
                + '<div class="eca-grid">' + cells + '</div>';
        }
        syncPanelControls();
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

    /** 新增自定义情绪：输名 → 立即选图；取消选图则标签不落地（纯派生，无残留） */
    function addEmotionFlow() {
        if (!selectedCharacter) return;
        const input = uiPrompt('新增情绪名（1-8 字，不含括号与下划线，仅作用于「' + selectedCharacter + '」）：', '');
        if (input === null) return;
        const emotion = String(input).trim();
        if (!validateEmotionName(emotion) || EMOTION_SET.has(emotion)) { toast('情绪名无效（1-8 字，不含括号与下划线）或已存在', true); return; }
        if (avatarCache.has(selectedCharacter + '_' + emotion)) { toast('「' + selectedCharacter + '」已有情绪「' + emotion + '」', true); return; }
        fileInputEl.dataset.emotion = emotion;
        fileInputEl.click();
    }

    function removeEmotionFlow(character, emotion) {
        if (!character || !emotion) return;
        if (!uiConfirm('删除「' + character + '」的情绪「' + emotion + '」及其头像？')) return;
        deleteAvatar(character, emotion).then(function () {
            applyInjection();
            renderPanel();
            toast('已删除情绪「' + emotion + '」（' + character + '）');
        });
    }

    /** 多姓名绑定：编辑某角色的别名列表（逗号/顿号分隔，留空清除） */
    function aliasFlow(name) {
        if (!name) return;
        const current = (aliases[name] || []).join('，');
        const input = uiPrompt('为「' + name + '」绑定其它姓名（多个用逗号分隔，AI 输出任一姓名都显示这套头像；留空清除）：', current);
        if (input === null) return;
        const result = setAliases(name, input);
        if (result === null) { toast('别名无效（1-30 字，不含括号）或与其他角色姓名冲突', true); return; }
        renderPanel();
        toast(result.length
            ? '「' + name + '」已绑定 ' + result.length + ' 个其它姓名：' + result.join('、')
            : '已清除「' + name + '」的其它姓名');
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
            return m && m.emotion && (EMOTION_SET.has(m.emotion) || validateEmotionName(m.emotion));
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

    /** 互斥下拉：已被其他格选走的情绪不再出现在选项里；新情绪经「✎ 自定义…」录入 */
    function updateAllBatchSelectOptions() {
        const used = {};
        batchMappings.forEach(function (m) { if (m.emotion) used[m.emotion] = true; });
        const options = EMOTIONS.concat(getCustomEmotions(batchCharacter));
        batchEl.querySelectorAll('.eca-bcell select').forEach(function (sel) {
            const index = parseInt(sel.dataset.index, 10);
            const current = batchMappings[index].emotion;
            let html = '<option value="">-- 跳过 --</option>';
            options.forEach(function (emo) {
                if (used[emo] && emo !== current) return;
                html += '<option value="' + escapeHtml(emo) + '"' + (emo === current ? ' selected' : '') + '>' + emo + '</option>';
            });
            if (current && options.indexOf(current) === -1) {
                html += '<option value="' + escapeHtml(current) + '" selected>' + escapeHtml(current) + '</option>';
            }
            html += '<option value="__custom__">✎ 自定义…</option>';
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
            applyInjection();
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
            let value = sel.value;
            if (value === '__custom__') {
                const prev = batchMappings[index].emotion;
                const used = {};
                batchMappings.forEach(function (m, i) { if (m.emotion && i !== index) used[m.emotion] = true; });
                const input = uiPrompt('自定义情绪名（1-8 字，不含括号与下划线）：', '');
                const name = input === null ? '' : String(input).trim();
                if (validateEmotionName(name) && !used[name]) {
                    value = name;
                } else {
                    toast(input === null ? '已取消，保持原选择' : '情绪名无效或已被其它格使用', true);
                    value = prev || '';
                }
            }
            batchMappings[index].emotion = value;
            batchMappings[index].skip = !value;
            sel.closest('.eca-bcell').classList.toggle('skipped', !value);
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
        /* 打标埋点桥（排障检测用，默认关闭，不改变行为） */
        setDebug(on) {
            debugOn = !!on;
            try { topWindow.localStorage.setItem(LS_DEBUG, debugOn ? '1' : '0'); } catch (e) { /* 存储不可用时仅本次会话生效 */ }
            dbg('打标 ' + (debugOn ? '开启' : '关闭') + '（v' + VERSION + '）');
            return debugOn;
        },
        getDebug() { return debugOn; },
        /** 打标快照：判定链关键状态一次取全 */
        debugStatus() {
            return {
                version: VERSION,
                debug: debugOn,
                delayRender: !!settings.delayRender,
                generationActive: generationActive,
                pendingFullScan: pendingFullScan,
                dirtyRoots: dirtyRoots.size,
                timers: {
                    scan: scanTimer !== null,
                    stream: streamTimer !== null,
                    complete: completeTimer !== null,
                    delayFallback: delayFallbackTimer !== null,
                },
                observerAttached: streamObserver !== null,
                hasChat: !!doc.getElementById('chat'),
            };
        },
        /** 打标日志环形缓冲（控制台抓不到 iframe 日志时取这里）；clear=true 取完清空 */
        debugLogs(clear) {
            const copy = dbgBuffer.slice();
            if (clear) dbgBuffer.length = 0;
            return copy;
        },
        /** 合成事件喂给与真实事件完全相同的处理函数（不触碰聊天数据），仅供检测 */
        debugEmit(name, args) {
            const a = args || [];
            if (name === 'generation_started') { onGenerationStarted(a[0], a[1], a[2]); return true; }
            if (name === 'completion') { scheduleCompletionScan(); return true; }
            if (name === 'scan') { scheduleScan(); return true; }
            return false;
        },
        /** 调试/harness 桥：直接向内存缓存塞头像（不落库） */
        seedAvatar(name, emotion, src) { allEmotions.add(emotion); avatarCache.set(name + '_' + emotion, src); },
        /** 调试/harness 桥：整体替换登记名单（不落 localStorage，但会同步重注提示词） */
        setCharacters(list) {
            groups = [{ id: makeGroupId(), name: '默认组', enabled: true, members: list.slice() }];
            rebuildCharacterIndex();
            applyInjection();
        },
        getCharacters() { return characters.slice(); },
        setEnabled: setEnabled,
        setSize: setSize,
        setTopAlign: setTopAlign,
        setDelayRender: setDelayRender,
        setTtsEnabled: setTtsEnabled,
        getTtsConfig() { return JSON.parse(JSON.stringify(ttsConfig)); },
        setTtsConfig(config) { ttsConfig = mergeTtsConfig(config); persistTtsConfig(); return JSON.parse(JSON.stringify(ttsConfig)); },
        getVoiceConfig: getVoiceConfig,
        setVoiceConfig: setVoiceConfig,
        extractQuotedText: extractQuotedText,
        getAvatarSpeech: getAvatarSpeech,
        refreshAudioButtons: refreshAudioButtons,
        getTtsCache: ttsGetAll,
        pingEdgeServers: function (force) { return pingEdgeServers(!!force); },
        getEdgeServers: function () { return edgeServers.map(function (s) { return { name: s.name, url: s.url, latency: s.latency }; }); },
        getMimoCloneVoices: function () { return JSON.parse(JSON.stringify(getMimoClones())); },
        addMimoCloneVoice: addMimoCloneVoice,
        deleteMimoCloneVoice: deleteMimoCloneVoice,
        clearTtsCache: function () { ttsMemoryCache.clear(); return ttsClear(); },
        clearTtsMemory: function () { ttsMemoryCache.clear(); },
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
            const oldUrls = [];
            avatarCache.forEach(function (url) { oldUrls.push(url); });
            avatarCache.clear();
            allEmotions = new Set(EMOTIONS);
            syncRenderedAvatars(doc);
            oldUrls.forEach(revokeCacheUrl);
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
        /* 自定义情绪与别名桥 */
        getEmotionsOf(name) { return EMOTIONS.concat(characters.indexOf(name) !== -1 ? getCustomEmotions(name) : []); },
        setAliases: setAliases,
        getAliases() { return JSON.parse(JSON.stringify(aliases)); },
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
        openDiagDialog: openDiagDialog,
        buildDiagReport: buildDiagReport,
        /* 批量导入桥 */
        autoDetectGrid: autoDetectGrid,
        sliceGridCell: sliceGridCell,
        runBatchImport: runBatchImport,
        openBatchDialog: openBatchDialog,
        closeBatchDialog: closeBatchDialog,
        openBatchDialogWithImage: openBatchDialogWithImage,
    };

    // ============================================
    // 面板内排障诊断（无需控制台）
    // ============================================
    function buildDiagReport() {
        const lines = [];
        const add = function (ok, name, value) { lines.push((ok ? '✓ ' : '✗ ') + name + '：' + value); };
        lines.push('【情绪头像排障报告】 v' + VERSION);
        lines.push('时间：' + new Date().toLocaleString());
        lines.push('页面：' + topWindow.location.href);
        lines.push('UA：' + topWindow.navigator.userAgent);
        lines.push('视口：' + topWindow.innerWidth + '×' + topWindow.innerHeight + '，dpr=' + topWindow.devicePixelRatio);
        add(!!doc.getElementById('eca-styles'), '消息样式表', doc.getElementById('eca-styles') ? '#eca-styles 已注入' : '未注入');
        add(!!doc.getElementById('eca-size-style'), '尺寸变量', doc.getElementById('eca-size-style') ? '#eca-size-style 已注入' : '未注入');
        add(true, '事件缺失', (function () {
            const keys = ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_RECEIVED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'APP_READY', 'CHAT_CHANGED'];
            const missing = keys.filter(function (k) { return !Env.events[k]; });
            return missing.length ? missing.join('/') : '无';
        })());
        add(true, '延时渲染', settings.delayRender ? '开启' : '关闭');
        add(true, '登记角色', characters.length + ' 个：' + (characters.join('、') || '（空）'));
        const mesTexts = doc.querySelectorAll('.mes_text');
        add(mesTexts.length > 0, '找到 .mes_text', mesTexts.length + ' 个');
        const avatars = doc.querySelectorAll('.eca-avatar');
        add(avatars.length > 0, '已渲染头像', avatars.length + ' 个');
        const placeholders = doc.querySelectorAll('.eca-avatar.eca-placeholder');
        if (placeholders.length > 0) {
            add(false, '占位头像', placeholders.length + ' 个（角色未登记/缺图，非 CSS 问题）');
        }
        // 头像父元素分布：定位两列布局为何未生效（父元素必须为 p 且头像在首位）
        if (avatars.length > 0) {
            let parentP = 0, parentPFirst = 0, parentOther = 0, parentMesText = 0;
            const parentSamples = {};
            for (let i = 0; i < avatars.length; i++) {
                const parent = avatars[i].parentElement;
                if (!parent) continue;
                const tag = parent.tagName.toLowerCase();
                const isP = tag === 'p';
                const isFirst = parent.firstElementChild === avatars[i];
                if (isP) {
                    parentP++;
                    if (isFirst) parentPFirst++;
                } else {
                    parentOther++;
                    if (tag === 'div' && parent === findMesTextRoot(parent)) parentMesText++;
                }
                const key = tag + (isP ? (isFirst ? '+首' : '+非首') : (isFirst ? '+首' : '+非首'));
                parentSamples[key] = (parentSamples[key] || 0) + 1;
            }
            lines.push('头像父元素：p=' + parentP + ' 个（其中首位 ' + parentPFirst + '）｜非 p=' + parentOther + ' 个｜分布=' + JSON.stringify(parentSamples));
        }
        const ps = doc.querySelectorAll('.mes_text p.eca-p');
        if (avatars.length > 0) {
            add(ps.length > 0, '段首两列化 p.eca-p', ps.length + ' 个');
        }
        if (ps.length > 0) {
            const p = ps[0];
            const cs = topWindow.getComputedStyle(p);
            add(cs.display === 'flex', '计算样式 display', cs.display);
            lines.push('  alignItems=' + cs.alignItems + '；gap=' + cs.gap);
            const avatar = p.querySelector(':scope > .eca-avatar');
            const text = p.querySelector(':scope > .eca-text');
            if (avatar) {
                const acs = topWindow.getComputedStyle(avatar);
                lines.push('  头像：w=' + acs.width + ' h=' + acs.height + ' flex=' + acs.flex);
            }
            if (text) {
                const tcs = topWindow.getComputedStyle(text);
                lines.push('  文本块：flex=' + tcs.flex + ' borderLeft=' + tcs.borderLeft + ' paddingLeft=' + tcs.paddingLeft);
            }
        }
        // 首个含头像楼层的 DOM 结构摘要：判定头像为何未进入两列布局
        if (avatars.length > 0 && ps.length === 0) {
            const firstMes = Array.prototype.find.call(mesTexts, function (m) { return m.querySelector('.eca-avatar'); });
            if (firstMes) {
                const childSummary = Array.prototype.map.call(firstMes.children, function (ch) {
                    return ch.tagName.toLowerCase() + (ch.className && typeof ch.className === 'string' ? '.' + ch.className.split(' ').join('.') : '');
                }).slice(0, 14);
                lines.push('楼层子节点结构：' + JSON.stringify(childSummary));
                const av = firstMes.querySelector('.eca-avatar');
                const parent = av.parentElement;
                if (parent) {
                    const pc = topWindow.getComputedStyle(parent);
                    lines.push('头像父元素：<' + parent.tagName.toLowerCase() + '> class="' + parent.className + '"'
                        + ' 首位=' + (parent.firstElementChild === av)
                        + ' display=' + pc.display
                        + ' position=' + pc.position + ' paddingLeft=' + pc.paddingLeft);
                    if (parent.tagName.toLowerCase() === 'p') {
                        const before = parent.firstElementChild === av ? '' : '（头像前有其他元素：' + (parent.firstElementChild ? parent.firstElementChild.tagName.toLowerCase() : '无') + '）';
                        lines.push('  p 内子元素：' + Array.prototype.map.call(parent.children, function (ch) {
                            return ch.tagName.toLowerCase() + (ch.className && typeof ch.className === 'string' ? '.' + ch.className.split(' ').join('.') : '');
                        }).join(', ') + before);
                    }
                }
            }
        }
        // :has() 兼容性检测（两列兜底依赖它）：CSS.supports 对 :has 相对选择器有误报，用 querySelector 语法解析判定
        let hasSupport = true;
        try { doc.querySelector(':scope a:has(> i)'); } catch (e) { hasSupport = false; }
        add(hasSupport, ':has() 兼容性', hasSupport ? '支持' : '不支持（两列兜底失效）');
        const status = topWindow.EmoAvatar && topWindow.EmoAvatar.debugStatus ? topWindow.EmoAvatar.debugStatus() : null;
        if (status) lines.push('脚本状态：' + JSON.stringify(status));
        if (dbgBuffer.length > 0) {
            lines.push('判定链日志（最近 ' + dbgBuffer.length + ' 条）：');
            dbgBuffer.slice(-30).forEach(function (l) { lines.push('  ' + l); });
        } else if (!debugOn) {
            lines.push('提示：判定链日志未开启。如需流式排障，先在控制台执行 EmoAvatar.setDebug(true) 再生成一条消息。');
        }
        let verdict = '全部正常';
        if (!doc.getElementById('eca-styles')) verdict = '样式未注入：检查 #eca-styles 幂等早退或 topWindow 作用域';
        else if (mesTexts.length === 0) verdict = '页面无 .mes_text：检查酒馆是否已加载消息楼层';
        else if (avatars.length === 0 && mesTexts.length > 0) {
            const hasTag = Array.prototype.some.call(mesTexts, function (m) { return m.textContent.indexOf('{') !== -1; });
            verdict = hasTag ? '消息含 { 标签但未替换：检查角色登记与延时渲染开关' : '消息不含 {角色(情绪)} 标签：AI 未按提示词输出';
        }
        else if (placeholders.length > 0) verdict = '头像显示为灰色占位：角色未登记或缺少对应情绪图';
        else if (avatars.length > 0 && ps.length === 0) verdict = '头像已替换但两列布局未生效：检查 .mes_text 是否使用 p 包裹或 :has() 兼容性';
        lines.push('结论：' + verdict);
        return lines.join('\n');
    }

    function openDiagDialog() {
        let dlg = doc.getElementById('eca-diag-panel');
        if (!dlg) {
            dlg = doc.createElement('div');
            dlg.id = 'eca-diag-panel';
            dlg.innerHTML = ''
                + '<div class="eca-modal">'
                + '  <div class="eca-header"><span>排障诊断</span><button class="eca-close" title="关闭">×</button></div>'
                + '  <div class="eca-diag-body">'
                + '    <div class="eca-diag-tip">报告已生成。复制后发给开发者即可定位，无需控制台。</div>'
                + '    <pre id="eca-diag-report"></pre>'
                + '    <div class="eca-diag-actions"><button class="eca-primary" id="eca-diag-copy">复制报告</button>'
                + '    <button class="eca-primary" id="eca-diag-refresh">重新生成</button></div>'
                + '  </div>'
                + '</div>';
            doc.body.appendChild(dlg);
            dlg.querySelector('.eca-close').addEventListener('click', function () { dlg.style.display = 'none'; });
            dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.style.display = 'none'; });
            dlg.querySelector('#eca-diag-copy').addEventListener('click', function () {
                const text = dlg.querySelector('#eca-diag-report').textContent;
                if (topWindow.navigator.clipboard && topWindow.navigator.clipboard.writeText) {
                    topWindow.navigator.clipboard.writeText(text).then(function () { toast('报告已复制'); }).catch(function () { topWindow.prompt('复制失败，请手动全选：', text); });
                } else {
                    topWindow.prompt('请手动复制：', text);
                }
            });
            dlg.querySelector('#eca-diag-refresh').addEventListener('click', function () {
                dlg.querySelector('#eca-diag-report').textContent = buildDiagReport();
            });
        }
        dlg.querySelector('#eca-diag-report').textContent = buildDiagReport();
        dlg.style.display = 'flex';
    }

    // ============================================
    // 入口
    // ============================================
    function init() {
        loadState();
        injectStyles();
        applySizeVar();
        applyAlignMode();
        addMenuButton();
        hookEvents();
        applyInjection();
        // 先预热素材，再首次扫描，避免启动时先生成无法升级的占位头像。
        preloadAvatars().then(function () {
            applyInjection();
            scanAll();
        });
    }
    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
