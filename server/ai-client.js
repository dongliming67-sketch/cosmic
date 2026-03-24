// ═══════════════════════════════════════════════════════════
// COSMIC 拆分系统 - AI客户端模块
// ═══════════════════════════════════════════════════════════

const OpenAI = require('openai');

// 模型映射表
const MODEL_MAP = {
    'deepseek-v3': 'deepseek-v3',
    'deepseek-v3.2': 'deepseek-v3.2',
    'deepseek-r1': 'deepseek-r1',              // 深度思考模式
    'deepseek-reasoner': 'deepseek-r1',         // 别名
    'qwen3-coder': 'qwen3-coder-plus',
    'qwen3-coder-plus': 'qwen3-coder-plus',
    'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
    // 兼容旧版大写名称
    'DeepSeek-V3-671B': 'deepseek-v3',
    'Qwen3-Coder-Plus': 'qwen3-coder-plus'
};

// GPT平台模型列表（使用不同的API密钥和基础URL）
const GPT_MODELS = new Set(['gpt-5.1-codex-mini']);

// 必须使用流式调用的模型（R1 思考链很长，流式更稳定；GPT平台也需要流式）
const STREAM_ONLY_MODELS = new Set(['gpt-5.1-codex-mini', 'deepseek-r1']);

/**
 * 获取 OpenAI 兼容客户端（指向心流平台）
 */
function createClient(apiKey, baseUrl, model) {
    // 如果是GPT平台模型，使用GPT平台的密钥和URL
    const isGptModel = model && GPT_MODELS.has(model);
    const key = apiKey || (isGptModel ? process.env.GPT_API_KEY : process.env.IFLOW_API_KEY);
    const url = baseUrl || (isGptModel ? (process.env.GPT_BASE_URL || 'https://x.ainiaini.xyz/v1') : (process.env.IFLOW_BASE_URL || 'https://apis.iflow.cn/v1'));
    return new OpenAI({ apiKey: key, baseURL: url });
}

/**
 * 调用 AI Chat 接口
 * @param {Object} options - 调用选项
 * @param {Array} options.messages - 消息数组
 * @param {string} options.model - 模型标识
 * @param {number} options.temperature - 温度参数
 * @param {number} options.max_tokens - 最大token数
 * @param {boolean} options.stream - 是否流式
 * @param {Object} options.res - Express response对象（流式时使用）
 * @param {string} options.apiKey - API密钥
 * @param {string} options.baseUrl - API基础URL
 * @returns {Object|null} AI响应
 */
async function callAI(options) {
    const {
        messages,
        model = process.env.DEFAULT_MODEL || 'DeepSeek-V3-671B',
        temperature = 0.7,
        max_tokens = 8000,
        stream = false,
        res = null,
        apiKey = null,
        baseUrl = null
    } = options;

    const modelName = MODEL_MAP[model] || model;
    const client = createClient(apiKey, baseUrl, modelName);
    const isStreamOnly = STREAM_ONLY_MODELS.has(modelName);

    if (stream && res) {
        // 流式调用（直接输出给客户端）
        const completion = await client.chat.completions.create({
            model: modelName,
            messages,
            temperature,
            max_tokens,
            stream: true
        });

        for await (const chunk of completion) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) {
                res.write(`data: ${JSON.stringify({ content })}\n\n`);
            }
        }
        return null;
    } else if (isStreamOnly) {
        // 强制流式模型：内部用stream调用，收集完整响应后返回为非流式结果
        console.log(`   📡 模型 ${modelName} 强制流式调用中...`);
        const completion = await client.chat.completions.create({
            model: modelName,
            messages,
            temperature,
            max_tokens,
            stream: true
        });

        let fullContent = '';
        let thinkingContent = '';
        const isR1 = modelName === 'deepseek-r1';
        for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta;
            // R1 模型：reasoning_content 是思考链，content 是最终答案
            if (isR1 && delta?.reasoning_content) {
                thinkingContent += delta.reasoning_content;
            }
            const content = delta?.content || '';
            fullContent += content;
        }
        if (isR1 && thinkingContent) {
            console.log(`   🧠 DeepSeek-R1 思考链长度: ${thinkingContent.length} 字符`);
        }

        // 构造一个兼容非流式格式的响应对象
        return {
            choices: [{
                message: { role: 'assistant', content: fullContent },
                finish_reason: 'stop'
            }],
            model: modelName,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        };
    } else {
        // 标准非流式调用
        const completion = await client.chat.completions.create({
            model: modelName,
            messages,
            temperature,
            max_tokens,
            stream: false
        });

        // 验证API响应格式（心流平台可能返回200但body是错误信息）
        if (completion && completion.status && completion.msg && !completion.choices) {
            throw new Error(`API错误 [${completion.status}]: ${completion.msg}（模型: ${modelName}）`);
        }

        return completion;
    }
}

/**
 * 带重试机制的AI调用
 * - 449/429 rate limit: 指数退避，从10秒起，最长60秒，带随机抖动
 * - 网络/JSON错误: 指数退避，从3秒起
 * @param {Object} options - callAI的选项
 * @param {number} maxRetries - 最大重试次数
 * @returns {Object} AI响应
 */
async function callAIWithRetry(options, maxRetries = 6) {

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                // 日志已在上一轮 catch 中输出
            }

            return await callAI(options);
        } catch (error) {
            const status = error.status || error.response?.status;
            const isRateLimit = status === 429 || status === 449
                || error.message?.includes('429') || error.message?.includes('449')
                || error.message?.includes('rate limit') || error.message?.includes('Rate Limit')
                || error.message?.includes('exceeded your current rate');
            const isRetryable = isRateLimit
                || status === 500 || status === 502 || status === 503
                || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED'
                || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || error.code === 'ECONNREFUSED'
                || error.message?.includes('timeout')
                || error.message?.includes('Unexpected end of JSON') || error.message?.includes('invalid json response body')
                || error.message?.includes('unexpected end of file')
                || error.message?.includes('Premature close') || error.message?.includes('premature close')
                || error.message?.includes('PREMATURE_CLOSE') || error.message?.includes('Invalid response body');

            console.warn(`   ⚠️ AI调用失败 (尝试 ${attempt + 1}/${maxRetries}): [${status || error.code || '?'}] ${error.message?.substring(0, 200)}`);

            if (isRetryable && attempt < maxRetries - 1) {
                // Rate limit: 更激进的退避 (10s, 20s, 40s, 60s, 60s ...)
                // 普通错误: 常规退避 (3s, 6s, 12s, 24s, 48s ...)
                let delay;
                if (isRateLimit) {
                    delay = Math.min(10000 * Math.pow(2, attempt), 60000);
                    console.log(`   🚫 触发限流(${status || '?'})，第 ${attempt + 1} 次重试，等待 ${(delay / 1000).toFixed(0)} 秒...`);
                } else {
                    delay = Math.min(3000 * Math.pow(2, attempt), 30000);
                    console.log(`   ⏳ 第 ${attempt + 1} 次重试，等待 ${(delay / 1000).toFixed(0)} 秒...`);
                }
                // 加入随机抖动 ±20%，避免多请求同时重试雪崩
                const jitter = delay * (0.8 + Math.random() * 0.4);
                await new Promise(resolve => setTimeout(resolve, jitter));
                continue;
            }
            throw error;
        }
    }
}

module.exports = {
    createClient,
    callAI,
    callAIWithRetry,
    MODEL_MAP
};
