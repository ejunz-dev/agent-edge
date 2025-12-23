import { useEffect, useState } from 'react';

type Cs2State = any;

export function useCs2State() {
  const [state, setState] = useState<Cs2State | null>(null);
  const [connected, setConnected] = useState(false);

  // WebSocket 实时连接
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/projection-ws`;

    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onclose = () => {
        setConnected(false);
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        setConnected(false);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'state') {
            setState(msg.data || null);
          }
        } catch {
          // ignore
        }
      };
    };

    connect();

    return () => {
      if (ws) ws.close();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, []);

  // 初次加载时通过 REST 拉一次
  useEffect(() => {
    fetch('/api/projection/state')
      .then((res) => res.json())
      .then((data) => {
        if (data?.state) setState(data.state);
      })
      .catch(() => {});
  }, []);

  return { state, connected };
}

