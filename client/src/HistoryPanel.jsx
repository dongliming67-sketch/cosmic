import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
    History, FileText, Trash2, Eye, Clock, BarChart3,
    ChevronRight, Search, X, AlertCircle, RefreshCw, Plus
} from 'lucide-react';

export default function HistoryPanel({ token, onLoadConversation, onNewConversation, isOpen, onClose }) {
    const [conversations, setConversations] = useState([]);
    const [loading, setLoading] = useState(false);
    const [searchText, setSearchText] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState(null);

    // 创建带认证的axios实例
    const authAxios = axios.create({
        headers: { Authorization: `Bearer ${token}` }
    });

    // 加载对话列表
    const loadConversations = async () => {
        setLoading(true);
        try {
            const res = await authAxios.get('/api/auth/conversations');
            if (res.data.success) {
                setConversations(res.data.conversations);
            }
        } catch (err) {
            console.error('加载对话列表失败:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen && token) {
            loadConversations();
        }
    }, [isOpen, token]);

    // 删除对话
    const handleDelete = async (id) => {
        try {
            await authAxios.delete(`/api/auth/conversations/${id}`);
            setConversations(prev => prev.filter(c => c.id !== id));
            setDeleteConfirm(null);
        } catch (err) {
            console.error('删除对话失败:', err);
        }
    };

    // 加载对话
    const handleLoad = async (id) => {
        try {
            const res = await authAxios.get(`/api/auth/conversations/${id}`);
            if (res.data.success) {
                onLoadConversation(res.data.conversation);
                onClose();
            }
        } catch (err) {
            console.error('加载对话详情失败:', err);
        }
    };

    // 格式化时间
    const formatTime = (dateStr) => {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}天前`;

        return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    };

    // 搜索过滤
    const filteredConversations = conversations.filter(c => {
        if (!searchText.trim()) return true;
        const q = searchText.toLowerCase();
        return (c.title || '').toLowerCase().includes(q)
            || (c.document_name || '').toLowerCase().includes(q);
    });

    if (!isOpen) return null;

    return (
        <div className="history-overlay" onClick={onClose}>
            <div className="history-panel" onClick={e => e.stopPropagation()}>
                {/* 面板头部 */}
                <div className="history-header">
                    <div className="history-header-title">
                        <History size={20} />
                        <h3>历史分析记录</h3>
                        <span className="history-count">{conversations.length}</span>
                    </div>
                    <div className="history-header-actions">
                        <button
                            className="history-action-btn"
                            onClick={loadConversations}
                            title="刷新"
                        >
                            <RefreshCw size={16} className={loading ? 'spinning' : ''} />
                        </button>
                        <button className="history-close-btn" onClick={onClose}>
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* 搜索栏 */}
                <div className="history-search">
                    <Search size={16} />
                    <input
                        type="text"
                        placeholder="搜索分析记录..."
                        value={searchText}
                        onChange={e => setSearchText(e.target.value)}
                    />
                    {searchText && (
                        <button className="history-search-clear" onClick={() => setSearchText('')}>
                            <X size={14} />
                        </button>
                    )}
                </div>

                {/* 新建按钮 */}
                <button className="history-new-btn" onClick={() => { onNewConversation(); onClose(); }}>
                    <Plus size={16} />
                    新建分析
                </button>

                {/* 对话列表 */}
                <div className="history-list">
                    {loading ? (
                        <div className="history-loading">
                            <RefreshCw size={24} className="spinning" />
                            <p>加载中...</p>
                        </div>
                    ) : filteredConversations.length === 0 ? (
                        <div className="history-empty">
                            <FileText size={40} />
                            <p>{searchText ? '没有找到匹配的记录' : '暂无分析记录'}</p>
                            <span>{searchText ? '试试其他关键词' : '上传文档开始您的第一次分析'}</span>
                        </div>
                    ) : (
                        filteredConversations.map(conv => (
                            <div
                                key={conv.id}
                                className="history-item"
                                onClick={() => handleLoad(conv.id)}
                            >
                                <div className="history-item-icon">
                                    <FileText size={18} />
                                </div>

                                <div className="history-item-content">
                                    <div className="history-item-title">{conv.title || '未命名分析'}</div>
                                    <div className="history-item-meta">
                                        {conv.document_name && (
                                            <span className="history-item-doc">
                                                📄 {conv.document_name}
                                            </span>
                                        )}
                                        <span className="history-item-mode">
                                            {conv.analysis_mode === 'nesma' ? 'NESMA' : 'COSMIC'}
                                        </span>
                                    </div>
                                    <div className="history-item-stats">
                                        <span>
                                            <Clock size={12} />
                                            {formatTime(conv.updated_at)}
                                        </span>
                                        {conv.function_count > 0 && (
                                            <span>
                                                <BarChart3 size={12} />
                                                {conv.function_count}个功能 · {conv.cfp_count} CFP
                                            </span>
                                        )}
                                    </div>
                                </div>

                                <div className="history-item-actions">
                                    <button
                                        className="history-item-btn view"
                                        onClick={(e) => { e.stopPropagation(); handleLoad(conv.id); }}
                                        title="查看详情"
                                    >
                                        <Eye size={14} />
                                    </button>
                                    <button
                                        className="history-item-btn delete"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setDeleteConfirm(conv.id);
                                        }}
                                        title="删除"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>

                                {/* 删除确认 */}
                                {deleteConfirm === conv.id && (
                                    <div className="history-delete-confirm" onClick={e => e.stopPropagation()}>
                                        <AlertCircle size={16} />
                                        <span>确认删除？</span>
                                        <button
                                            className="confirm-yes"
                                            onClick={() => handleDelete(conv.id)}
                                        >
                                            删除
                                        </button>
                                        <button
                                            className="confirm-no"
                                            onClick={() => setDeleteConfirm(null)}
                                        >
                                            取消
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
