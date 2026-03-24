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
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config(); // also try CWD

const { callAI, callAIWithRetry, MODEL_MAP } = require('./ai-client');
const { FUNCTION_EXTRACTION_PROMPT, COSMIC_SPLIT_PROMPT, DOCUMENT_UNDERSTANDING_PROMPT, COVERAGE_VERIFICATION_PROMPT, SUPPLEMENTARY_EXTRACTION_PROMPT, COSMIC_MODULE_RECOGNITION_PROMPT, COSMIC_QUANTITY_PRIORITY_PROMPT } = require('./prompts');
const { NESMA_FUNCTION_EXTRACTION_PROMPT, NESMA_QUANTITY_PRIORITY_PROMPT, NESMA_MODULE_RECOGNITION_PROMPT, NESMA_COVERAGE_VERIFICATION_PROMPT, NESMA_GUOCHANHUA_MIGRATION_PROMPT } = require('./nesma-prompts');
const { authRouter } = require('./auth');
const { initDatabase } = require('./database');


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

// 挂载认证路由
app.use('/api/auth', authRouter);

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
 * 辨别标题 vs 正文的多层过滤：
 *  1. 不同类型标题设不同最大长度（第X章60字, 数字编号30字, 中文序号35字）
 *  2. 以句子标点结尾（。，；：！？…）的行必为正文，排除
 *  3. 含正文特征词（应当/需要/如下/以下等）的行排除
 *  4. 两候选标题之间内容少于30字 → 是列表项而非章节分割点
 *  5. 章节数过多(>20) → 自动收敛到顶层标题
 */
function splitIntoChapters(text) {
    if (!text) return [];

    const lines = text.split('\n');
    const chapters = [];

    // 各类标题模式 + 对应最大长度
    const HEADING_RULES = [
        { pattern: /^第[一二三四五六七八九十百千\d]+[章节篇]\s*.+/, maxLen: 60 },
        { pattern: /^[（(][一二三四五六七八九十\d]+[）)]\s*.+/, maxLen: 40 },
        { pattern: /^[一二三四五六七八九十]+[、．.]\s*.+/, maxLen: 35 },
        { pattern: /^\d+(\.\d+)*[\.、\s]\s*[^\d\s].+/, maxLen: 30 },
    ];

    // 以这些标点结尾 → 正文句子，不是标题
    const BODY_ENDINGS = /[\u3002\uff0c\u3001\uff1b\uff1a\u2026\uff01\uff1f,;:!?)\uff09\u300b\u300f\u201d\u2019]$/;

    // 正文特征词 → 包含则不是标题
    const BODY_INDICATORS = /应当|应该|需要|具体为|如下[\uff1a:]|以下[\uff1a:]|包括[\uff1a:]|说明[\uff1a:]|要求[\uff1a:]|其中[\uff0c,]|通过.*实现|由于|由此|因此|则需|不得|不应|不能|禁止|本[章节]介绍|本[章节]描述/;

    // 判断是否为章节标题
    function isHeading(line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 2) return false;
        if (BODY_ENDINGS.test(trimmed)) return false;
        if (BODY_INDICATORS.test(trimmed)) return false;
        for (const { pattern, maxLen } of HEADING_RULES) {
            if (trimmed.length <= maxLen && pattern.test(trimmed)) return true;
        }
        return false;
    }

    // 第一遍：找所有候选标题行位置
    const candidatePositions = [];
    for (let i = 0; i < lines.length; i++) {
        if (isHeading(lines[i])) candidatePositions.push(i);
    }

    if (candidatePositions.length === 0) {
        return [{ title: '全文', content: text, charCount: text.length, selected: true }];
    }

    // 第二遍：过滤「内容过短」的假标题（两标题间内容<30字 → 是列表项）
    const MIN_CHAPTER_CONTENT = 30;
    const headingPositions = [];

    for (let i = 0; i < candidatePositions.length; i++) {
        const curPos = candidatePositions[i];
        const nextPos = (i < candidatePositions.length - 1)
            ? candidatePositions[i + 1]
            : lines.length;
        const contentBetween = lines.slice(curPos + 1, nextPos)
            .join('').replace(/\s/g, '').length;
        if (contentBetween >= MIN_CHAPTER_CONTENT) {
            headingPositions.push(curPos);
        }
    }

    if (headingPositions.length === 0) {
        return [{ title: '全文', content: text, charCount: text.length, selected: true }];
    }

    // 章节数过多时(>20)，只保留顶层标题
    let finalPositions = headingPositions;
    if (headingPositions.length > 20) {
        const topLevel = headingPositions.filter(pos => {
            const t = lines[pos].trim();
            return /^第[一二三四五六七八九十百千\d]+[章节篇]/.test(t)
                || /^[（(][一二三四五六七八九十\d]+[）)]/.test(t)
                || /^[一二三四五六七八九十]+[、．.]/.test(t)
                || /^\d+[.、\s]\s*[^\d\s]/.test(t);
        });
        if (topLevel.length >= 2 && topLevel.length <= 20) {
            finalPositions = topLevel;
            console.log(`📑 章节过多(${headingPositions.length})，已收敛到 ${finalPositions.length} 个顶层章节`);
        }
    }

    // 文档开头到第一个标题之间的内容
    if (finalPositions[0] > 0) {
        const preContent = lines.slice(0, finalPositions[0]).join('\n').trim();
        if (preContent.length > 50) {
            chapters.push({
                title: '前言/概述',
                content: preContent,
                charCount: preContent.length,
                selected: false
            });
        }
    }

    // 按最终标题位置分章
    for (let i = 0; i < finalPositions.length; i++) {
        const startLine = finalPositions[i];
        const endLine = (i < finalPositions.length - 1) ? finalPositions[i + 1] : lines.length;
        const title = lines[startLine].trim();
        const content = lines.slice(startLine, endLine).join('\n').trim();
        chapters.push({
            title,
            content,
            charCount: content.length,
            selected: content.length > 50
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
        const { documentContent, chapterName = '', userGuidelines = '', userConfig = null, extractionMode = 'precise', moduleStructure = null, targetCount = 0 } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        const chapterInfo = chapterName ? `【${chapterName}】章节的` : '';
        const modeLabel = extractionMode === 'quantity' ? '数量优先' : '精准';
        console.log(`📋 开始提取功能过程列表${chapterName ? '（' + chapterName + '）' : ''}（${modeLabel}模式）...`);
        const modelName = getModelName(userConfig);

        // 根据extractionMode选择系统prompt
        let activePrompt = FUNCTION_EXTRACTION_PROMPT;
        if (extractionMode === 'quantity') {
            activePrompt = COSMIC_QUANTITY_PRIORITY_PROMPT;
        }

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

        // 构建模块脚手架提示（来自三级模块识别结果）
        let moduleScaffoldHint = '';
        if (moduleStructure && moduleStructure.modules && moduleStructure.modules.length > 0) {
            const scaffoldList = moduleStructure.modules.map(m => {
                const objs = (m.businessObjects || []).join('、');
                const triggers = (m.triggerTypes || []).join('、');
                return `- ${m.level1} > ${m.level2} > ${m.level3}：业务对象[${objs}]，触发类型[${triggers}]，预估 ~${m.estimatedFunctions || '?'} 个功能过程`;
            }).join('\n');
            moduleScaffoldHint = `\n\n【三级模块脚手架】以下是文档识别到的三级模块结构，请确保每个模块的功能都被提取，不要遗漏任何模块：\n${scaffoldList}`;
        }

        let userPrompt = `请从以下${chapterInfo}需求文档中提取所有功能过程列表：\n\n${documentContent}${understandingHint}${moduleScaffoldHint}`;
        if (userGuidelines) {
            userPrompt += `\n\n用户特殊要求：${userGuidelines}`;
        }
        if (extractionMode === 'quantity' && targetCount > 0) {
            userPrompt += `\n\n**目标数量：请严格输出约 ${targetCount} 个功能过程，上下浮动不超过5%。**`;
        }

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: activePrompt },
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

// ═══════════════════════ COSMIC 模块识别 ═══════════════════════

app.post('/api/cosmic/recognize-modules', async (req, res) => {
    try {
        const { documentContent, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log('📑 开始COSMIC模块层级识别...');
        const modelName = getModelName(userConfig);

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: COSMIC_MODULE_RECOGNITION_PROMPT },
                { role: 'user', content: `请分析以下需求文档的功能模块层级结构：\n\n${documentContent}` }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        let moduleData = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                moduleData = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('COSMIC模块识别JSON解析失败:', e.message);
            moduleData = { modules: [], totalEstimated: 0, summary: '解析失败' };
        }

        console.log(`✅ COSMIC模块识别完成: ${moduleData?.modules?.length || 0} 个模块节点`);
        res.json({ success: true, moduleData });
    } catch (error) {
        console.error('COSMIC模块识别失败:', error);
        res.status(500).json({ error: 'COSMIC模块识别失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 模块识别 ═══════════════════════

app.post('/api/nesma/recognize-modules', async (req, res) => {
    try {
        const { documentContent, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log('📑 开始NESMA模块层级识别...');
        const modelName = getModelName(userConfig);

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: NESMA_MODULE_RECOGNITION_PROMPT },
                { role: 'user', content: `请分析以下需求文档的功能模块层级结构：\n\n${documentContent}` }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        let moduleData = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                moduleData = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('NESMA模块识别JSON解析失败:', e.message);
            moduleData = { modules: [], totalEstimated: 0, summary: '解析失败' };
        }

        console.log(`✅ NESMA模块识别完成: ${moduleData?.modules?.length || 0} 个模块节点`);
        res.json({ success: true, moduleData });
    } catch (error) {
        console.error('NESMA模块识别失败:', error);
        res.status(500).json({ error: 'NESMA模块识别失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 功能点提取 ═══════════════════════

/**
 * 重用程度 → 调整系数映射
 * 参考："软件开发计价模型" 10/7/4/5/4
 */
const REUSE_COEFFICIENTS = {
    '低': 1.0,       // 完全新开发
    '中': 0.667,     // 部分复用
    '高': 0.333,     // 高度复用
};

/**
 * 重用程度按 低:中:高 = 1:3:6 的比例循环分配
 * 序列: 低 中 中 中 高 高 高 高 高 高 （每10个一个周期，共 1低3中6高）
 */
const REUSE_LEVEL_PATTERN = [
    '低', '中', '中', '中', '高', '高', '高', '高', '高', '高'
];
let _reuseLevelCounter = 0;
function nextReuseLevel() {
    const level = REUSE_LEVEL_PATTERN[_reuseLevelCounter % REUSE_LEVEL_PATTERN.length];
    _reuseLevelCounter++;
    return level;
}
/**
 * 每次解析新表格前重置计数器，使比例从头计算
 */
function resetReuseLevelCounter() {
    _reuseLevelCounter = 0;
}

/**
 * NESMA 功能点权重表（类别 × 复杂度 → UFP）
 */
const FP_WEIGHTS = {
    ILF: { '低': 7, '中': 10, '高': 15 },
    EIF: { '低': 5, '中': 7, '高': 10 },
    EI:  { '低': 3, '中': 4, '高': 6 },
    EO:  { '低': 4, '中': 5, '高': 7 },
    EQ:  { '低': 3, '中': 4, '高': 6 },
};

/**
 * 解析NESMA功能点Markdown表格
 * 支持三种格式：
 *   - v3格式（7列）：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 功能需求描述 | 外部接口需求描述
 *   - v2格式（4列）：功能模块 | 子功能 | 功能点计数项名称 | 类别
 *   - v1格式（12列）：编号|一级模块|二级模块|三级模块|四级模块|功能点计数项名称|类别|...
 */
function parseNesmaTable(markdown) {
    if (!markdown) return [];
    resetReuseLevelCounter(); // 每次解析新表格时，重置比例计数器
    const tableData = [];
    const lines = markdown.split('\n');
    let headerFound = false;
    let formatVersion = 0; // 0=未确定, 1=v1旧格式, 2=v2四列, 3=v3七列
    let hasReuseColumn = false;
    let currentLevel1 = '';   // 一级模块
    let currentLevel2 = '';   // 二级模块
    let currentLevel3 = '';   // 三级模块

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;

        // 检查表头 — 判断格式版本
        if (!headerFound && (trimmed.includes('业务功能') || trimmed.includes('功能点类型') || trimmed.includes('功能需求描述') ||
            trimmed.includes('功能点计数项名称') || trimmed.includes('功能模块') || trimmed.includes('子功能') ||
            trimmed.includes('编号') || trimmed.includes('一级模块') || trimmed.includes('类别'))) {
            headerFound = true;
            hasReuseColumn = trimmed.includes('重用程度');

            // v3格式（含"业务功能"或"功能需求描述"或"外部接口需求描述"，含/不含"迁移维度"）
            if (trimmed.includes('业务功能') || trimmed.includes('功能需求描述') || trimmed.includes('外部接口需求描述') || trimmed.includes('迁移维度')) {
                formatVersion = 3;
            }
            // v2格式：包含"功能模块"或"子功能"，不包含"编号"/"一级模块"
            else if ((trimmed.includes('功能模块') || trimmed.includes('子功能')) && !trimmed.includes('编号') && !trimmed.includes('一级模块')) {
                formatVersion = 2;
            }
            // v1格式
            else {
                formatVersion = 1;
            }
            continue;
        }

        // 跳过分隔行 — 整行去掉 |, -, :, 空格后应为空
        if (trimmed.replace(/[\s|:\-]/g, '').length === 0) continue;
        if (!headerFound) continue;

        // 解析数据行
        const cells = trimmed.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(c => c.trim());

        if (formatVersion === 3) {
            // ═══ v3格式（7列）：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 功能需求描述 | 外部接口需求描述 ═══
            // ═══ v3+格式（8列）：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 迁移维度 | 功能需求描述 | 外部接口需求描述 ═══
            if (cells.length < 5) continue;

            let l1 = cells[0] || '';
            let l2 = cells[1] || '';
            let l3 = cells[2] || '';
            let funcName = cells[3] || '';
            let category = (cells[4] || '').toUpperCase().trim();
            let migrationDimension = '';
            let funcDescription = '';
            let interfaceDescription = '';

            // 根据列数判断是否包含「迁移维度」列
            if (cells.length >= 8) {
                // 8列格式（国产化迁移模式）
                migrationDimension = cells[5] || '';
                funcDescription = cells[6] || '';
                interfaceDescription = cells[7] || '';
            } else {
                // 标准7列格式
                funcDescription = cells[5] || '';
                interfaceDescription = cells[6] || '';
            }

            // 验证类别
            const validCategories = ['ILF', 'EIF', 'EI', 'EO', 'EQ'];
            if (!validCategories.includes(category)) continue;

            // 模块名称继承（同一模块下后续行留空）
            if (l1) currentLevel1 = l1;
            if (l2) currentLevel2 = l2;
            if (l3) currentLevel3 = l3;

            // 默认复杂度为 低
            const complexity = '低';
            const fpCount = (FP_WEIGHTS[category] && FP_WEIGHTS[category][complexity]) || 0;
            const reuseLevel = nextReuseLevel(); // 按 低:中:高=1:3:6 比例分配
            const reuseCoeff = REUSE_COEFFICIENTS[reuseLevel] || 1.0;
            const afp = Math.round(fpCount * reuseCoeff * 1000) / 1000;

            tableData.push({
                id: String(tableData.length + 1),
                level1: sanitizeText(currentLevel1) || '无',
                level2: sanitizeText(currentLevel2) || '无',
                level3: sanitizeText(currentLevel3) || '无',
                funcModule: sanitizeText(currentLevel1) || '',
                subFunction: sanitizeText(currentLevel2) || '',
                level4: sanitizeText(currentLevel3) || '无',
                funcName: sanitizeText(funcName) || '',
                category: category,
                complexity: complexity,
                fpCount: fpCount,
                det: 0,
                retFtr: 0,
                reuseLevel: reuseLevel,
                afp: afp,
                modType: '新增',
                migrationDimension: sanitizeText(migrationDimension) || '',
                funcDescription: sanitizeText(funcDescription) || '',
                interfaceDescription: sanitizeText(interfaceDescription) || ''
            });
        } else if (formatVersion === 2) {
            // ═══ v2格式：功能模块 | 子功能 | 功能点计数项名称 | 类别 ═══
            let funcModule, subFunc, funcName, category;
            if (cells.length >= 4) {
                funcModule = cells[0] || '';
                subFunc = cells[1] || '';
                funcName = cells[2] || '';
                category = (cells[3] || '').toUpperCase().trim();
            } else if (cells.length === 3) {
                funcModule = '';
                subFunc = cells[0] || '';
                funcName = cells[1] || '';
                category = (cells[2] || '').toUpperCase().trim();
            } else {
                continue;
            }

            const validCategories = ['ILF', 'EIF', 'EI', 'EO', 'EQ'];
            if (!validCategories.includes(category)) continue;

            if (funcModule) currentLevel1 = funcModule;
            if (subFunc) currentLevel2 = subFunc;

            const complexity = '低';
            const fpCount = (FP_WEIGHTS[category] && FP_WEIGHTS[category][complexity]) || 0;
            const reuseLevel = nextReuseLevel(); // 按 低:中:高=1:3:6 比例分配
            const reuseCoeff = REUSE_COEFFICIENTS[reuseLevel] || 1.0;
            const afp = Math.round(fpCount * reuseCoeff * 1000) / 1000;

            tableData.push({
                id: String(tableData.length + 1),
                funcModule: sanitizeText(currentLevel1) || '',
                subFunction: sanitizeText(currentLevel2) || '',
                level1: sanitizeText(currentLevel1) || '无',
                level2: sanitizeText(currentLevel2) || '无',
                level3: '无',
                level4: '无',
                funcName: sanitizeText(funcName) || '',
                category: category,
                complexity: complexity,
                fpCount: fpCount,
                det: 0,
                retFtr: 0,
                reuseLevel: reuseLevel,
                afp: afp,
                modType: '新增',
                funcDescription: '',
                interfaceDescription: ''
            });
        } else {
            // ═══ v1格式：编号|一级模块|二级模块|三级模块|四级模块|功能点计数项名称|类别|... ═══
            if (cells.length < 8) continue;

            const [id, level1, level2, level3, level4, funcName, category, ...rest] = cells;

            const validCategories = ['ILF', 'EIF', 'EI', 'EO', 'EQ'];
            const cleanCategory = (category || '').toUpperCase().trim();
            if (!validCategories.includes(cleanCategory)) continue;

            const complexity = rest[0]?.trim() || '中';
            const fpCount = parseInt(rest[1]?.trim()) || 0;
            const det = parseInt(rest[2]?.trim()) || 0;
            const retFtr = parseInt(rest[3]?.trim()) || 0;

            let reuseLevel, modType;
            if (hasReuseColumn) {
                reuseLevel = rest[4]?.trim() || '低';
                modType = rest[5]?.trim() || '新增';
            } else {
                reuseLevel = '低';
                modType = rest[4]?.trim() || '新增';
            }

            const validReuse = ['低', '中', '高'];
            if (!validReuse.includes(reuseLevel)) reuseLevel = '低';

            const reuseCoeff = REUSE_COEFFICIENTS[reuseLevel] || 1.0;
            const afp = Math.round(fpCount * reuseCoeff * 1000) / 1000;

            tableData.push({
                id: sanitizeText(id) || String(tableData.length + 1),
                subFunction: '',
                level1: sanitizeText(level1) || '无',
                level2: sanitizeText(level2) || '无',
                level3: sanitizeText(level3) || '无',
                level4: sanitizeText(level4) || '无',
                funcName: sanitizeText(funcName) || '',
                category: cleanCategory,
                complexity: complexity,
                fpCount: fpCount,
                det: det,
                retFtr: retFtr,
                reuseLevel: reuseLevel,
                afp: afp,
                modType: sanitizeText(modType) || '新增',
                funcDescription: '',
                interfaceDescription: ''
            });
        }
    }
    return tableData;
}

app.post('/api/nesma/extract-functions', async (req, res) => {
    try {
        const {
            documentContent, chapterContent = '', chapterName = '', userGuidelines = '',
            previousResults = [], moduleStructure = null,
            extractionMode = 'precise',
            targetFpCount = null,   // 数量优先：总目标功能点数
            quantityPlan = null,    // 数量优先：每个三级模块的目标数量 [{level1,level2,level3,target}]
            userConfig = null
        } = req.body;
        const content = chapterContent || documentContent;
        if (!content) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        const chapterInfo = chapterName ? `（${chapterName}）` : '';
        const modeLabel = extractionMode === 'quantity' ? '「数量优先」' : extractionMode === 'guochanhua' ? '「国产化迁移」' : '「精准」';
        console.log(`📋 开始NESMA功能点提取${chapterInfo}（${modeLabel}模式）...`);
        const modelName = getModelName(userConfig);

        // 根据模式选择提示词
        let activePrompt;
        if (extractionMode === 'quantity') {
            activePrompt = NESMA_QUANTITY_PRIORITY_PROMPT;
        } else if (extractionMode === 'guochanhua') {
            activePrompt = NESMA_GUOCHANHUA_MIGRATION_PROMPT;
        } else {
            activePrompt = NESMA_FUNCTION_EXTRACTION_PROMPT;
        }

        // ── 自动分批阈值：数量优先/国产化每批2个模块，精准模式≤10个模块 ──
        const BATCH_SIZE = (extractionMode === 'quantity' || extractionMode === 'guochanhua') ? 2 : 10;

        // ── 确定活跃模块列表 ──
        let activeMods = [];
        if (moduleStructure && moduleStructure.modules && moduleStructure.modules.length > 0) {
            // 筛选出与当前章节相关的模块（如果有章节名则过滤，否则全部输出）
            const relevantModules = chapterName
                ? moduleStructure.modules.filter(m =>
                    m.level1?.includes(chapterName) ||
                    m.level2?.includes(chapterName) ||
                    m.level3?.includes(chapterName) ||
                    chapterName.includes(m.level1?.split(' ').pop() || '') ||
                    chapterName.includes(m.level2?.split(' ').pop() || '')
                  )
                : moduleStructure.modules;

            activeMods = relevantModules.length > 0 ? relevantModules : moduleStructure.modules;
        }

        // ── 建立 quantityPlan 映射（level3 → target）──
        const planMap = {};
        if (quantityPlan && quantityPlan.length > 0) {
            quantityPlan.forEach(p => {
                const key = (p.level3 || '').trim();
                if (key) planMap[key] = p.target;
            });
        }

        // ────────────────────────────────────────────────────────────────
        // 辅助函数：为一批模块（batchMods）构造 prompt 并调用一次 AI
        // ────────────────────────────────────────────────────────────────
        const extractOneBatch = async (batchMods, batchIndex, totalBatches, accumulated) => {
            let prompt = `请从以下需求文档中提取NESMA功能点：\n\n${content}`;

            if (batchMods.length > 0) {
                if (extractionMode === 'quantity' && quantityPlan && quantityPlan.length > 0) {
                    // 数量优先 + 规划：按精确目标数量拆，不超出不少于
                    const modListWithTarget = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        const l3key = (m.level3 || '').trim();
                        let target = planMap[l3key];
                        if (!target) {
                            for (const [key, val] of Object.entries(planMap)) {
                                if (l3key.includes(key) || key.includes(l3key)) { target = val; break; }
                            }
                        }
                        const targetStr = target ? `【🎯 精确目标：${target} 个功能点，请严格控制，不多不少】` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs} ${targetStr}`;
                    }).join('\n');
                    const batchTotal = batchMods.reduce((s, m) => {
                        const l3key = (m.level3 || '').trim();
                        let t = planMap[l3key];
                        if (!t) { for (const [k, v] of Object.entries(planMap)) { if (l3key.includes(k) || k.includes(l3key)) { t = v; break; } } }
                        return s + (t || 10);
                    }, 0);
                    prompt += `\n\n## 📊 按计划数量拆分·本批次模块（批次${batchIndex + 1}/${totalBatches}，本批合计目标 ${batchTotal} 个功能点）\n\n仅需提取以下${batchMods.length}个三级模块的功能点：\n\n${modListWithTarget}\n\n📋 执行要求（必须严格遵守）：\n1. **每个三级模块的功能点数量必须精确等于目标数，上下浮动不超过2个**\n2. 先规划该模块下有哪些业务实体，再按 ILF + EI(CRUD) + EQ(查询/筛选) + EO(统计) 四类展开\n3. 筛选维度（时间/状态/类型/区域）按需拆分，不要无限展开\n4. **禁止为了凑数量而重复或拆出明显无意义的功能点**\n5. 若目标数较小（< 10），优先保证ILF + 基础CRUD + 一个查询即可`;
                } else if (extractionMode === 'quantity' && targetFpCount) {
                    const modList = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs}`;
                    }).join('\n');
                    const perModTarget = Math.round(targetFpCount / (activeMods.length || 1));
                    prompt += `\n\n## 📊 按计划数量拆分·本批次模块（批次${batchIndex + 1}/${totalBatches}，每模块目标约 ${perModTarget} 个）\n${modList}\n\n以上每个三级模块请按约 ${perModTarget} 个功能点展开，不要过多也不要过少。`;
                } else if (extractionMode === 'guochanhua') {
                    // 国产化迁移模式：为每个模块注入7大迁移维度要求
                    const modList = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs}`;
                    }).join('\n');
                    prompt += `\n\n## 🏗️ 国产化迁移功能点提取·本批次模块（批次${batchIndex + 1}/${totalBatches}，仅处理以下${batchMods.length}个模块）\n\n${modList}\n\n## ⚡ 执行要求（必须严格遵守）：\n1. 先提取每个三级模块的**标准业务功能点**（ILF/EIF + CRUD(EI) + 查询(EQ) + 统计(EO)），「迁移维度」列填「原有业务」\n2. 然后为每个三级模块按以下7大维度**逐一判断并展开迁移功能点**（与模块业务对象相关的维度必须包含，每个适用维度至少3~6个功能点）：\n   - **维度1：采集数据迁移** — 该模块有数据采集/传感器/监控数据时必须展开\n   - **维度2：ETL迁移配置** — 该模块有数据清洗/转换/数据管道时必须展开\n   - **维度3：数据汇总迁移** — 该模块有统计汇总/聚合计算时必须展开\n   - **维度4：外部接口迁移** — 该模块有第三方接口/数据交换时必须展开\n   - **维度5：流程引擎迁移** — 该模块有审批流程/工单流转/BPM时必须展开\n   - **维度6：前端应用迁移** — 所有含前端页面的模块必须展开（国产化浏览器/OS适配）\n   - **维度7：报表引擎迁移** — 该模块有数据可视化/图表/报表输出时必须展开\n3. 迁移功能点名称必须结合文档中具体业务名称，禁止使用泛化名称（如"数据迁移"）\n4. 输出8列表格：一级模块 | 二级模块 | 三级模块 | 业务功能 | 功能点类型 | 迁移维度 | 功能需求描述 | 外部接口需求描述`;
                } else {
                    const modList = batchMods.map(m => {
                        const objs = m.businessObjects?.length > 0 ? `（业务对象：${m.businessObjects.join('、')}）` : '';
                        const est = m.estimatedFunctionPoints ? `，预估约${m.estimatedFunctionPoints}个功能点` : '';
                        return `  - [${m.level1}] > [${m.level2}] > [${m.level3}]${objs}${est}`;
                    }).join('\n');
                    prompt += `\n\n## ⚠️ 模块覆盖脚手架（批次${batchIndex + 1}/${totalBatches}，仅处理以下${batchMods.length}个模块）\n${modList}\n\n每个三级模块须有 ILF/EIF + CRUD(EI) + 查询(EQ) + 统计(EO)。`;
                }
            }

            // ⚠️ 多批次模式下不向 AI 注入已累积列表！
            // 每批已按模块限定范围，AI 不会越界重复；大量"已提取"列表会挤占 token 导致产出减少。
            // 批次间去重由代码层的 existingNames Set 完成。
            // 仅首批注入 previousResults（跨轮补充场景），且最多传 50 条防止撑爆。
            if (batchIndex === 0 && previousResults.length > 0) {
                const prevNames = previousResults.map(r => r.funcName).filter(Boolean);
                const sample = prevNames.slice(0, 50);
                prompt += `\n\n## 上一轮已有记录（请勿重复，共${prevNames.length}条）：\n${sample.map((n, i) => `${i + 1}. ${n}`).join('\n')}${prevNames.length > 50 ? `\n...（剩余${prevNames.length - 50}条略）` : ''}`;
            }

            if (userGuidelines) {
                prompt += `\n\n用户特殊要求：${userGuidelines}`;
            }

            const completion = await callAIWithRetry({
                messages: [
                    { role: 'system', content: activePrompt },
                    { role: 'user', content: prompt }
                ],
                model: modelName,
                temperature: 0.5,
                max_tokens: (extractionMode === 'quantity' || extractionMode === 'guochanhua') ? 32000 : 16000
            });

            if (!completion?.choices?.[0]?.message?.content) {
                throw new Error(`批次 ${batchIndex + 1} AI返回了空响应`);
            }
            return completion.choices[0].message.content;
        };

        // ────────────────────────────────────────────────────────────────
        // 主提取逻辑：模块数 ≤ BATCH_SIZE → 单次；否则自动分批
        // ────────────────────────────────────────────────────────────────
        let allTableData = [];
        let allReplies = [];

        if (activeMods.length === 0 || activeMods.length <= BATCH_SIZE) {
            // 单批次
            console.log(`📌 单批次提取: ${activeMods.length} 个模块`);
            const reply = await extractOneBatch(activeMods, 0, 1, []);
            allTableData = parseNesmaTable(reply);
            allReplies.push(reply);
        } else {
            // 多批次自动分批
            const totalBatches = Math.ceil(activeMods.length / BATCH_SIZE);
            console.log(`🔀 模块数(${activeMods.length}) > 阈值(${BATCH_SIZE})，自动分为 ${totalBatches} 批...`);

            for (let bi = 0; bi < totalBatches; bi++) {
                const batchMods = activeMods.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE);
                console.log(`  📦 批次 ${bi + 1}/${totalBatches}: [${batchMods.map(m => m.level3 || m.level2).join('] [')}]`);
                try {
                    const reply = await extractOneBatch(batchMods, bi, totalBatches, allTableData);
                    const batchData = parseNesmaTable(reply);
                    // 数量优先模式：用 "三级模块|功能名" 联合去重，避免跨模块同名功能点被误删
                    // 精准模式：仅用功能名去重（兼容原逻辑）
                    const buildDedupeKey = (r) => {
                        const l3 = (r.level3 || r.level4 || '').trim();
                        const name = (r.funcName || '').toLowerCase().trim();
                        return extractionMode === 'quantity' ? `${l3}||${name}` : name;
                    };
                    const existingKeys = new Set(allTableData.map(buildDedupeKey));
                    const newRows = batchData.filter(r => !existingKeys.has(buildDedupeKey(r)));
                    allTableData = [...allTableData, ...newRows];
                    allReplies.push(reply);
                    console.log(`  ✅ 批次 ${bi + 1} 完成: +${newRows.length} 个（累计 ${allTableData.length} 个）`);
                } catch (batchErr) {
                    console.error(`  ❌ 批次 ${bi + 1} 失败: ${batchErr.message}，跳过继续...`);
                }
                // 批次间间隔 1.5 秒，避免限流
                if (bi < totalBatches - 1) await new Promise(r => setTimeout(r, 1500));
            }
            // 重新编号
            allTableData.forEach((r, i) => { r.id = String(i + 1); });
        }

        console.log(`✅ NESMA功能点提取完成，共解析到 ${allTableData.length} 个功能点（共 ${allReplies.length} 批次）`);
        res.json({
            success: true,
            reply: allReplies.join('\n\n---批次分隔---\n\n'),
            tableData: allTableData,
            count: allTableData.length,
            batches: allReplies.length
        });
    } catch (error) {
        console.error('NESMA功能点提取失败:', error);
        res.status(500).json({ error: 'NESMA功能点提取失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 表格解析 ═══════════════════════

app.post('/api/nesma/parse-table', (req, res) => {
    try {
        const { markdown } = req.body;
        const tableData = parseNesmaTable(markdown);
        res.json({ success: true, tableData, count: tableData.length });
    } catch (error) {
        res.status(500).json({ error: 'NESMA表格解析失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 覆盖度验证 ═══════════════════════

app.post('/api/nesma/verify-coverage', async (req, res) => {
    try {
        const { documentContent, extractedFunctions = [], userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log(`🔍 开始NESMA覆盖度验证，已提取 ${extractedFunctions.length} 个功能点...`);
        const modelName = getModelName(userConfig);

        const funcListText = extractedFunctions.map((f, i) => {
            const path = [f.level1 || f.funcModule, f.level2 || f.subFunction, f.level3].filter(Boolean).join(' > ');
            const desc = f.funcDescription ? ` | 说明：${f.funcDescription.substring(0, 50)}` : '';
            return `${i + 1}. [${f.category}] ${f.funcName}（模块：${path}${desc}）`;
        }).join('\n');

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: NESMA_COVERAGE_VERIFICATION_PROMPT },
                { role: 'user', content: `## 原始需求文档：\n${documentContent}\n\n## 已提取的NESMA功能点（共${extractedFunctions.length}个，含三级模块路径和描述）：\n${funcListText}\n\n请严格审查功能点覆盖度，重点检查：1.每个ILF是否有配套EI和EO/EQ；2.是否有未覆盖的三级模块；3.文档中未体现的EQ子类（导出、推送、筛选）。` }
            ],
            model: modelName,
            temperature: 0.3,
            max_tokens: 8000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应，请重试' });
        }
        const reply = completion.choices[0].message.content;

        let verification = null;
        try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) verification = JSON.parse(jsonMatch[0]);
        } catch (e) {
            verification = { coverageScore: 0, missedFunctions: [], suggestions: ['JSON解析失败，请重试'] };
        }

        console.log(`✅ NESMA覆盖度验证完成: ${verification?.coverageScore || 0}分, 遗漏${verification?.missedFunctions?.length || 0}个`);
        res.json({ success: true, verification });
    } catch (error) {
        console.error('NESMA覆盖度验证失败:', error);
        res.status(500).json({ error: 'NESMA覆盖度验证失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 补充提取 ═══════════════════════

app.post('/api/nesma/extract-supplementary', async (req, res) => {
    try {
        const { documentContent, existingFunctions = [], missedFunctions = [], moduleStructure = null, userConfig = null } = req.body;
        if (!documentContent) {
            return res.status(400).json({ error: '缺少文档内容' });
        }

        console.log(`🔄 开始NESMA补充提取，遗漏 ${missedFunctions.length} 个...`);
        const modelName = getModelName(userConfig);

        const existingNames = existingFunctions.map((f, i) => `${i + 1}. [${f.category}] ${f.funcName}`).join('\n');
        const missedNames = missedFunctions.map((f, i) => {
            if (typeof f === 'object') return `${i + 1}. [${f.category || '?'}] ${f.functionName}（${f.reason || ''}）所属模块：${f.parentModule || '未知'}`;
            return `${i + 1}. ${f}`;
        }).join('\n');

        let userPrompt = `## 原始需求文档：\n${documentContent}\n\n## 已提取的功能点（不要重复）：\n${existingNames}\n\n## 遗漏的功能点（请补充提取）：\n${missedNames}\n\n请补充提取上述遗漏的NESMA功能点。`;

        // 注入模块脚手架，帮助AI定位遗漏功能点所在的模块
        if (moduleStructure && moduleStructure.modules?.length > 0) {
            const modList = moduleStructure.modules.map(m =>
                `  - [${m.level1}] > [${m.level2}] > [${m.level3}]`
            ).join('\n');
            userPrompt += `\n\n## 模块覆盖脚手架（遗漏功能点可能属于以下模块）：\n${modList}`;
        }

        const completion = await callAIWithRetry({
            messages: [
                { role: 'system', content: NESMA_FUNCTION_EXTRACTION_PROMPT },
                { role: 'user', content: userPrompt }
            ],
            model: modelName,
            temperature: 0.5,
            max_tokens: 16000
        });

        if (!completion?.choices?.[0]?.message?.content) {
            return res.status(500).json({ error: 'AI返回了空响应' });
        }
        const reply = completion.choices[0].message.content;
        const tableData = parseNesmaTable(reply);

        console.log(`✅ NESMA补充提取到 ${tableData.length} 个功能点`);
        res.json({ success: true, tableData, count: tableData.length });
    } catch (error) {
        console.error('NESMA补充提取失败:', error);
        res.status(500).json({ error: 'NESMA补充提取失败: ' + error.message });
    }
});

// ═══════════════════════ NESMA 导出Excel ═══════════════════════

app.post('/api/nesma/export-excel', async (req, res) => {
    try {
        const { tableData, filename = 'NESMA功能点拆分结果', adjustmentFactors = {} } = req.body;
        if (!tableData || tableData.length === 0) {
            return res.status(400).json({ error: '没有可导出的数据' });
        }

        const workbook = new ExcelJS.Workbook();
        const reuseCoeff = { '低': 1.0, '中': 0.667, '高': 0.333 };
        const categoryColors = {
            'ILF': 'FF1E88E5', 'EIF': 'FF43A047', 'EI': 'FFFB8C00', 'EO': 'FF8E24AA', 'EQ': 'FF00ACC1'
        };

        // ═══════════ Sheet 1: 规模估算（参考Excel标准工作量模型格式） ═══════════
        const worksheet = workbook.addWorksheet('规模估算');

        const totalUFP = tableData.reduce((sum, r) => sum + (r.fpCount || 0), 0);
        const totalAFP = tableData.reduce((sum, r) => {
            const coeff = reuseCoeff[r.reuseLevel || '低'] || 1.0;
            return sum + (r.fpCount || 0) * coeff;
        }, 0);
        const roundedAFP = Math.round(totalAFP * 100) / 100;

        // 汇总信息行
        const sr0 = worksheet.addRow(['', '软件开发计价模型', '', '"软件开发计价模型"：10/7/4/5/4']);
        sr0.getCell(2).font = { bold: true, size: 11 };
        sr0.getCell(4).font = { size: 10, color: { argb: 'FF666666' } };
        const sr1 = worksheet.addRow(['', totalUFP, '', 'UFP,单位：FP']);
        sr1.getCell(2).font = { bold: true, size: 14, color: { argb: 'FF008000' } };
        sr1.getCell(2).numFmt = '#,##0.00';
        sr1.getCell(4).font = { bold: true, color: { argb: 'FFFF0000' } };
        const sr2 = worksheet.addRow(['', roundedAFP, '', 'AFP,单位：FP']);
        sr2.getCell(2).font = { bold: true, size: 14, color: { argb: 'FFFF0000' } };
        sr2.getCell(2).numFmt = '#,##0.00';
        sr2.getCell(4).font = { bold: true, color: { argb: 'FFFF0000' } };
        // 背景色
        sr1.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        sr2.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
        sr2.getCell(2).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };

        // 表头行 — 检测是否有国产化迁移数据，动态调整列数
        const hasMigrationData = tableData.some(r => r.migrationDimension && r.migrationDimension !== '' && r.migrationDimension !== '原有业务');
        const headers = hasMigrationData
            ? ['一级模块', '二级模块', '三级模块', '业务功能', '功能点类型', '迁移维度', '功能需求描述', '外部接口需求描述', 'UFP', '重用程度', '修改类型', 'AFP']
            : ['一级模块', '二级模块', '三级模块', '业务功能', '功能点类型', '功能需求描述', '外部接口需求描述', 'UFP', '重用程度', '修改类型', 'AFP'];
        const headerRow = worksheet.addRow(headers);
        const headerRowNum = worksheet.lastRow.number;

        headerRow.eachCell((cell, colNumber) => {
            // 迁移维度列用绿色表头
            const isMigCol = hasMigrationData && colNumber === 6;
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isMigCol ? 'FF10B981' : 'FF0D4F8B' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        });

        if (hasMigrationData) {
            worksheet.columns = [
                { width: 18 }, // 一级模块
                { width: 20 }, // 二级模块
                { width: 20 }, // 三级模块
                { width: 30 }, // 业务功能
                { width: 10 }, // 功能点类型
                { width: 14 }, // 迁移维度
                { width: 38 }, // 功能需求描述
                { width: 32 }, // 外部接口需求描述
                { width: 8 },  // UFP
                { width: 10 }, // 重用程度
                { width: 10 }, // 修改类型
                { width: 10 }, // AFP
            ];
        } else {
            worksheet.columns = [
                { width: 20 }, // 一级模块
                { width: 22 }, // 二级模块
                { width: 22 }, // 三级模块
                { width: 32 }, // 业务功能
                { width: 10 }, // 功能点类型
                { width: 40 }, // 功能需求描述
                { width: 36 }, // 外部接口需求描述
                { width: 8 },  // UFP
                { width: 10 }, // 重用程度
                { width: 10 }, // 修改类型
                { width: 10 }, // AFP
            ];
        }

        // 迁移维度颜色（Excel背景色）
        const migDimBgColors = {
            '采集数据迁移': 'FFE0F2FE',
            'ETL迁移配置': 'FFF3E8FF',
            '数据汇总迁移': 'FFFFF7E0',
            '外部接口迁移': 'FFFEE2E2',
            '流程引擎迁移': 'FFFCE7F3',
            '前端应用迁移': 'FFE6FFFA',
            '报表引擎迁移': 'FFFFF3E0',
        };

        // 填充数据 — 各级模块只在每组第一行显示，后续行留空

        let prevL1 = '';
        let prevL2 = '';
        let prevL3 = '';
        tableData.forEach((row) => {
            const l1 = row.level1 || row.funcModule || '';
            const showL1 = (l1 && l1 !== '无' && l1 !== prevL1) ? l1 : '';
            if (l1 && l1 !== '无') prevL1 = l1;

            const l2 = row.level2 || row.subFunction || '';
            const showL2 = (l2 && l2 !== '无' && l2 !== prevL2) ? l2 : '';
            if (l2 && l2 !== '无') prevL2 = l2;

            const l3 = row.level3 || row.level4 || '';
            const showL3 = (l3 && l3 !== '无' && l3 !== prevL3) ? l3 : '';
            if (l3 && l3 !== '无') prevL3 = l3;

            const rl = row.reuseLevel || '低';
            const coeff = reuseCoeff[rl] || 1.0;
            const afpVal = Math.round((row.fpCount || 0) * coeff * 1000) / 1000;

            const migDim = row.migrationDimension || '';
            const isMigRow = hasMigrationData && migDim && migDim !== '原有业务' && migDim !== '';
            const dataRow = hasMigrationData
                ? worksheet.addRow([showL1, showL2, showL3, row.funcName, row.category, migDim || '原有业务', row.funcDescription || '', row.interfaceDescription || '', row.fpCount || 0, rl, row.modType || '新增', afpVal])
                : worksheet.addRow([showL1, showL2, showL3, row.funcName, row.category, row.funcDescription || '', row.interfaceDescription || '', row.fpCount || 0, rl, row.modType || '新增', afpVal]);

            dataRow.eachCell((cell, colNumber) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };
                // 类别列颜色（国产化模式下类别在第5列）
                const catCol = 5;
                if (colNumber === catCol) {
                    cell.font = { bold: true, color: { argb: categoryColors[row.category] || 'FF000000' } };
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
                // 迁移维度列背景色
                if (hasMigrationData && colNumber === 6) {
                    const bgColor = migDimBgColors[migDim] || 'FFF0FFF4';
                    if (isMigRow) {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
                        cell.font = { bold: true, color: { argb: 'FF10B981' }, size: 10 };
                        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
                    }
                }
                // 居中列（随有无迁移列调整）
                const centerCols = hasMigrationData ? [5, 6, 9, 10, 11, 12] : [5, 8, 9, 10, 11];
                if (centerCols.includes(colNumber)) {
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
                const afpColNum = hasMigrationData ? 12 : 11;
                if (colNumber === afpColNum) cell.numFmt = '#,##0.000';
            });
        });

        // 汇总尾行
        worksheet.addRow([]);
        const catCounts = {};
        tableData.forEach(r => { catCounts[r.category] = (catCounts[r.category] || 0) + 1; });
        const catSummary = `ILF:${catCounts['ILF'] || 0} EIF:${catCounts['EIF'] || 0} EI:${catCounts['EI'] || 0} EO:${catCounts['EO'] || 0} EQ:${catCounts['EQ'] || 0}`;
        // 根据有无迁移列调整占位
        const footerRow = hasMigrationData
            ? worksheet.addRow(['', '', '', `总计: ${tableData.length}个功能点 | ${catSummary}`, '', '', '', '', totalUFP, '', '', roundedAFP])
            : worksheet.addRow(['', '', '', `总计: ${tableData.length}个功能点 | ${catSummary}`, '', '', '', totalUFP, '', '', roundedAFP]);
        footerRow.getCell(4).font = { bold: true, size: 11 };
        const ufpCol = hasMigrationData ? 9 : 8;
        const afpFooterCol = hasMigrationData ? 12 : 11;
        footerRow.getCell(ufpCol).font = { bold: true, size: 12, color: { argb: 'FF0D4F8B' } };
        footerRow.getCell(ufpCol).numFmt = '#,##0';
        footerRow.getCell(afpFooterCol).font = { bold: true, size: 12, color: { argb: 'FF1E88E5' } };
        footerRow.getCell(afpFooterCol).numFmt = '#,##0.00';
        worksheet.views = [{ state: 'frozen', ySplit: headerRowNum }];



        // ═══════════ Sheet 2: 调整因子 ═══════════
        const ws2 = workbook.addWorksheet('调整因子');
        ws2.addRow(['调整因子列表']).getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0D4F8B' } };
        ws2.addRow([]);
        const afHeaders = ['调整因子', '选项', '描述', '系数值'];
        const afHeaderRow = ws2.addRow(afHeaders);
        afHeaderRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D4F8B' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        });
        const af = adjustmentFactors;
        const factors = [
            ['规模计数时机', af.countingTiming || '项目早期', '项目处于需求规划、需求调研阶段', af.countingTimingValue || 1.39],
            ['应用类型', af.appType || '业务处理', '办公自动化系统、日常管理及业务处理用软件等', af.appTypeValue || 1.0],
            ['开发语言', af.devLanguage || 'JAVA/C++/C#', '', af.devLanguageValue || 1.0],
            ['开发团队背景', af.teamBackground || '有相关行业经验', '', af.teamBackgroundValue || 0.8],
            ['分布式处理', af.distributedProcessing || '客户端/服务器分布式处理', '', af.distributedProcessingValue || 0],
            ['性能', af.performance || '应答时间/处理率很重要', '', af.performanceValue || 0],
            ['可靠性', af.reliability || '故障带来较多不便', '', af.reliabilityValue || 0],
            ['多重站点', af.multiSite || '需考虑不同站点运行', '', af.multiSiteValue || 0],
        ];
        factors.forEach(f => {
            const row = ws2.addRow(f);
            row.eachCell((cell) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };
            });
        });
        ws2.columns = [{ width: 18 }, { width: 36 }, { width: 50 }, { width: 12 }];

        // ═══════════ Sheet 3: 详细清单（完整7列+UFP/AFP） ═══════════
        const ws3 = workbook.addWorksheet('详细清单');
        const detailHeaders = ['编号', '一级模块', '二级模块', '三级模块', '业务功能', '功能点类型', '功能需求描述', '外部接口需求描述', 'UFP', '重用程度', '修改类型', 'AFP'];
        const dHeaderRow = ws3.addRow(detailHeaders);
        dHeaderRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D4F8B' } };
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
            cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
        });
        ws3.columns = [
            { width: 6 },  // 编号
            { width: 20 }, // 一级模块
            { width: 22 }, // 二级模块
            { width: 22 }, // 三级模块
            { width: 32 }, // 业务功能
            { width: 10 }, // 功能点类型
            { width: 40 }, // 功能需求描述
            { width: 36 }, // 外部接口需求描述
            { width: 8 },  // UFP
            { width: 10 }, // 重用程度
            { width: 10 }, // 修改类型
            { width: 10 }, // AFP
        ];
        let prevDL1 = '';
        let prevDL2 = '';
        let prevDL3 = '';
        tableData.forEach((row) => {
            const rl = row.reuseLevel || '低';
            const coeff = reuseCoeff[rl] || 1.0;
            const afpVal = Math.round((row.fpCount || 0) * coeff * 1000) / 1000;

            const l1 = row.level1 || row.funcModule || '';
            const showL1 = (l1 && l1 !== '无' && l1 !== prevDL1) ? l1 : '';
            if (l1 && l1 !== '无') prevDL1 = l1;

            const l2 = row.level2 || row.subFunction || '';
            const showL2 = (l2 && l2 !== '无' && l2 !== prevDL2) ? l2 : '';
            if (l2 && l2 !== '无') prevDL2 = l2;

            const l3 = row.level3 || row.level4 || '';
            const showL3 = (l3 && l3 !== '无' && l3 !== prevDL3) ? l3 : '';
            if (l3 && l3 !== '无') prevDL3 = l3;

            const dRow = ws3.addRow([
                row.id, showL1, showL2, showL3, row.funcName, row.category,
                row.funcDescription || '', row.interfaceDescription || '',
                row.fpCount, rl, row.modType, afpVal
            ]);
            dRow.eachCell((cell, colNumber) => {
                cell.alignment = { vertical: 'middle', wrapText: true };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
                    right: { style: 'thin', color: { argb: 'FFE0E0E0' } }
                };
                if ([1, 6, 9, 10, 11, 12].includes(colNumber)) {
                    cell.alignment = { horizontal: 'center', vertical: 'middle' };
                }
                if (colNumber === 6) {
                    cell.font = { bold: true, color: { argb: categoryColors[row.category] || 'FF000000' } };
                }
                if (colNumber === 12) cell.numFmt = '#,##0.000';
            });
        });
        ws3.views = [{ state: 'frozen', ySplit: 1 }];

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('NESMA导出Excel失败:', error);
        res.status(500).json({ error: 'NESMA导出Excel失败: ' + error.message });
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

(async () => {
    try {
        // 初始化 PostgreSQL 数据库表结构
        await initDatabase();
        console.log('✅ 数据库就绪');
    } catch (err) {
        console.error('⚠️ 数据库初始化失败，登录/历史功能将不可用:', err.message);
    }

    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║         COSMIC 功能规模智能分析拆分系统 v2.0             ║
╠══════════════════════════════════════════════════════════╣
║  🌐 服务地址: http://localhost:${PORT}                    ║
║  🤖 当前模型: ${currentModel.padEnd(40)}║
║  📡 API平台: 心流开放平台 (iflow.cn)                    ║
║  🔑 API密钥: ${process.env.IFLOW_API_KEY ? '已配置 ✅' : '未配置 ❌'}                               ║
║  🐘 数据库:  PostgreSQL (Render)                        ║
╚══════════════════════════════════════════════════════════╝
      `);
    });
})();
