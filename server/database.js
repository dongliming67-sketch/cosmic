// ═══════════════════════════════════════════════════════════
// COSMIC 拆分系统 - PostgreSQL 数据库模块
// ═══════════════════════════════════════════════════════════

const { Pool } = require('pg');

// 从环境变量读取数据库连接（Render 会自动注入 DATABASE_URL）
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.warn('⚠️ 未设置 DATABASE_URL 环境变量，数据库功能将不可用');
    console.warn('   本地开发请在 .env 中配置 DATABASE_URL');
    console.warn('   Render 部署会自动注入此变量');
}

// 创建连接池
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// ═══════════════════════ 初始化表结构 ═══════════════════════

async function initDatabase() {
    try {
        await pool.query(`
            -- 用户表
            CREATE TABLE IF NOT EXISTS users (
                id           SERIAL PRIMARY KEY,
                username     TEXT    NOT NULL UNIQUE,
                password_hash TEXT   NOT NULL,
                display_name TEXT    NOT NULL DEFAULT '',
                avatar_color TEXT    NOT NULL DEFAULT '#6C63FF',
                created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
                last_login   TIMESTAMP
            );

            -- 对话/分析会话表
            CREATE TABLE IF NOT EXISTS conversations (
                id             SERIAL PRIMARY KEY,
                user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title          TEXT    NOT NULL DEFAULT '未命名分析',
                document_name  TEXT    DEFAULT '',
                analysis_mode  TEXT    DEFAULT 'cosmic',
                messages       TEXT    DEFAULT '[]',
                table_data     TEXT    DEFAULT '[]',
                function_list  TEXT    DEFAULT '',
                function_count INTEGER DEFAULT 0,
                cfp_count      INTEGER DEFAULT 0,
                created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
            );

            -- 为查询加速创建索引
            CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
            CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);
        `);
        console.log('✅ PostgreSQL 数据库初始化完成');
    } catch (error) {
        console.error('❌ 数据库初始化失败:', error.message);
        throw error;
    }
}

// ═══════════════════════ 用户操作 ═══════════════════════

const userOps = {
    /** 创建用户 */
    async create({ username, passwordHash, displayName, avatarColor }) {
        const result = await pool.query(
            `INSERT INTO users (username, password_hash, display_name, avatar_color)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [username, passwordHash, displayName, avatarColor]
        );
        return { lastInsertRowid: result.rows[0].id };
    },

    /** 按用户名查找 */
    async findByUsername(username) {
        const result = await pool.query(
            `SELECT * FROM users WHERE username = $1`,
            [username]
        );
        return result.rows[0] || null;
    },

    /** 按ID查找 */
    async findById(id) {
        const result = await pool.query(
            `SELECT id, username, display_name, avatar_color, created_at, last_login
             FROM users WHERE id = $1`,
            [id]
        );
        return result.rows[0] || null;
    },

    /** 更新最后登录时间 */
    async updateLastLogin(id) {
        await pool.query(
            `UPDATE users SET last_login = NOW() WHERE id = $1`,
            [id]
        );
    },

    /** 更新用户信息 */
    async updateProfile({ id, displayName }) {
        await pool.query(
            `UPDATE users SET display_name = $1 WHERE id = $2`,
            [displayName, id]
        );
    }
};

// ═══════════════════════ 对话操作 ═══════════════════════

const conversationOps = {
    /** 创建新对话 */
    async create({ userId, title, documentName, analysisMode }) {
        const result = await pool.query(
            `INSERT INTO conversations (user_id, title, document_name, analysis_mode)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [userId, title, documentName, analysisMode]
        );
        return { lastInsertRowid: result.rows[0].id };
    },

    /** 更新对话内容 */
    async update({ id, userId, title, messages, tableData, functionList, functionCount, cfpCount }) {
        await pool.query(
            `UPDATE conversations
             SET title = $1,
                 messages = $2,
                 table_data = $3,
                 function_list = $4,
                 function_count = $5,
                 cfp_count = $6,
                 updated_at = NOW()
             WHERE id = $7 AND user_id = $8`,
            [title, messages, tableData, functionList, functionCount, cfpCount, id, userId]
        );
    },

    /** 获取用户的所有对话（按更新时间倒序） */
    async listByUser(userId) {
        const result = await pool.query(
            `SELECT id, title, document_name, analysis_mode, function_count, cfp_count,
                    created_at, updated_at
             FROM conversations
             WHERE user_id = $1
             ORDER BY updated_at DESC`,
            [userId]
        );
        return result.rows;
    },

    /** 获取单个对话详情 */
    async getById(id, userId) {
        const result = await pool.query(
            `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );
        return result.rows[0] || null;
    },

    /** 删除对话 */
    async delete(id, userId) {
        await pool.query(
            `DELETE FROM conversations WHERE id = $1 AND user_id = $2`,
            [id, userId]
        );
    },

    /** 统计用户对话数量 */
    async countByUser(userId) {
        const result = await pool.query(
            `SELECT COUNT(*) as count FROM conversations WHERE user_id = $1`,
            [userId]
        );
        return result.rows[0];
    }
};

module.exports = {
    pool,
    userOps,
    conversationOps,
    initDatabase
};
