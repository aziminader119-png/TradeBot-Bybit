import React, { Component, ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AuthShell } from './components/auth/AuthShell.tsx';
import { installApiFetch } from './security/apiClient.ts';

installApiFetch();
import './index.css';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[TradeBot Pro] Uncaught UI error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          background: '#101014',
          color: '#fafafa',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          fontFamily: "'Vazirmatn', system-ui, sans-serif",
          textAlign: 'center',
        }}>
          <div style={{
            background: '#15151c',
            border: '1px solid #282836',
            borderRadius: 8,
            padding: 32,
            maxWidth: 500,
            width: '100%',
          }}>
            <div style={{ color: '#dda052', fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px 0', color: '#fafafa' }}>
              خطایی در رندر رابط کاربری رخ داد
            </h2>
            <p style={{ fontSize: 13, color: '#8d9098', margin: '0 0 20px 0' }}>
              {this.state.error?.message || 'مشکل موقتی در اتصال یا داده‌ها رخ داده است.'}
            </p>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              style={{
                background: '#dda052',
                color: '#101014',
                fontWeight: 700,
                border: 'none',
                padding: '8px 20px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              بارگذاری مجدد سیستم
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <AuthShell>
      <App />
    </AuthShell>
  </ErrorBoundary>
);
