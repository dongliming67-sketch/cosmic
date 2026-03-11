// ═══════════════════════════════════════════════════════════
// COSMIC 拆分智能分析系统 - 主服务器
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { callAI, callAIWithRetry, MODEL_MAP } = require('./ai-client');
const { FUNCTION_EXTRACTION_PROMPT, COSMIC_SPLIT_PROMPT, DOCUMENT_UNDERSTANDING_PROMPT, COVERAGE_VERIFICATION_PROMPT, SUPPLEMENTARY_EXTRACTION_PROMPT } = require('./prompts');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3001;

// ═══════════════════════ 中间件 ═══════════════════════

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 服务前端静态文件
if (process.env.NODE_ENV === 'production') {
    // 生产环境：只服务构建后的 dist 目录
    const clientBuildPath = path.join(__dirname, '..', 'client', 'dist');
    if (fs.existsSync(clientBuildPath)) {
        app.use(express.static(clientBuildPath));
    }
} else {
    // 开发环境：服务 client 根目录（配合 Vite 开发服务器）
    const clientRootPath = path.join(__dirname, '..', 'client');
    app.use(express.static(clientRootPath));
}

// 文件上传配置
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = path.extname(file.originalname).toLowerCase();
        const allowedExts = ['.docx', '.doc', '.txt', '.md'];
        if (allowedExts.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`不支持的文件格式: ${ext}，请上传 .docx, .txt 或 .md 文件`));
        }
    }
});

// Multer错误处理中间件
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: '文件大小超过限制（最大50MB）' });
        }
        return res.status(400).json({ error: `上传错误: ${err.message}` });
    } else if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
};

// 当前选择的模型
let currentModel = process.env.DEFAULT_MODEL || 'DeepSeek-V3-671B';

// ═══════════════════════ 工具函数 ═══════════════════════

/**
 * 获取用户配置的模型名称
 */
function getModelName(userConfig) {
    if (userConfig?.model) {
        return MODEL_MAP[userConfig.model] || userConfig.model;
    }
    return currentModel;
}

/**
 * 清理文本（去除不可见字符）
 */
function sanitizeText(text) {
    if (!text) return '';
    return text
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
}

/**
 * 解析Markdown表格
 */
function parseMarkdownTable(markdown) {
    if (!markdown) return [];

    const tableData = [];
    const lines = markdown.split('\n');
    let inTable = false;
    let headerFound = false;
    let currentFunctionalUser = '';
    let currentTriggerEvent = '';
    let currentFunctionalProcess = '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

        // 检查是否是表头
        if (trimmed.includes('功能用户') || trimmed.includes('触发事件') || trimmed.includes('功能过程')) {
            headerFound = true;
            inTable = true;
            continue;
        }

        // 跳过分隔行
        if (/^\|[\s:-]+\|/.test(trimmed)) continue;

        if (!headerFound) continue;

        // 解析数据行
        const cells = trimmed.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim());
        if (cells.length < 7) continue;

        const [funcUser, triggerEvt, funcProcess, subProcessDesc, dataMovementType, dataGroup, dataAttributes] = cells;

        // 更新当前功能用户、触发事件、功能过程
        if (funcUser) currentFunctionalUser = funcUser;
        if (triggerEvt) currentTriggerEvent = triggerEvt;
        if (funcProcess) currentFunctionalProcess = funcProcess;

        // 验证数据移动类型
        const dmt = (dataMovementType || '').toUpperCase().trim();
        if (!['E', 'R', 'W', 'X'].includes(dmt)) continue;

        // 清理子过程描述
        const cleanSubProcess = sanitizeText(subProcessDesc);
        if (!cleanSubProcess) continue;

        tableData.push({
            functionalUser: currentFunctionalUser,
            triggerEvent: currentTriggerEvent,
            functionalProcess: dmt === 'E' ? currentFunctionalProcess : '',
            subProcessDesc: cleanSubProcess,
            dataMovementType: dmt,
            dataGroup: sanitizeText(dataGroup) || '待补充',
            dataAttributes: sanitizeText(dataAttributes) || '待补充'
        });
    }

    return deduplicateTableData(tableData);
}

/**
 * 从功能过程名称中提取关键词（用于去重时添加前缀）
 * @param {string} processName - 功能过程名称
 * @param {number} length - 关键词长度，默认4，可逐步增加以获取更独特的关键词
 */
function extractProcessKeyword(processName, length = 4) {
    if (!processName) return '';
    // 去掉章节标记
    const clean = processName.replace(/\[.*?\]\s*/, '').trim();
    if (clean.length <= length) return clean;
    return clean.substring(0, length);
}

/**
 * 尝试用逐渐增长的关键词长度来生成唯一名称
 * 关键词自然融入名称中：数据组前缀拼接，子过程描述在动词后插入
 * @param {string} original - 原始名称
 * @param {string} processName - 所属功能过程名称
 * @param {Set} existingNames - 已存在的名称集合（lowercase）
 * @param {string|null} verbPrefix - 动词前缀（如"读取"），有则在动词后插入关键词
 * @returns {string} 唯一化后的名称
 */
function makeUniqueName(original, processName, existingNames, verbPrefix = null) {
    const cleanProcess = (processName || '').replace(/\[.*?\]\s*/, '').trim();
    if (!cleanProcess) return original;

    // 自动检测动词前缀（如果调用方没传）
    if (!verbPrefix) {
        const autoVerb = original.match(/^(接收|读取|保存|更新|返回|呈现|记录|检索|获取|查询|写入|删除|批量)/);
        if (autoVerb) verbPrefix = autoVerb[1];
    }

    // 逐步增加关键词长度: 4 → 6 → 8 → 全名
    const lengths = [4, 6, 8, cleanProcess.length];
    for (const len of lengths) {
        const keyword = cleanProcess.substring(0, Math.min(len, cleanProcess.length));
        let candidate;
        if (verbPrefix) {
            // 动词 + 关键词 + 剩余部分，如 "读取" + "用户管理" + "信息"
            candidate = verbPrefix + keyword + original.substring(verbPrefix.length);
        } else {
            // 关键词 + 原名，如 "用户管理" + "信息表"
            candidate = keyword + original;
        }
        if (!existingNames.has(candidate.toLowerCase().trim())) {
            return candidate;
        }
    }
    // 兜底：完整功能过程名 + 原名
    return cleanProcess + original;
}

/**
 * 获取当前行所属的功能过程名称
 */
function getRowProcessName(tableData, rowIndex) {
    // 向上查找最近的E行的功能过程名称
    for (let i = rowIndex; i >= 0; i--) {
        if (tableData[i].dataMovementType === 'E' || tableData[i].functionalProcess) {
            if (tableData[i].functionalProcess) return tableData[i].functionalProcess;
        }
    }
    return '';
}

/**
 * 对解析后的表格数据进行深度去重
 * 1. 数据组名称全局不重复
 * 2. 子过程描述全局不重复
 * 策略：使用功能过程的语义关键词区分，关键词长度逐步递增，不使用数字编号
 */
function deduplicateTableData(tableData) {
    if (!tableData || tableData.length === 0) return tableData;

    const MAX_ROUNDS = 5;
    let totalDataGroupFixes = 0;
    let totalSubProcessFixes = 0;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        let fixedThisRound = 0;

        // ——— 步骤1：重建每行对应的功能过程映射 ———
        let currentProcess = '';
        const rowProcessMap = [];
        for (let i = 0; i < tableData.length; i++) {
            if (tableData[i].dataMovementType === 'E' && tableData[i].functionalProcess) {
                currentProcess = tableData[i].functionalProcess;
            }
            rowProcessMap[i] = currentProcess;
        }

        // ——— 步骤2：数据组跨功能过程去重（关键词前缀） ———
        const dataGroupMap = new Map();
        for (let i = 0; i < tableData.length; i++) {
            const dg = tableData[i].dataGroup;
            if (!dg || dg === '待补充') continue;
            const key = dg.toLowerCase().trim();
            if (!dataGroupMap.has(key)) dataGroupMap.set(key, []);
            dataGroupMap.get(key).push({ index: i, processName: rowProcessMap[i] });
        }

        // 收集当前所有数据组名（用于检查唯一性）
        const allDgNames = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const dg = tableData[i].dataGroup;
            if (dg && dg !== '待补充') allDgNames.add(dg.toLowerCase().trim());
        }

        for (const [key, rows] of dataGroupMap.entries()) {
            const uniqueProcesses = [...new Set(rows.map(r => r.processName))];
            if (uniqueProcesses.length <= 1) continue;

            let firstKept = false;
            for (const row of rows) {
                if (!firstKept) { firstKept = true; continue; }
                const original = tableData[row.index].dataGroup;
                const newName = makeUniqueName(original, row.processName, allDgNames);
                if (newName !== original) {
                    allDgNames.delete(original.toLowerCase().trim());
                    tableData[row.index].dataGroup = newName;
                    allDgNames.add(newName.toLowerCase().trim());
                    fixedThisRound++;
                    totalDataGroupFixes++;
                }
            }
        }

        // ——— 步骤3：子过程描述跨功能过程去重（关键词插入） ———
        const subDescMap = new Map();
        for (let i = 0; i < tableData.length; i++) {
            const desc = tableData[i].subProcessDesc;
            if (!desc) continue;
            const key = desc.toLowerCase().trim();
            if (!subDescMap.has(key)) subDescMap.set(key, []);
            subDescMap.get(key).push({ index: i, processName: rowProcessMap[i] });
        }

        const allDescNames = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const desc = tableData[i].subProcessDesc;
            if (desc) allDescNames.add(desc.toLowerCase().trim());
        }

        for (const [key, rows] of subDescMap.entries()) {
            const uniqueProcesses = [...new Set(rows.map(r => r.processName))];
            if (uniqueProcesses.length <= 1) continue;

            let firstKept = false;
            for (const row of rows) {
                if (!firstKept) { firstKept = true; continue; }
                const original = tableData[row.index].subProcessDesc;
                const prefixMatch = original.match(/^(接收|读取|保存|更新|返回|呈现|记录|检索|获取|查询|写入|删除|批量)/);
                const newName = makeUniqueName(original, row.processName, allDescNames, prefixMatch ? prefixMatch[1] : null);
                if (newName !== original) {
                    allDescNames.delete(original.toLowerCase().trim());
                    tableData[row.index].subProcessDesc = newName;
                    allDescNames.add(newName.toLowerCase().trim());
                    fixedThisRound++;
                    totalSubProcessFixes++;
                }
            }
        }

        // ——— 步骤4：数据组绝对去重（关键词前缀融入） ———
        const dgAbsCheck = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const dg = tableData[i].dataGroup;
            if (!dg || dg === '待补充') continue;
            const key = dg.toLowerCase().trim();
            if (dgAbsCheck.has(key)) {
                const newName = makeUniqueName(dg, rowProcessMap[i], dgAbsCheck);
                tableData[i].dataGroup = newName;
                dgAbsCheck.add(newName.toLowerCase().trim());
                fixedThisRound++;
                totalDataGroupFixes++;
            } else {
                dgAbsCheck.add(key);
            }
        }

        // ——— 步骤5：子过程描述绝对去重（关键词融入） ———
        const descAbsCheck = new Set();
        for (let i = 0; i < tableData.length; i++) {
            const desc = tableData[i].subProcessDesc;
            if (!desc) continue;
            const key = desc.toLowerCase().trim();
            if (descAbsCheck.has(key)) {
                const newName = makeUniqueName(desc, rowProcessMap[i], descAbsCheck);
                tableData[i].subProcessDesc = newName;
                descAbsCheck.add(newName.toLowerCase().trim());
                fixedThisRound++;
                totalSubProcessFixes++;
            } else {
                descAbsCheck.add(key);
            }
        }

        // ——— 检查是否还有残留重复 ———
        if (fixedThisRound === 0) {
            if (round > 1) {
                console.log(`✅ 第 ${round} 轮检查通过，无重复项`);
            }
            break;
        }

        console.log(`🔧 第 ${round} 轮去重: 修正了 ${fixedThisRound} 处重复`);

        if (round === MAX_ROUNDS) {
            console.log(`⚠️ 达到最大去重轮次(${MAX_ROUNDS})，执行强制关键词去重`);
            forceKeywordDedup(tableData, rowProcessMap);
        }
    }

    if (totalDataGroupFixes > 0 || totalSubProcessFixes > 0) {
        console.log(`📊 去重汇总: 共修正 ${totalDataGroupFixes} 个数据组名称, ${totalSubProcessFixes} 个子过程描述`);
    }

    return tableData;
}

/**
 * 强制关键词去重 — 最终兜底：用功能过程关键词自然融入名称
 */
function forceKeywordDedup(tableData, rowProcessMap) {
    // 数据组去重
    const dgSeen = new Set();
    for (let i = 0; i < tableData.length; i++) {
        const dg = tableData[i].dataGroup;
        if (!dg || dg === '待补充') continue;
        const key = dg.toLowerCase().trim();
        if (dgSeen.has(key)) {
            const newName = makeUniqueName(dg, rowProcessMap[i], dgSeen);
            tableData[i].dataGroup = newName;
            dgSeen.add(newName.toLowerCase().trim());
        } else {
            dgSeen.add(key);
        }
    }

    // 子过程描述去重
    const descSeen = new Set();
    for (let i = 0; i < tableData.length; i++) {
        const desc = tableData[i].subProcessDesc;
        if (!desc) continue;
        const key = desc.toLowerCase().trim();
        if (descSeen.has(key)) {
            const newName = makeUniqueName(desc, rowProcessMap[i], descSeen);
            tableData[i].subProcessDesc = newName;
            descSeen.add(newName.toLowerCase().trim());
        } else {
            descSeen.add(key);
        }
    }
}

/**
 * 从功能过程列表文本中提取功能列表
 */
function extractFunctionsFromText(text) {
    const functions = [];
    const sections = text.split(/(?=##)/);

    let currentFunc = null;

    for (const section of sections) {
        const lines = section.trim().split('\n');
        for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed.startsWith('##触发事件：') || trimmed.startsWith('## 触发事件：')) {
                if (currentFunc && currentFunc.functionName) {
                    functions.push(currentFunc);
                }
                currentFunc = {
                    triggerEvent: trimmed.replace(/^##\s*触发事件[：:]/, '').trim(),
                    functionalUser: '',
                    functionName: '',
                    description: '',
                    selected: true
                };
            } else if (trimmed.startsWith('##功能用户：') || trimmed.startsWith('## 功能用户：')) {
                if (currentFunc) {
                    currentFunc.functionalUser = trimmed.replace(/^##\s*功能用户[：:]/, '').trim();
                }
            } else if (trimmed.startsWith('##功能过程：') || trimmed.startsWith('## 功能过程：')) {
                if (currentFunc) {
                    currentFunc.functionName = trimmed.replace(/^##\s*功能过程[：:]/, '').trim();
                }
            } else if (trimmed.startsWith('##功能过程描述：') || trimmed.startsWith('## 功能过程描述：')) {
                if (currentFunc) {
                    currentFunc.description = trimmed.replace(/^##\s*功能过程描述[：:]/, '').trim();
                }
            }
        }
    }

    if (currentFunc && currentFunc.functionName) {
        functions.push(currentFunc);
    }

    return functions;
}

// ═══════════════════════ API路由 ═══════════════════════

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        hasApiKey: !!process.env.IFLOW_API_KEY,
        currentModel: currentModel,
        availableModels: Object.values(MODEL_MAP)
    });
});

// 切换模型
app.post('/api/switch-model', (req, res) => {
    const { model } = req.body;
    const modelName = MODEL_MAP[model] || model;
    currentModel = modelName;
    console.log(`✅ 模型已切换到: ${currentModel}`);
    res.json({ success: true, model: currentModel });
});

// API配置（开放平台模式）
app.post('/api/config', (req, res) => {
    const { apiKey } = req.body;
    if (apiKey && apiKey.includes('你的') && apiKey.includes('密钥')) {
        return res.status(400).json({ error: '请填入真实的 API Key' });
    }
    res.json({ success: true, message: 'API配置已更新' });
});

// ═══════════════════════ 文档解析 ═══════════════════════

app.post('/api/parse-word', upload.single('file'), handleMulterError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传文件' });
        }

        const ext = path.extname(req.file.originalname).toLowerCase();
        let text = '';

        console.log(`📄 解析文件: ${req.file.originalname}, 大小: ${req.file.size} bytes`);

        if (ext === '.docx') {
            const result = await mammoth.extractRawText({ buffer: req.file.buffer });
            text = result.value;
        } else if (ext === '.txt' || ext === '.md') {
            text = req.file.buffer.toString('utf-8');
        } else if (ext === '.doc') {
            return res.status(400).json({ error: '不支持旧版.doc格式，请另存为.docx格式' });
        }

        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: '文档内容为空' });
        }

        res.json({
            success: true,
            text,
            filename: req.file.originalname,
            fileSize: req.file.size,
            wordCount: text.length
        });
    } catch (error) {
        console.error('解析文档失败:', error);
        res.status(500).json({ error: '解析文档失败: ' + error.message });
    }
});

// ═══════════════════════ 文档理解 ═══════════════════════

app.post('/api/understand-document', async (req, res) => {
    try {
        const { documentContent, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log('🔍 开始深度理解文档...');
        const modelName = getModelName(userConfig);

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: DOCUMENT_UNDERSTANDING_PROMPT },
                { role: 'user', content: `请分析以下需求文档：\n\n${documentContent}` }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        const reply = completion.choices[0].message.content;

        // 尝试解析JSON
        let understanding = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                understanding = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('JSON解析失败，使用默认结构');
            understanding = {
                projectName: '未识别',
                projectDescription: reply.substring(0, 200),
                coreModules: [],
                totalEstimatedFunctions: 30
            };
        }

        console.log('✅ 文档理解完成');
        res.json({ success: true, understanding });
    } catch (error) {
        console.error('文档理解失败:', error);
        res.status(500).json({ error: '文档理解失败: ' + error.message });
    }
});

// ═══════════════════════ 章节识别 ═══════════════════════

/**
 * 自动识别文档章节结构
 */
function splitIntoChapters(text) {
    if (!text) return [];

    const lines = text.split('\n');
    const chapters = [];

    // 章节标题匹配模式（按优先级排列）
    const headingPatterns = [
        // "第X章" / "第X节"
        /^第[一二三四五六七八九十百千\d]+[章节]\s*.+/,
        // "1." / "2." / "1.1" (数字编号，行首，后面有文字)
        /^\d+(\.\d+)*[\s\.、]\s*[^\d\s].{2,}/,
        // "一、" / "二、" (中文序号)
        /^[一二三四五六七八九十]+[、．\.]\s*.+/,
        // "(一)" / "（一）"
        /^[（(][一二三四五六七八九十\d]+[）)]\s*.+/,
    ];

    // 判断是否为章节标题
    function isHeading(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 3 || trimmed.length > 80) return false;
        return headingPatterns.some(p => p.test(trimmed));
    }

    // 第一遍：找到所有标题行的位置
    const headingPositions = [];
    for (let i = 0; i < lines.length; i++) {
        if (isHeading(lines[i])) {
            headingPositions.push(i);
        }
    }

    if (headingPositions.length === 0) {
        // 没找到章节，整个文档作为一个章节
        return [{
            title: '全文',
            content: text,
            charCount: text.length,
            selected: true
        }];
    }

    // 文档开头到第一个标题之间的内容（如果有的话）
    if (headingPositions[0] > 0) {
        const preContent = lines.slice(0, headingPositions[0]).join('\n').trim();
        if (preContent.length > 50) {
            chapters.push({
                title: '前言/概述',
                content: preContent,
                charCount: preContent.length,
                selected: false // 前言通常不含功能描述
            });
        }
    }

    // 按标题分章
    for (let i = 0; i < headingPositions.length; i++) {
        const startLine = headingPositions[i];
        const endLine = (i < headingPositions.length - 1) ? headingPositions[i + 1] : lines.length;
        const title = lines[startLine].trim();
        const content = lines.slice(startLine, endLine).join('\n').trim();

        chapters.push({
            title,
            content,
            charCount: content.length,
            selected: content.length > 50  // 降低阈值避免跳过精简但重要的章节
        });
    }

    return chapters;
}

app.post('/api/split-chapters', (req, res) => {
    try {
        const { documentContent } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        const chapters = splitIntoChapters(documentContent);
        console.log(`📑 章节识别完成: 共 ${chapters.length} 个章节`);
        chapters.forEach((ch, i) => {
            console.log(`   ${i + 1}. ${ch.title} (${ch.charCount}字${ch.selected ? '' : ', 跳过'})`);
        });

        res.json({ success: true, chapters, count: chapters.length });
    } catch (error) {
        console.error('章节识别失败:', error);
        res.status(500).json({ error: '章节识别失败: ' + error.message });
    }
});

// ═══════════════════════ 功能过程提取（阶段1） ═══════════════════════

app.post('/api/extract-functions', async (req, res) => {
    try {
        const { documentContent, chapterName = '', userGuidelines = '', userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        const chapterInfo = chapterName ? `【${chapterName}】章节的` : '';
        console.log(`📋 开始提取功能过程列表${chapterName ? '（' + chapterName + '）' : ''}...`);
        const modelName = getModelName(userConfig);

        // 构建理解上下文（如果有文档理解结果）
        let understandingHint = '';
        const understanding = req.body.understanding || null;
        if (understanding) {
            const parts = [];

            // 1. 核心模块和功能预估
            if (understanding.coreModules && understanding.coreModules.length > 0) {
                const modulesList = understanding.coreModules.map(m => {
                    const funcs = m.estimatedFunctions || [];
                    const funcList = Array.isArray(funcs) && funcs.length > 0 && typeof funcs[0] === 'object'
                        ? funcs.map(f => f.functionName).join('、')
                        : (Array.isArray(funcs) ? funcs.join('、') : '');
                    return `- ${m.moduleName}: ${funcList}`;
                }).join('\n');
                parts.push(`【功能模块参考】请确保每个模块的功能都被提取：\n${modulesList}`);
            }

            // 2. 业务实体（含生命周期 → 状态变迁功能）
            if (understanding.businessEntities && understanding.businessEntities.length > 0) {
                const entityList = understanding.businessEntities.map(e => {
                    let desc = `- ${e.entityName}`;
                    if (e.hasLifecycle && e.lifecycleStates && e.lifecycleStates.length > 0) {
                        desc += `（生命周期：${e.lifecycleStates.join('→')}，每个状态变迁都是独立功能过程）`;
                    }
                    if (e.crudOperations && e.crudOperations.length > 0) {
                        desc += `（需覆盖操作：${e.crudOperations.join('、')}）`;
                    }
                    return desc;
                }).join('\n');
                parts.push(`【业务实体参考】以下每个业务实体的相关操作都必须提取为独立功能过程：\n${entityList}`);
            }

            // 3. KPI指标体系 → 指标计算/采集功能
            if (understanding.kpiAndMetrics && understanding.kpiAndMetrics.length > 0) {
                const metricsList = understanding.kpiAndMetrics.map(m => {
                    let desc = `- ${m.metricName}`;
                    if (m.relatedEntity) desc += `（关联：${m.relatedEntity}）`;
                    if (m.hasThreshold) desc += `（有阈值判断，需拆出阈值检测和预警通知两个功能）`;
                    return desc;
                }).join('\n');
                parts.push(`【KPI指标体系】以下每个指标的采集/计算/达标率统计都可能是独立功能过程：\n${metricsList}`);
            }

            // 4. 汇总/报表场景
            if (understanding.aggregationAndReports && understanding.aggregationAndReports.length > 0) {
                const aggList = understanding.aggregationAndReports.map(a => {
                    const dims = a.dimensions ? a.dimensions.join('、') : '';
                    const metrics = a.metrics ? a.metrics.join('、') : '';
                    return `- ${a.name}（类型：${a.type}，维度：${dims}，指标：${metrics}，触发：${a.triggerType || ''}）`;
                }).join('\n');
                parts.push(`【汇总/报表需求】以下每个汇总/报表都是独立功能过程，不同维度×不同指标需分别拆出：\n${aggList}`);
            }

            // 5. 业务规则
            if (understanding.businessRules && understanding.businessRules.length > 0) {
                const rulesList = understanding.businessRules.map(r => {
                    return `- ${r.ruleName}：${r.ruleDescription}（触发条件：${r.triggerCondition || ''}→动作：${r.resultAction || ''}）`;
                }).join('\n');
                parts.push(`【业务规则】以下每条规则可能对应1-2个独立功能过程：\n${rulesList}`);
            }

            // 6. 外部接口
            if (understanding.externalInterfaces && understanding.externalInterfaces.length > 0) {
                const ifList = understanding.externalInterfaces.map(i => {
                    return `- ${i.interfaceName}：${i.direction}（对接：${i.externalSystem}，数据：${i.dataDescription}）`;
                }).join('\n');
                parts.push(`【外部接口】每个接口方向是独立功能过程：\n${ifList}`);
            }

            // 7. 功能数量预估
            const total = understanding.totalEstimatedFunctions || '未知';
            const breakdown = understanding.functionBreakdown || {};
            const breakdownStr = Object.entries(breakdown)
                .filter(([k, v]) => v > 0)
                .map(([k, v]) => `${k}: ${v}`)
                .join('、');
            parts.push(`预估总功能过程数量：${total}${breakdownStr ? '（' + breakdownStr + '）' : ''}`);

            if (parts.length > 0) {
                understandingHint = '\n\n' + parts.join('\n\n');
            }
        }

        let userPrompt = `请从以下${chapterInfo}需求文档中提取所有功能过程列表：\n\n${documentContent}${understandingHint}`;
        if (userGuidelines) {
            userPrompt += `\n\n用户特殊要求：${userGuidelines}`;
        }

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: FUNCTION_EXTRACTION_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.5,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        const reply = completion.choices[0].message.content;
        const functions = extractFunctionsFromText(reply);

        console.log(`✅ 提取到 ${functions.length} 个功能过程`);
        res.json({
            success: true,
            functionList: reply,
            functions,
            count: functions.length
        });
    } catch (error) {
        console.error('功能过程提取失败:', error);
        res.status(500).json({ error: '功能过程提取失败: ' + error.message });
    }
});

// ═══════════════════════ COSMIC拆分（阶段2） ═══════════════════════

app.post('/api/cosmic-split', async (req, res) => {
    try {
        const { functionList, documentContent = '', userGuidelines = '', previousResults = [], batchIndex = 0, totalBatches = 1, userConfig = null } = req.body;

        if (!functionList) {
            return res.status(400).json({ error: '缺少功能过程列表' });
        }

        console.log(`🔄 开始COSMIC拆分 (批次 ${batchIndex + 1}/${totalBatches})...`);
        const modelName = getModelName(userConfig);

        // 构建已完成的提示
        let userPrompt = '';
        if (previousResults.length > 0) {
            const completedFunctions = [...new Set(previousResults.map(r => r.functionalProcess).filter(Boolean))];
            userPrompt = `请对以下功能过程列表中【尚未拆分】的功能进行COSMIC拆分。

## 功能过程列表
${functionList}

## 已完成拆分的功能过程（共${completedFunctions.length}个，请勿重复）
${completedFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n')}

**请只拆分上面列表中未出现在"已完成"中的功能过程。**
每个功能过程必须有完整的 E + R(≥1) + W(≥1) + X 子过程。
只输出Markdown表格，不要其他说明。`;
        } else {
            userPrompt = `请对以下功能过程进行COSMIC拆分：\n\n${functionList}`;
        }

        if (documentContent) {
            userPrompt += `\n\n参考文档内容：\n${documentContent.substring(0, 6000)}`;
        }
        if (userGuidelines) {
            userPrompt += `\n\n用户特殊要求：${userGuidelines}`;
        }

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: COSMIC_SPLIT_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.5,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        const reply = completion.choices[0].message.content;

        // 解析表格数据
        const tableData = parseMarkdownTable(reply);

        console.log(`✅ COSMIC拆分完成，解析到 ${tableData.length} 条子过程`);
        res.json({
            success: true,
            reply,
            tableData,
            count: tableData.length
        });
    } catch (error) {
        console.error('COSMIC拆分失败:', error.message);
        console.error('错误详情:', error.status, error.code, JSON.stringify(error.error || {}).substring(0, 300));
        const errMsg = error.message || '未知错误';
        res.status(500).json({ error: 'COSMIC拆分失败: ' + errMsg });
    }
});

// ═══════════════════════ 循环分析（一键完成模式） ═══════════════════════

app.post('/api/continue-analyze', async (req, res) => {
    try {
        const { documentContent, previousResults = [], round = 1, targetFunctions = 30, understanding = null, userGuidelines = '', userConfig = null, coverageVerification: prevCoverage = null } = req.body;

        const completedFunctions = [...new Set(previousResults.map(r => r.functionalProcess).filter(Boolean))];
        const modelName = getModelName(userConfig);

        // 动态调整目标功能数：优先使用文档理解阶段的预估值（上浮10%确保覆盖）
        const effectiveTarget = (understanding?.totalEstimatedFunctions && understanding.totalEstimatedFunctions > targetFunctions)
            ? Math.ceil(understanding.totalEstimatedFunctions * 1.1)
            : targetFunctions;
        if (effectiveTarget !== targetFunctions) {
            console.log(`📊 目标功能数已动态调整: ${targetFunctions} → ${effectiveTarget}（基于文档理解预估）`);
        }

        // 构建理解上下文
        let understandingContext = '';
        if (understanding) {
            const ctxParts = [];

            // 模块功能
            const modules = understanding.coreModules || [];
            if (modules.length > 0) {
                const modulesList = modules.map(m => {
                    const functions = m.estimatedFunctions || [];
                    const funcList = Array.isArray(functions) && functions.length > 0 && typeof functions[0] === 'object'
                        ? functions.map(f => `${f.functionName} (${f.triggerType})`).join('、')
                        : (Array.isArray(functions) ? functions.join('、') : '');
                    return `- ${m.moduleName}: ${funcList}`;
                }).join('\n');
                ctxParts.push(`功能模块：\n${modulesList}`);
            }

            // 业务实体
            if (understanding.businessEntities && understanding.businessEntities.length > 0) {
                const entityList = understanding.businessEntities.map(e => {
                    let desc = `- ${e.entityName}`;
                    if (e.hasLifecycle && e.lifecycleStates) desc += `（状态：${e.lifecycleStates.join('→')}）`;
                    return desc;
                }).join('\n');
                ctxParts.push(`业务实体：\n${entityList}`);
            }

            // KPI指标
            if (understanding.kpiAndMetrics && understanding.kpiAndMetrics.length > 0) {
                const metricsList = understanding.kpiAndMetrics.map(m => `- ${m.metricName}${m.hasThreshold ? '（有阈值预警）' : ''}`).join('\n');
                ctxParts.push(`KPI指标（每个指标的采集/计算/预警可能是独立功能）：\n${metricsList}`);
            }

            // 汇总/报表
            if (understanding.aggregationAndReports && understanding.aggregationAndReports.length > 0) {
                const aggList = understanding.aggregationAndReports.map(a => `- ${a.name}（${a.type}，维度：${(a.dimensions || []).join('、')}）`).join('\n');
                ctxParts.push(`汇总/报表需求（每个都是独立功能）：\n${aggList}`);
            }

            // 业务规则
            if (understanding.businessRules && understanding.businessRules.length > 0) {
                const rulesList = understanding.businessRules.map(r => `- ${r.ruleName}：${r.ruleDescription}`).join('\n');
                ctxParts.push(`业务规则：\n${rulesList}`);
            }

            if (ctxParts.length > 0) {
                understandingContext = '\n\n【文档业务分析参考】\n' + ctxParts.join('\n');
            }
        }

        let userPrompt = '';
        if (round === 1) {
            let guidelinesContext = userGuidelines ? `\n用户特定要求：${userGuidelines}` : '';
            userPrompt = `以下是功能文档内容：
${guidelinesContext}
${documentContent}
${understandingContext}

请对文档中的功能进行COSMIC拆分，目标约 ${effectiveTarget} 个功能过程。

**输出格式**：只输出Markdown表格，不要额外说明。

|功能用户|触发事件|功能过程|子过程描述|数据移动类型|数据组|数据属性|
|:---|:---|:---|:---|:---|:---|:---|

每个功能过程必须有 E + R(≥1) + W(≥1) + X 四种子过程。`;
        } else {
            // 关键修复：第2轮及之后也要传递文档内容，否则AI看不到原文
            // 构建遗漏功能提示（如果有覆盖度验证结果）
            let missedHint = '';
            if (prevCoverage?.missedFunctions?.length > 0) {
                const missedList = prevCoverage.missedFunctions.map((f, i) => {
                    if (typeof f === 'object') return `${i + 1}. ${f.functionName}（${f.reason || ''}）`;
                    return `${i + 1}. ${f}`;
                }).join('\n');
                missedHint = `\n\n## 覆盖度审查发现的遗漏功能（请优先补充这些！）：\n${missedList}`;
            }

            userPrompt = `继续分析文档中尚未拆分的功能过程。

## 原始需求文档（请仔细阅读，找出尚未拆分的功能）：
${documentContent ? documentContent.substring(0, 16000) : '（文档内容未提供）'}
${understandingContext}

## 已完成的功能过程（共${completedFunctions.length}个，请勿重复）：
${completedFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n')}
${missedHint}

## 要求
- 目标 ${effectiveTarget} 个功能过程，当前还差 ${Math.max(0, effectiveTarget - completedFunctions.length)} 个
- 请仔细逐段阅读文档，找出上面"已完成"列表中未覆盖的功能
- 每个功能过程必须有 E + R + W + X 四种子过程
- 只输出Markdown表格，不要其他说明
- 如果文档中的所有功能确实都已完成，回复"[ALL_DONE]"`;
        }

        console.log(`📊 第 ${round} 轮分析，已完成 ${completedFunctions.length} 个功能过程...`);

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: COSMIC_SPLIT_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.5,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            console.error('❌ AI返回空响应:', JSON.stringify(completion, null, 2).substring(0, 500));
            return res.status(500).json({ error: 'AI返回了空响应，请重试或切换模型' });
        }
        const reply = completion.choices[0].message.content;

        // 判断是否完成
        let isDone = false;
        if (reply.includes('[ALL_DONE]') || reply.includes('已完成') || reply.includes('全部拆分')) {
            isDone = true;
        }
        const hasValidTable = reply.includes('|') && (reply.includes('|E|') || reply.includes('| E |'));
        if (!hasValidTable && round > 1) isDone = true;
        // 不再以达到目标数为硬性终止条件，改为日志提示
        if (completedFunctions.length >= effectiveTarget && !isDone) {
            console.log(`📊 已达到目标数 ${effectiveTarget}，但继续检查是否有遗漏...`);
        }
        if (round >= 15) isDone = true;
        if (reply.length < 100 && round > 1) isDone = true;

        // ═══ 自动覆盖度验证（分析即将结束时自动检查遗漏） ═══
        let coverageResult = null;
        if (isDone && round > 1 && documentContent) {
            const currentRoundData = parseMarkdownTable(reply);
            const currentRoundFunctions = [...new Set(currentRoundData.map(r => r.functionalProcess).filter(Boolean))];
            const allFunctions = [...new Set([...completedFunctions, ...currentRoundFunctions])];

            if (allFunctions.length > 0) {
                try {
                    console.log(`🔍 执行自动覆盖度验证（共 ${allFunctions.length} 个功能过程）...`);
                    const verifyCompletion = await callAIWithRetry({
                        messages: [
                            { role: 'system', content: COVERAGE_VERIFICATION_PROMPT },
                            { role: 'user', content: `## 原始需求文档：\n${documentContent}\n\n## 已提取的功能过程列表（共${allFunctions.length}个）：\n${allFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n请严格审查以上功能过程列表是否完整覆盖了需求文档中的所有功能。` }
                        ],
                        model: modelName,
                        temperature: 0.3,
                        max_tokens: 8000
                    });

                    if (verifyCompletion?.choices?.[0]?.message?.content) {
                        const verifyReply = verifyCompletion.choices[0].message.content;
                        try {
                            const jsonMatch = verifyReply.match(/\{[\s\S]*\}/);
                            if (jsonMatch) {
                                coverageResult = JSON.parse(jsonMatch[0]);
                                if (!coverageResult.vagueFunctions) coverageResult.vagueFunctions = [];
                                const missedCount = coverageResult.missedFunctions?.length || 0;
                                const vagueCount = coverageResult.vagueFunctions?.length || 0;
                                console.log(`📊 覆盖度验证: ${coverageResult.coverageScore}分, 遗漏${missedCount}个, 笼统${vagueCount}个`);

                                if (coverageResult.coverageScore < 85 && missedCount > 0 && round < 14) {
                                    console.log('⚠️ 覆盖度不足，将继续补充分析...');
                                    isDone = false;
                                } else {
                                    console.log('✅ 覆盖度验证通过');
                                }
                            }
                        } catch (e) {
                            console.warn('覆盖度验证JSON解析失败:', e.message);
                        }
                    }
                } catch (e) {
                    console.warn('自动覆盖度验证调用失败, 跳过:', e.message);
                }
            }
        }

        res.json({
            success: true, reply, round, isDone,
            completedFunctions: completedFunctions.length,
            targetFunctions: effectiveTarget,
            coverageVerification: coverageResult
        });
    } catch (error) {
        console.error('分析失败:', error);
        res.status(500).json({ error: '分析失败: ' + error.message });
    }
});

// ═══════════════════════ 覆盖度验证 ═══════════════════════

app.post('/api/verify-coverage', async (req, res) => {
    try {
        const { documentContent, extractedFunctions = [], userConfig = null } = req.body;

        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }
        if (extractedFunctions.length === 0) {
            return res.status(400).json({ error: '缺少已提取的功能过程列表' });
        }

        console.log(`🔍 开始覆盖度验证，已提取 ${extractedFunctions.length} 个功能过程...`);
        const modelName = getModelName(userConfig);

        const functionListText = extractedFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n');

        const userPrompt = `## 原始需求文档：
${documentContent}

## 已提取的功能过程列表（共${extractedFunctions.length}个）：
${functionListText}

请严格审查以上功能过程列表是否完整覆盖了需求文档中的所有功能。`;

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: COVERAGE_VERIFICATION_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        // 尝试解析JSON
        let verification = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                verification = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('覆盖度验证JSON解析失败');
            verification = {
                coverageScore: 0,
                totalDocumentFunctions: extractedFunctions.length,
                extractedCount: extractedFunctions.length,
                missedFunctions: [],
                vagueFunctions: [],
                suggestions: ['JSON解析失败，请重试']
            };
        }

        // 确保vagueFunctions字段存在
        if (!verification.vagueFunctions) {
            verification.vagueFunctions = [];
        }

        console.log(`✅ 覆盖度验证完成: ${verification.coverageScore}分, 遗漏${verification.missedFunctions?.length || 0}个功能, 笼统描述${verification.vagueFunctions?.length || 0}个`);
        if (verification.vagueFunctions.length > 0) {
            console.log(`   ⚠️ 以下功能描述过于笼统，需要细化：`);
            verification.vagueFunctions.forEach((vf, i) => {
                console.log(`      ${i + 1}. ${vf.functionName} → ${vf.suggestion}`);
            });
        }
        res.json({ success: true, verification });
    } catch (error) {
        console.error('覆盖度验证失败:', error);
        res.status(500).json({ error: '覆盖度验证失败: ' + error.message });
    }
});

// ═══════════════════════ 补充提取 ═══════════════════════

app.post('/api/extract-supplementary', async (req, res) => {
    try {
        const { documentContent, existingFunctions = [], missedFunctions = [], vagueFunctions = [], userConfig = null } = req.body;

        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log(`🔄 开始补充提取，已有 ${existingFunctions.length} 个功能，遗漏 ${missedFunctions.length} 个，笼统 ${vagueFunctions.length} 个...`);
        const modelName = getModelName(userConfig);

        const existingListText = existingFunctions.map((f, i) => `${i + 1}. ${f}`).join('\n');
        const missedListText = missedFunctions.map((f, i) => {
            if (typeof f === 'object') {
                return `${i + 1}. ${f.functionName}（原因：${f.reason || ''}，分类：${f.category || ''}，文档依据：${f.documentEvidence || ''}）`;
            }
            return `${i + 1}. ${f}`;
        }).join('\n');

        // 构建笼统功能细化提示
        let vagueHint = '';
        if (vagueFunctions.length > 0) {
            const vagueListText = vagueFunctions.map((vf, i) => {
                if (typeof vf === 'object') {
                    return `${i + 1}. "${vf.functionName}" → 建议细化为：${vf.suggestion}`;
                }
                return `${i + 1}. ${vf}`;
            }).join('\n');
            vagueHint = `\n\n## 描述过于笼统需要细化的功能（请替换为更具体的业务功能过程）：\n${vagueListText}\n\n注意：以上笼统功能需要拆分为绑定具体业务对象的多个功能过程。例如"定时汇总数据"应拆分为"定时汇总质差小区KPI指标数据"、"定时汇总地市流量统计数据"等。`;
        }

        const userPrompt = `## 原始需求文档：
${documentContent}

## 已提取的功能过程（共${existingFunctions.length}个，不要重复这些）：
${existingListText}

## 覆盖度审查发现的遗漏功能（请针对这些进行补充提取）：
${missedListText}${vagueHint}

请补充提取上述遗漏的功能过程，同时再次仔细扫描文档看是否有其他遗漏。特别注意数据汇总/统计/报表类功能是否被充分细化拆分。`;

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: SUPPLEMENTARY_EXTRACTION_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.5,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;
        const functions = extractFunctionsFromText(reply);

        console.log(`✅ 补充提取到 ${functions.length} 个新功能过程`);
        res.json({
            success: true,
            functionList: reply,
            functions,
            count: functions.length
        });
    } catch (error) {
        console.error('补充提取失败:', error);
        res.status(500).json({ error: '补充提取失败: ' + error.message });
    }
});

// ═══════════════════════ 表格解析 ═══════════════════════

app.post('/api/parse-table', (req, res) => {
    try {
        const { markdown } = req.body;
        const tableData = parseMarkdownTable(markdown);
        res.json({ success: true, tableData, count: tableData.length });
    } catch (error) {
        res.status(500).json({ error: '表格解析失败: ' + error.message });
    }
});

// ═══════════════════════ 流式对话 ═══════════════════════

app.post('/api/chat/stream', async (req, res) => {
    try {
        const { messages, documentContent, userGuidelines = '', userConfig = null } = req.body;
        const modelName = getModelName(userConfig);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const chatMessages = [
            { role: 'system', content: COSMIC_SPLIT_PROMPT }
        ];

        if (documentContent) {
            let guidelinesText = userGuidelines ? `\n用户要求：${userGuidelines}\n` : '';
            chatMessages.push({
                role: 'user',
                content: `以下是需要进行Cosmic拆分的文档：${guidelinesText}\n\n${documentContent}\n\n请根据内容进行Cosmic拆分，生成Markdown表格。`
            });
        }

        if (messages && messages.length > 0) {
            chatMessages.push(...messages);
        }

        await callAI({
            messages: chatMessages,
            model: modelName,
            stream: true,
            res
        });

        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('流式对话失败:', error.message);
        if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/event-stream');
        }
        res.write(`data: ${JSON.stringify({ error: '调用AI失败: ' + error.message })}\n\n`);
        res.end();
    }
});

// ═══════════════════════ 导出Excel ═══════════════════════

app.post('/api/export-excel', async (req, res) => {
    try {
        const { tableData, filename = 'COSMIC拆分结果' } = req.body;

        if (!tableData || tableData.length === 0) {
            return res.status(400).json({ error: '没有可导出的数据' });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('COSMIC拆分结果');

        // 设置表头
        const headers = ['功能用户', '触发事件', '功能过程', '子过程描述', '数据移动类型', '数据组', '数据属性'];
        const headerRow = worksheet.addRow(headers);

        // 表头样式
        headerRow.eachCell((cell) => {
            cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FF1A1A2E' }
            };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = {
                top: { style: 'thin' },
                bottom: { style: 'thin' },
                left: { style: 'thin' },
                right: { style: 'thin' }
            };
        });

        // 设置列宽
        worksheet.columns = [
            { width: 28 }, // 功能用户
            { width: 14 }, // 触发事件
            { width: 24 }, // 功能过程
            { width: 28 }, // 子过程描述
            { width: 14 }, // 数据移动类型
            { width: 24 }, // 数据组
            { width: 40 }, // 数据属性
        ];

        // 填充数据
        let currentFuncUser = '';
        let currentTrigger = '';
        let currentProcess = '';

        tableData.forEach((row) => {
            const funcUser = row.functionalUser || currentFuncUser;
            const trigger = row.triggerEvent || currentTrigger;
            const process = row.functionalProcess || '';

            if (row.functionalUser) currentFuncUser = row.functionalUser;
            if (row.triggerEvent) currentTrigger = row.triggerEvent;
            if (row.functionalProcess) currentProcess = row.functionalProcess;

            const dataRow = worksheet.addRow([
                row.dataMovementType === 'E' ? funcUser : '',
                row.dataMovementType === 'E' ? trigger : '',
                process,
                row.subProcessDesc || '',
                row.dataMovementType || '',
                row.dataGroup || '',
                row.dataAttributes || ''
            ]);

            // 数据行样式
            dataRow.eachCell((cell, colNumber) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };

                // E行背景色
                if (row.dataMovementType === 'E') {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F7FF' } };
                }

                // 数据移动类型颜色
                if (colNumber === 5) {
                    const colors = { E: 'FF3B82F6', R: 'FF10B981', W: 'FFF59E0B', X: 'FF8B5CF6' };
                    cell.font = { bold: true, color: { argb: colors[row.dataMovementType] || 'FF000000' } };
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
            });
        });

        // 冻结表头
        worksheet.views = [{ state: 'frozen', ySplit: 1 }];

        // 发送文件
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('导出Excel失败:', error);
        res.status(500).json({ error: '导出Excel失败: ' + error.message });
    }
});

// ═══════════════════════ SPA回退路由 ═══════════════════════

if (process.env.NODE_ENV === 'production') {
    app.get('*', (req, res) => {
        const indexPath = path.join(__dirname, '..', 'client', 'dist', 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            res.status(404).json({ error: 'Frontend not built. Run npm run build first.' });
        }
    });
}

// ═══════════════════════ 启动服务 ═══════════════════════

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║         COSMIC 功能规模智能分析拆分系统 v2.0             ║
╠══════════════════════════════════════════════════════════╣
║  🌐 服务地址: http://localhost:${PORT}                    ║
║  🤖 当前模型: ${currentModel.padEnd(40)}║
║  📡 API平台: 心流开放平台 (iflow.cn)                    ║
║  🔑 API密钥: ${process.env.IFLOW_API_KEY ? '已配置 ✅' : '未配置 ❌'}                               ║
╚══════════════════════════════════════════════════════════╝
  `);
});
