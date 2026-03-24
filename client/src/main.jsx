import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import LoginPage from './LoginPage.jsx'
import './index.css'
import axios from 'axios'

function Root() {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(null);
    const [checking, setChecking] = useState(true);

    // 启动时检查本地 token 是否有效
    useEffect(() => {
        const savedToken = localStorage.getItem('cosmic_token');
        const savedUser = localStorage.getItem('cosmic_user');

        if (savedToken && savedUser) {
            // 验证 token
            axios.get('/api/auth/me', {
                headers: { Authorization: `Bearer ${savedToken}` }
            }).then(res => {
                if (res.data.success) {
                    setUser(res.data.user);
                    setToken(savedToken);
                } else {
                    clearAuth();
                }
            }).catch(() => {
                clearAuth();
            }).finally(() => {
                setChecking(false);
            });
        } else {
            setChecking(false);
        }
    }, []);

    const clearAuth = () => {
        localStorage.removeItem('cosmic_token');
        localStorage.removeItem('cosmic_user');
        setUser(null);
        setToken(null);
    };

    const handleLoginSuccess = (userData, authToken) => {
        setUser(userData);
        setToken(authToken);
    };

    const handleLogout = () => {
        clearAuth();
    };

    if (checking) {
        return (
            <div className="auth-checking">
                <div className="auth-checking-spinner" />
                <p>加载中...</p>
            </div>
        );
    }

    if (!user || !token) {
        return <LoginPage onLoginSuccess={handleLoginSuccess} />;
    }

    return <App user={user} token={token} onLogout={handleLogout} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <Root />
    </React.StrictMode>,
)
