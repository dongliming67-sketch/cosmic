// ═══════════════════════════════════════════════════════════
// COSMIC 拆分系统 - AI客户端模块
// ═══════════════════════════════════════════════════════════

const OpenAI = require('openai');

// 模型映射表（心流平台模型ID，全部小写）
const MODEL_MAP = {
    'deepseek-v3': 'deepseek-v3',
    'deepseek-v3.2': 'deepseek-v3.2',
    'qwen3-coder': 'qwen3-coder-plus',
    'qwen3-coder-plus': 'qwen3-coder-plus',
    // 兼容旧版大写名称
    'DeepSeek-V3-671B': 'deepseek-v3',
    'Qwen3-Coder-Plus': 'qwen3-coder-plus'
};

/**
 * 获取 OpenAI 兼容客户端（指向心流平台）
 */
function createClient(apiKey, baseUrl) {
    return new OpenAI({
        apiKey: apiKey || process.env.IFLOW_API_KEY,
        baseURL: baseUrl || process.env.IFLOW_BASE_URL || 'https://apis.iflow.cn/v1'
    });
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

    const client = createClient(apiKey, baseUrl);
    const modelName = MODEL_MAP[model] || model;

    if (stream && res) {
        // 流式调用
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
    } else {
        // 非流式调用
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
 * @param {Object} options - callAI的选项
 * @param {number} maxRetries - 最大重试次数
 * @returns {Object} AI响应
 */
async function callAIWithRetry(options, maxRetries = 3) {
    const baseDelay = 3000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                const delay = baseDelay * (attempt + 1);
                console.log(`   ⏳ 第 ${attempt + 1} 次重试，等待 ${delay / 1000} 秒...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            return await callAI(options);
        } catch (error) {
            const status = error.status || error.response?.status;
            const isRetryable = status === 429 || status === 500 || status === 502 || status === 503
                || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED'
                || error.message?.includes('timeout') || error.message?.includes('429');

            console.warn(`   ⚠️ AI调用失败 (尝试 ${attempt + 1}/${maxRetries}): [${status || error.code || '?'}] ${error.message?.substring(0, 200)}`);

            if (isRetryable && attempt < maxRetries - 1) {
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
