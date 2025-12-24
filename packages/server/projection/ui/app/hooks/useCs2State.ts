import { useEffect, useState } from 'react';
import { useProjectionMessage, useProjectionWebSocket } from './useProjectionWebSocket';

type Cs2State = any;

export function useCs2State() {
  const [state, setState] = useState<Cs2State | null>(null);
  const { connected } = useProjectionWebSocket();

  // 使用共享的 WebSocket 连接监听 state 消息
  useProjectionMessage('state', (data: any) => {
    setState(data || null);
  });

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

