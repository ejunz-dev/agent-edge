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
        const timestamp = new Date().toLocaleTimeString();
        
        // 特殊处理事件触发消息，显示更详细的日志
        if (msg.type === 'event/trigger') {
          console.log(`[ProjectionWebSocket] 🎯 收到事件触发消息 [${timestamp}]`, {
            eventId: msg.data?.eventId,
            eventName: msg.data?.eventName,
            actions: msg.data?.actions || [],
            totalActions: msg.data?.actions?.length || 0,
          });
        } else {
          console.log(`[ProjectionWebSocket] 📨 收到消息 [${timestamp}]:`, msg.type, msg);
        }
        
        // 通知所有监听器
        this.listeners.forEach((listener) => {
          try {
            listener(msg);
          } catch (e) {
            console.error('[ProjectionWebSocket] ❌ 监听器错误:', e);
          }
        });
      } catch (e) {
        console.error('[ProjectionWebSocket] ❌ 解析消息失败:', e, ev.data);
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
    console.log('[ProjectionWebSocket] 添加监听器，当前连接数:', this.listeners.size);
    this.listeners.add(listener);
    // 如果还没有连接，先连接
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[ProjectionWebSocket] 连接未建立，开始连接...');
      this.connect();
    } else {
      console.log('[ProjectionWebSocket] 连接已建立，readyState:', this.ws.readyState);
    }
    // 返回取消订阅函数
    return () => {
      console.log('[ProjectionWebSocket] 移除监听器');
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
  const handlerRef = useRef(handler);
  
  // 保持 handler 引用最新
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  
  useEffect(() => {
    console.log(`[useProjectionMessage] 订阅消息类型: ${messageType}`);
    const listener = (msg: any) => {
      console.log(`[useProjectionMessage] 收到消息: type=${msg.type}, 期望=${messageType}`, msg);
      if (msg.type === messageType) {
        console.log(`[useProjectionMessage] 消息类型匹配，调用 handler`);
        try {
          handlerRef.current(msg.data || msg);
        } catch (e) {
          console.error(`[useProjectionMessage] Handler 执行错误:`, e);
        }
      }
    };

    // 订阅并确保连接建立
    const unsubscribe = wsManager.subscribe(listener);
    
    // 确保连接已建立
    if (!wsManager.isConnected()) {
      console.log(`[useProjectionMessage] WebSocket 未连接，尝试连接...`);
      wsManager.connect();
    } else {
      console.log(`[useProjectionMessage] WebSocket 已连接`);
    }

    return () => {
      console.log(`[useProjectionMessage] 取消订阅消息类型: ${messageType}`);
      unsubscribe();
    };
  }, [messageType]);
}

