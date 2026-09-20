// 复现酒馆渲染管线：引号美化正则 + showdown（simpleLineBreaks:true 等，同 reloadMarkdownProcessor）
// 目的：对比「标签前无空行」vs「标签前有空行」产出的 HTML 结构
const showdown = require('D:/SillyTavern/SillyTavern/node_modules/showdown/dist/showdown.js');

const converter = new showdown.Converter({
    emoji: true,
    literalMidWordUnderscores: true,
    parseImgDimensions: true,
    tables: true,
    underline: true,
    simpleLineBreaks: true,
    strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
});

function quoteBeautify(mes) {
    // 与 messageFormatting 中引号美化正则一致（p1 英文直引号 / p2 中文弯引号）
    return mes.replace(
        /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(\u201C.*?\u201D)|(\u00AB.*?\u00BB)|(\u300C.*?\u300D)|(\u300E.*?\u300F)|(\uFF02.*?\uFF02)/gim,
        function (match, p1, p2) {
            if (p1) return `<q>"${p1.slice(1, -1)}"</q>`;
            if (p2) return `<q>“${p2.slice(1, -1)}”</q>`;
            return match;
        },
    );
}

// 用户提供的那条测试消息
const raw = `王天霸再也压不住火，粗大的手指一指那老神医，破锣嗓子震得水榭柱子直掉灰。
{王天霸(愤怒)}“到底好没好？！老子的水都快把这木头肚皮灌满了！再不让老子动，老子现在就拔出来，把这破马劈了当柴烧！”

老神医趴在马腹下，盯着刻度，额头冷汗直冒，咽了口唾沫，战战兢兢地回道：

{王天霸(默认)}"这是一条测试消息"王天霸说。

测试测试测试测试`;

const beautified = quoteBeautify(raw);
const html = converter.makeHtml(beautified);

console.log('===== 引号美化后（showdown 输入）=====');
console.log(beautified);
console.log('\n===== showdown 输出 HTML =====');
console.log(html);

// 简易解析：打印每个 <p> 的开头，标注标签位置是否为 p 首元素
console.log('\n===== <p> 结构分析 =====');
const pList = html.match(/<p>[\s\S]*?<\/p>/g) || [];
pList.forEach((p, i) => {
    const inner = p.slice(3, -4);
    const tagIdx = inner.indexOf('{王天霸');
    const firstIsTag = tagIdx === 0;
    console.log(`P${i}: 标签在文本内位置=${tagIdx}, 标签是否p首=${firstIsTag}`);
    console.log(`   内容: ${inner.slice(0, 80)}${inner.length > 80 ? '…' : ''}`);
});
