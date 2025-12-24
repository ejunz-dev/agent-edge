import { Box } from '@mantine/core';
import React, { useEffect, useRef, useState } from 'react';
import { useProjectionMessage } from '../../hooks/useProjectionWebSocket';
import { useCs2State } from '../../hooks/useCs2State';
import EmojiDisplayComponent from '../../components/EmojiDisplay';

export default function EmojiDisplay() {
  const [trigger, setTrigger] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const liveStartTimeRef = useRef<number | null>(null);
  const roundPhaseRef = useRef<string>('');
  
  const { state } = useCs2State();
  const round = state?.round || {};
  const roundPhase = round?.phase || '';
  
  // 更新 ref
  useEffect(() => {
    roundPhaseRef.current = roundPhase;
  }, [roundPhase]);
  
  // 检测 live 阶段
  const isLive = roundPhase === 'live';

  // 监听 agent/content/start - 切换表情包
  useProjectionMessage('agent/content/start', () => {
    // 检查是否在 live 10 秒后，如果是则不处理新内容
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= 10000) {
        // 已经超过 10 秒，忽略新内容
        return;
      }
    }
    
    // 切换表情包（每句话换一个）
    setTrigger((prev) => prev + 1);
    setHasContent(true);
    console.log('[EmojiWidget] 开始接收新内容，切换表情包');
  });

  // 监听 agent/content - 标记有内容
  useProjectionMessage('agent/content', (data: any) => {
    // 检查是否在 live 10 秒后
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= 10000) {
        return;
      }
    }
    
    setHasContent(true);
  });

  // 监听 agent/message - 标记有内容
  useProjectionMessage('agent/message', (data: any) => {
    // 检查是否在 live 10 秒后
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= 10000) {
        return;
      }
    }
    
    const message = data || data.payload?.[0];
    if (message?.content) {
      setHasContent(true);
    }
  });

  // 处理 live 阶段：10 秒后清空并隐藏
  useEffect(() => {
    if (isLive) {
      const now = Date.now();
      if (liveStartTimeRef.current === null) {
        liveStartTimeRef.current = now;
      }
      
      const elapsed = now - liveStartTimeRef.current;
      const remainingTime = Math.max(0, 10000 - elapsed);
      const hideTimer = setTimeout(() => {
        setHasContent(false);
        setIsVisible(false);
        liveStartTimeRef.current = null;
      }, remainingTime);

      return () => {
        clearTimeout(hideTimer);
      };
    } else {
      liveStartTimeRef.current = null;
    }
  }, [isLive]);

  // 控制显示/隐藏：有内容时显示，但 live 10 秒后强制隐藏
  useEffect(() => {
    if (hasContent) {
      // 检查是否在 live 10 秒后
      if (isLive && liveStartTimeRef.current) {
        const elapsed = Date.now() - liveStartTimeRef.current;
        if (elapsed >= 10000) {
          setIsVisible(false);
          return;
        }
      }
      setIsVisible(true);
    } else {
      setIsVisible(false);
    }
  }, [hasContent, isLive, trigger]);

  // 如果没有内容或不可见，不渲染组件
  if (!isVisible || !hasContent) {
    return null;
  }

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '200px',
        height: '200px',
        minWidth: '200px',
        minHeight: '200px',
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(-20px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <EmojiDisplayComponent trigger={trigger} size={200} random={false} />
    </Box>
  );
}

