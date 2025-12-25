import { useEffect, useRef, useState } from 'react';

// 全局 WebSocket 连接管理器（单例模式）
class ProjectionWebSocketManager {
  private ws: WebSocket | null = null;
  private listeners: Set<(data: any) => void> = new Set();
  private reconnectTimer: number | null = null;
  private isConnecting = false;
  private url: string;

  constructor() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    this.url = `${protocol}//${host}/projection-ws`;
  }

  connect() {
    if (this.isConnecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isConnecting = true;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.isConnecting = false;
      console.log('[ProjectionWebSocket] 全局连接已建立');
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        // 通知所有监听器
        this.listeners.forEach((listener) => {
          try {
            listener(msg);
          } catch (e) {
            console.error('[ProjectionWebSocket] 监听器错误:', e);
          }
        });
      } catch (e) {
        console.error('[ProjectionWebSocket] 解析消息失败:', e);
      }
    };

    this.ws.onclose = () => {
      this.isConnecting = false;
      console.log('[ProjectionWebSocket] 连接断开，准备重连...');
      if (this.reconnectTimer) {
        window.clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = window.setTimeout(() => {
        this.connect();
      }, 2000);
    };

    this.ws.onerror = () => {
      this.isConnecting = false;
      console.error('[ProjectionWebSocket] 连接错误');
    };
  }

  subscribe(listener: (data: any) => void) {
    this.listeners.add(listener);
    // 如果还没有连接，先连接
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
    }
    // 返回取消订阅函数
    return () => {
      this.listeners.delete(listener);
    };
  }

  getReadyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners.clear();
  }
}

// 全局单例
const wsManager = new ProjectionWebSocketManager();

// 暴露给全局，方便其他模块访问（用于发送消息）
if (typeof window !== 'undefined') {
  (window as any).__projectionWsManager = wsManager;
}

/**
 * 共享的 WebSocket Hook，所有组件使用同一个连接
 */
export function useProjectionWebSocket() {
  const [connected, setConnected] = useState(false);
  const listenerRef = useRef<((data: any) => void) | null>(null);

  useEffect(() => {
    // 创建监听器
    const listener = (msg: any) => {
      // 更新连接状态
      if (msg.type === 'state' || msg.type === 'agent/content' || msg.type === 'tts/audio') {
        setConnected(wsManager.isConnected());
      }
    };

    listenerRef.current = listener;

    // 订阅
    const unsubscribe = wsManager.subscribe(listener);

    // 更新初始连接状态
    setConnected(wsManager.isConnected());

    return () => {
      unsubscribe();
    };
  }, []);

  return { connected, wsManager };
}

/**
 * Hook: 监听特定类型的消息
 */
export function useProjectionMessage<T = any>(
  messageType: string,
  handler: (data: T) => void
) {
  useEffect(() => {
    const listener = (msg: any) => {
      if (msg.type === messageType) {
        handler(msg.data || msg);
      }
    };

    const unsubscribe = wsManager.subscribe(listener);

    return () => {
      unsubscribe();
    };
  }, [messageType, handler]);
}

