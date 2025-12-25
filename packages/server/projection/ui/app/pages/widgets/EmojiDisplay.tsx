import { Box } from '@mantine/core';
import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProjectionMessage } from '../../hooks/useProjectionWebSocket';
import { useCs2State } from '../../hooks/useCs2State';
import EmojiDisplayComponent from '../../components/EmojiDisplay';
import { WidgetConfig } from '../../utils/widgetConfig';

interface EmojiDisplayProps {
  config?: WidgetConfig;
}

export default function EmojiDisplay({ config }: EmojiDisplayProps) {
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
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
  
  // 预览模式下始终显示
  useEffect(() => {
    if (isPreview) {
      setIsVisible(true);
      setHasContent(true);
    }
  }, [isPreview]);
  
  // 检测 live 阶段
  const isLive = roundPhase === 'live';

  const liveTimeout = config?.liveTimeout || 10000;
  const emojiSize = config?.size || 200;
  const style = config?.style || {};

  // 监听 agent/content/start - 切换表情包
  useProjectionMessage('agent/content/start', () => {
    // 检查是否在 live 超时后，如果是则不处理新内容
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= liveTimeout) {
        // 已经超过超时时间，忽略新内容
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
    // 检查是否在 live 超时后
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= liveTimeout) {
        return;
      }
    }
    
    setHasContent(true);
  });

  // 监听 agent/message - 标记有内容
  useProjectionMessage('agent/message', (data: any) => {
    // 检查是否在 live 超时后
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= liveTimeout) {
        return;
      }
    }
    
    const message = data || data.payload?.[0];
    if (message?.content) {
      setHasContent(true);
    }
  });

  // 处理 live 阶段：超时后清空并隐藏
  useEffect(() => {
    if (isLive) {
      const now = Date.now();
      if (liveStartTimeRef.current === null) {
        liveStartTimeRef.current = now;
      }
      
      const elapsed = now - liveStartTimeRef.current;
      const remainingTime = Math.max(0, liveTimeout - elapsed);
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
  }, [isLive, liveTimeout]);

  // 控制显示/隐藏：有内容时显示，但 live 超时后强制隐藏
  useEffect(() => {
    if (hasContent) {
      // 检查是否在 live 超时后
      if (isLive && liveStartTimeRef.current) {
        const elapsed = Date.now() - liveStartTimeRef.current;
        if (elapsed >= liveTimeout) {
          setIsVisible(false);
          return;
        }
      }
      setIsVisible(true);
    } else {
      setIsVisible(false);
    }
  }, [hasContent, isLive, trigger, liveTimeout]);

  // 预览模式下始终显示，否则根据条件显示
  if (!isPreview && (!isVisible || !hasContent)) {
    return null;
  }

  const width = style.width || emojiSize;
  const height = style.height || emojiSize;
  const minWidth = style.minWidth || emojiSize;
  const minHeight = style.minHeight || emojiSize;

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${width}px`,
        height: `${height}px`,
        minWidth: `${minWidth}px`,
        minHeight: `${minHeight}px`,
        opacity: (isVisible || isPreview) ? 1 : 0,
        transform: (isVisible || isPreview) ? 'translateY(0)' : 'translateY(-20px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <EmojiDisplayComponent trigger={isPreview ? 1 : trigger} size={emojiSize} random={false} />
    </Box>
  );
}

