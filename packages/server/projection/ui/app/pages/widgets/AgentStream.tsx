import { Box, Paper, Text } from '@mantine/core';
import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProjectionMessage } from '../../hooks/useProjectionWebSocket';
import { useCs2State } from '../../hooks/useCs2State';
import { WidgetConfig } from '../../utils/widgetConfig';

interface AgentStreamProps {
  config?: WidgetConfig;
}

export default function AgentStream({ config }: AgentStreamProps) {
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const [content, setContent] = useState('');
  const contentRef = useRef<string>('');
  const hasContentRef = useRef(false); // 标记是否曾经收到过内容
  const [isVisible, setIsVisible] = useState(false);
  const liveStartTimeRef = useRef<number | null>(null);
  const roundPhaseRef = useRef<string>(''); // 用于在回调中获取最新的 roundPhase
  
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
      hasContentRef.current = true;
    }
  }, [isPreview]);
  
  // 检测 live 阶段
  const isLive = roundPhase === 'live';

  const liveTimeout = config?.liveTimeout || 10000;
  const style = config?.style || {};
  const textConfig = config?.text || {};

  // 使用共享的 WebSocket 连接监听 agent/content 消息
  useProjectionMessage('agent/content', (data: any) => {
    // 检查是否在 live 超时后，如果是则不处理新内容
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= liveTimeout) {
        // 已经超过超时时间，忽略新内容
        return;
      }
    }
    
    // 收到 Agent 流式内容
    const contentData = data;
    
    // 处理不同格式的内容数据
    let newChunk = '';
    if (typeof contentData === 'string') {
      // 直接是字符串
      newChunk = contentData;
    } else if (contentData?.content) {
      // 对象格式，包含 content 字段
      newChunk = contentData.content;
    } else if (contentData?.chunk) {
      // 对象格式，包含 chunk 字段
      newChunk = contentData.chunk;
    }
    
    if (newChunk) {
      // 累积内容
      contentRef.current += newChunk;
      hasContentRef.current = true; // 标记已收到内容
      setContent(contentRef.current);
    }
  });

  // 监听 agent/content/start
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
    
    // 内容开始，重置累积内容（但保持显示，因为即将有内容）
    contentRef.current = '';
    hasContentRef.current = true; // 收到开始信号，表示即将有内容
    setContent('');
    console.log('[AgentStream] 开始接收新内容');
  });

  // 监听 agent/content/end
  useProjectionMessage('agent/content/end', () => {
    // 内容结束
    console.log('[AgentStream] 内容接收完成，总长度:', contentRef.current.length);
    // 如果内容为空，则隐藏组件
    if (contentRef.current.length === 0) {
      hasContentRef.current = false;
      setContent('');
    }
  });

  // 监听 agent/message
  useProjectionMessage('agent/message', (data: any) => {
    // 检查是否在 live 超时后，如果是则不处理新内容
    const currentPhase = roundPhaseRef.current;
    if (currentPhase === 'live' && liveStartTimeRef.current) {
      const elapsed = Date.now() - liveStartTimeRef.current;
      if (elapsed >= liveTimeout) {
        // 已经超过超时时间，忽略新内容
        return;
      }
    }
    
    // 新协议：agent/message 事件，可能包含完整内容
    const message = data || data.payload?.[0];
    if (message?.content) {
      contentRef.current = message.content;
      hasContentRef.current = true; // 标记已收到内容
      setContent(message.content);
    }
  });

  // 处理 live 阶段：超时后清空并隐藏
  useEffect(() => {
    if (isLive) {
      // live 阶段开始，记录开始时间
      const now = Date.now();
      if (liveStartTimeRef.current === null) {
        liveStartTimeRef.current = now;
      }
      
      // 超时后清空内容并隐藏
      const elapsed = now - liveStartTimeRef.current;
      const remainingTime = Math.max(0, liveTimeout - elapsed);
      const hideTimer = setTimeout(() => {
        // 清空内容
        contentRef.current = '';
        hasContentRef.current = false;
        setContent('');
        setIsVisible(false);
        // 重置 live 开始时间，以便下次 live 阶段重新计时
        liveStartTimeRef.current = null;
      }, remainingTime);

      return () => {
        clearTimeout(hideTimer);
      };
    } else {
      // 不是 live 阶段，重置开始时间
      liveStartTimeRef.current = null;
    }
  }, [isLive, liveTimeout]);

  // 控制显示/隐藏：有内容时显示，但 live 10 秒后强制隐藏
  useEffect(() => {
    if (hasContentRef.current || content) {
      // 检查是否在 live 10 秒后
      if (isLive && liveStartTimeRef.current) {
        const elapsed = Date.now() - liveStartTimeRef.current;
        if (elapsed >= 10000) {
          // 已经超过 10 秒，隐藏
          setIsVisible(false);
          return;
        }
      }
      // 有内容且不在 live 10 秒后，显示
      setIsVisible(true);
    } else {
      setIsVisible(false);
    }
  }, [content, isLive]);

  // 预览模式下始终显示，否则根据条件显示
  if (!isPreview && (!isVisible || (!hasContentRef.current && !content))) {
    return null;
  }
  
  // 预览模式下使用示例内容
  const displayContent = isPreview ? '这是 Agent 流式内容的示例文本，用于预览组件样式。' : content;

  return (
    <Box
      style={{
        width: '100%',
        maxWidth: style.maxWidth ? `${style.maxWidth}px` : '100%',
        padding: '8px',
        display: 'flex',
        justifyContent: 'center',
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(-20px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <Paper
        p={style.padding || 'sm'}
        radius={style.borderRadius || 'md'}
        style={{
          background: style.background || 'rgba(20, 20, 25, 0.95)',
          border: style.borderColor ? `1px solid ${style.borderColor}` : '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: style.shadow ? `0 4px 20px rgba(0, 0, 0, 0.5)` : '0 4px 20px rgba(0, 0, 0, 0.5)',
          width: style.width ? `${style.width}px` : style.minWidth ? `${style.minWidth}px` : '600px',
          maxWidth: style.maxWidth ? `${style.maxWidth}px` : style.width ? `${style.width}px` : '600px',
          minWidth: style.minWidth ? `${style.minWidth}px` : undefined,
          minHeight: 'auto',
        }}
      >
        {displayContent ? (
          <Text
            size={textConfig.size || 'sm'}
            c={textConfig.color || 'white'}
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.5,
              fontSize: '14px',
              display: 'block',
            }}
          >
            {displayContent}
            {/* 打字机光标效果 */}
            <span
              style={{
                display: 'inline-block',
                width: '2px',
                height: '1em',
                backgroundColor: 'white',
                marginLeft: '2px',
                animation: 'blink 1s infinite',
              }}
            />
          </Text>
        ) : (
          <Text size="xs" c="dimmed" ta="center" py="md">
            等待 Agent 回复...
          </Text>
        )}
      </Paper>
      
      <style>
        {`
          @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
          }
        `}
      </style>
    </Box>
  );
}

