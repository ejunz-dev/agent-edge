import {
  Badge,
  Button,
  Card,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
  ActionIcon,
  Tooltip,
  TextInput,
} from '@mantine/core';
import { IconVolume, IconVolumeOff, IconPlayerPlay, IconPlayerPause, IconDownload, IconSend } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import React, { useEffect, useRef, useState } from 'react';

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
  toolName?: string;  // tool 类型
  toolResult?: any;   // tool 类型
  responseTime?: number;  // tool 类型
  hasAudio?: boolean;  // assistant 类型，是否有音频
}

// 新协议：Agent Message 对象
interface AgentMessage {
  messageId: string;
  type: 'audio' | 'toolcall';
  content?: string;  // audio 类型
  contentChunks?: string[];  // audio 类型
  toolName?: string;  // toolcall 类型
  toolResult?: any;  // toolcall 类型
  status: 'pending' | 'playing' | 'completed';
  startTime: number;
  endTime?: number;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [status, setStatus] = useState('正在连接...');
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [chunksReceived, setChunksReceived] = useState(0);
  const [bytesReceived, setBytesReceived] = useState(0);
  const [inputValue, setInputValue] = useState('');  // 输入框内容
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const audioEnabledRef = useRef(false);
  const currentAudioContextRef = useRef<AudioContext | null>(null);
  const sampleRate = 24000;
  
  // 新协议：消息队列管理
  const messageQueueRef = useRef<AgentMessage[]>([]);
  const currentContentRef = useRef<string>('');  // 用于累积 agent/content 事件的内容
  const currentAudioMessageRef = useRef<AgentMessage | null>(null);  // 当前正在播放的 audio message
  const wsRef = useRef<WebSocket | null>(null);  // WebSocket 引用，用于发送 message complete 事件
  const processedMessageIdsRef = useRef<Set<string>>(new Set());  // 已处理的消息ID，避免重复
  const previewMessageIndexRef = useRef<number>(-1);  // 当前预览消息的索引（用于 agent/content）

  // 初始化音频播放器
  const initAudio = () => {
    if (currentAudioContextRef.current && currentAudioContextRef.current.state !== 'closed') {
      return;
    }
    
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate });
    currentAudioContextRef.current = ctx;
    setAudioContext(ctx);
    audioEnabledRef.current = false;
    setStatus('已就绪（需要启用音频）');
  };

  const playAudioChunk = (base64Data: string) => {
    console.log('[音频播放器] playAudioChunk 被调用:', {
      hasContext: !!currentAudioContextRef.current,
      contextState: currentAudioContextRef.current?.state,
      audioEnabled: audioEnabledRef.current,
      isPlaying: isPlayingRef.current,
      base64Length: base64Data?.length || 0,
      queueLength: audioQueueRef.current.length,
    });

    if (!currentAudioContextRef.current || !base64Data || base64Data.length === 0) {
      console.warn('[音频播放器] 跳过音频分片: 缺少 AudioContext 或数据为空');
      return;
    }

    try {
      // 解码 base64
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // 确保字节数是偶数（PCM16需要2字节对齐）
      const alignedLength = bytes.length - (bytes.length % 2);
      if (alignedLength === 0) {
        console.warn('[音频播放器] 跳过音频分片: 对齐后长度为 0');
        return;
      }
      const alignedBytes = bytes.slice(0, alignedLength);

      // 转换为 Int16Array (PCM16, 小端序)
      const pcmData = new Int16Array(alignedBytes.buffer, alignedBytes.byteOffset, alignedBytes.length / 2);
      
      // 转换为 Float32Array (-1.0 到 1.0)
      const floatData = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        floatData[i] = pcmData[i] / 32768.0;
      }

      console.log('[音频播放器] 音频分片处理完成:', {
        originalBytes: bytes.length,
        alignedBytes: alignedBytes.length,
        pcmSamples: pcmData.length,
        floatSamples: floatData.length,
        duration: (floatData.length / sampleRate).toFixed(3) + 's',
      });

      setChunksReceived((prev) => prev + 1);
      setBytesReceived((prev) => prev + alignedBytes.length);

      // 添加到队列
      audioQueueRef.current.push(floatData);
      console.log('[音频播放器] 音频分片已添加到队列，队列长度:', audioQueueRef.current.length);

      // 如果还没开始播放且音频已启用，立即开始
      if (!isPlayingRef.current && audioEnabledRef.current) {
        console.log('[音频播放器] 开始播放音频');
        startPlayback();
      } else if (!audioEnabledRef.current) {
        console.warn('[音频播放器] 音频未启用，无法播放');
      } else if (isPlayingRef.current) {
        console.log('[音频播放器] 正在播放中，音频分片已加入队列');
      }
    } catch (err) {
      console.error('[音频播放器] 处理音频分片失败:', err);
    }
  };

  const startPlayback = () => {
    console.log('[音频播放器] startPlayback 被调用:', {
      hasContext: !!currentAudioContextRef.current,
      contextState: currentAudioContextRef.current?.state,
      queueLength: audioQueueRef.current.length,
      isPlaying: isPlayingRef.current,
      audioEnabled: audioEnabledRef.current,
    });

    if (!currentAudioContextRef.current || audioQueueRef.current.length === 0 || isPlayingRef.current) {
      console.warn('[音频播放器] 无法开始播放:', {
        noContext: !currentAudioContextRef.current,
        emptyQueue: audioQueueRef.current.length === 0,
        alreadyPlaying: isPlayingRef.current,
      });
      return;
    }
    if (currentAudioContextRef.current.state === 'suspended' || !audioEnabledRef.current) {
      console.warn('[音频播放器] AudioContext 已暂停或音频未启用:', {
        state: currentAudioContextRef.current.state,
        audioEnabled: audioEnabledRef.current,
      });
      return;
    }
    if (currentAudioContextRef.current.state === 'closed') {
      console.warn('[音频播放器] AudioContext 已关闭，重新初始化');
      initAudio();
      return;
    }

    console.log('[音频播放器] 开始播放音频，队列长度:', audioQueueRef.current.length);
    isPlayingRef.current = true;
    setIsPlaying(true);
    setStatus('正在播放');

    const playNext = () => {
      if (!currentAudioContextRef.current || currentAudioContextRef.current.state === 'closed' || currentAudioContextRef.current.state === 'suspended') {
        isPlayingRef.current = false;
        setIsPlaying(false);
        return;
      }

      if (audioQueueRef.current.length === 0) {
        setTimeout(playNext, 50);
        return;
      }

      const chunk = audioQueueRef.current.shift();
      if (!chunk || chunk.length === 0) {
        setTimeout(playNext, 0);
        return;
      }

      // 创建 AudioBuffer
      const buffer = currentAudioContextRef.current.createBuffer(1, chunk.length, sampleRate);
      buffer.getChannelData(0).set(chunk);

      // 创建并播放
      const source = currentAudioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(currentAudioContextRef.current.destination);

      source.onended = () => {
        setTimeout(() => {
          const dataSentComplete = (window as any).audioDataSentComplete === true;
          if (audioQueueRef.current.length === 0 && dataSentComplete && isPlayingRef.current) {
            isPlayingRef.current = false;
            setIsPlaying(false);
            setStatus('播放完成');
            (window as any).audioDataSentComplete = false;
            
            // 新协议：播放完成后发送 tts/playback_completed 事件
            sendTtsPlaybackCompleted();
            
            // 旧协议兼容：如果当前有 audio message 正在播放，发送完成事件
            if (currentAudioMessageRef.current && currentAudioMessageRef.current.type === 'audio') {
              sendMessageComplete(currentAudioMessageRef.current.messageId);
              currentAudioMessageRef.current.status = 'completed';
              currentAudioMessageRef.current.endTime = Date.now();
              // 清除当前 audio message，为下一个消息做准备
              currentAudioMessageRef.current = null;
            }
            
            return;
          }
          playNext();
        }, 0);
      };

      try {
        source.start(0);
      } catch (err) {
        console.error('[音频播放器] 播放分片失败:', err);
        isPlayingRef.current = false;
        setIsPlaying(false);
        setTimeout(playNext, 0);
      }
    };

    playNext();
  };

  // 新协议：发送 TTS 播放完成事件
  const sendTtsPlaybackCompleted = () => {
    const currentWs = wsRef.current;
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      const message = {
        key: 'publish',
        event: 'tts/playback_completed',
        payload: [],
      };
      currentWs.send(JSON.stringify(message));
      console.log('[新协议] 发送 TTS 播放完成事件: tts/playback_completed');
    } else {
      console.warn('[新协议] WebSocket 未连接，无法发送 TTS 播放完成事件');
    }
  };

  // 旧协议：发送 message complete 事件（向后兼容）
  const sendMessageComplete = (messageId: string) => {
    const currentWs = wsRef.current;
    if (currentWs && currentWs.readyState === WebSocket.OPEN) {
      const message = {
        key: 'publish',
        event: 'client/agent/message/complete',
        payload: [{ messageId }],
      };
      currentWs.send(JSON.stringify(message));
      console.log('[旧协议] 发送 message complete:', messageId);
    } else {
      console.warn('[旧协议] WebSocket 未连接，无法发送 message complete');
    }
  };

  // 格式化时间戳
  const formatTimestamp = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };

  // 新协议：处理 agent/message 事件
  const handleAgentMessage = (message: AgentMessage) => {
    console.log('[新协议] 收到 agent/message:', message);
    
    // 检查是否已处理过（避免重复）- 只有当 messageId 存在时才检查
    if (message.messageId && processedMessageIdsRef.current.has(message.messageId)) {
      console.log('[新协议] 消息已处理过，跳过:', message.messageId);
      return;
    }
    
    if (message.type === 'audio') {
      // Audio message：每个 audio message 创建一条新的独立消息
      const audioMessage: AgentMessage = {
        ...message,
        status: 'pending',
        startTime: Date.now(),
      };
      
      // 清除预览消息（如果有），并创建正式消息
      setMessages((prev) => {
        const newMessages = [...prev];
        let finalContent = message.content || '';
        
        // 如果有预览消息，使用预览消息的内容（如果 agent/message 没有 content）
        if (previewMessageIndexRef.current >= 0) {
          const previewIndex = previewMessageIndexRef.current;
          if (previewIndex >= 0 && previewIndex < newMessages.length) {
            const previewMsg = newMessages[previewIndex];
            if (previewMsg.role === 'assistant' && !previewMsg.hasAudio) {
              // 如果 agent/message 没有 content，使用预览消息的内容
              if (!finalContent && previewMsg.content) {
                finalContent = previewMsg.content;
                console.log('[新协议] 使用预览消息的内容:', finalContent.substring(0, 50));
              }
              // 删除预览消息
              newMessages.splice(previewIndex, 1);
              console.log('[新协议] 删除预览消息，索引:', previewIndex);
            }
          }
          previewMessageIndexRef.current = -1;
        }
        
        // 确保有内容才创建消息
        if (!finalContent) {
          console.warn('[新协议] agent/message 没有 content，且没有预览消息内容，跳过创建消息');
          return newMessages;
        }
        
        // 创建新的正式消息
        const newMessage: Message = {
          role: 'assistant',
          content: finalContent,
          timestamp: new Date(),
          hasAudio: true,  // 标记有音频
        };
        
        console.log('[新协议] 创建新的正式消息，内容长度:', finalContent.length);
        return [...newMessages, newMessage];
      });
      
      // 标记为已处理（如果 messageId 存在）
      if (message.messageId) {
        processedMessageIdsRef.current.add(message.messageId);
      }
      
      // 保存当前 audio message 引用，等待 TTS 播放
      currentAudioMessageRef.current = audioMessage;
      audioMessage.status = 'pending';  // 等待 tts/audio 事件
      
      console.log('[新协议] Audio message 已创建新消息，等待 TTS 音频...', message.messageId || 'no-id');
      
    } else if (message.type === 'toolcall') {
      // Toolcall message：显示为独立的 Tool 消息
      const toolMessage: AgentMessage = {
        ...message,
        status: 'completed',
        startTime: Date.now(),
        endTime: Date.now(),
      };
      
      // 从 toolResult 中提取响应时间（如果有）
      let responseTime = 0;
      if (message.toolResult && typeof message.toolResult === 'object') {
        // 尝试从 toolResult 中获取响应时间
        responseTime = message.toolResult.responseTime || message.toolResult.duration || 0;
      }
      
      // 如果没有从 toolResult 中获取到，使用默认值或计算值
      if (!responseTime && toolMessage.endTime && toolMessage.startTime) {
        responseTime = toolMessage.endTime - toolMessage.startTime;
      }
      
      // 添加独立的 Tool 消息
      setMessages((prev) => [...prev, {
        role: 'tool',
        content: `✓ Tool call successful: ${message.toolName || 'unknown'}`,
        timestamp: new Date(),
        toolName: message.toolName,
        toolResult: message.toolResult,
        responseTime: responseTime > 0 ? responseTime : undefined,
      }]);
      
      console.log('[新协议] 工具调用:', message.toolName, message.toolResult);
    }
    
    // 添加到消息队列
    messageQueueRef.current.push(message);
  };

  // 初始化 WebSocket 连接（用于接收消息和音频）
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 在开发模式下，直接连接到后端服务器（避免 webpack-dev-server 代理问题）
    // 在生产模式下，使用 window.location.host
    const isDev = window.location.hostname === 'localhost' && window.location.port === '8082';
    const host = isDev ? 'localhost:5283' : window.location.host;
    const wsUrl = `${protocol}//${host}/client-ws`;
    
    const newWs = new WebSocket(wsUrl);
    
    // 保存 ws 引用
    wsRef.current = newWs;
    
    newWs.onopen = () => {
      console.log('[对话] WebSocket 已连接');
      newWs.send(JSON.stringify({ type: 'ready' }));
      initAudio();
      
      // 尝试自动启用音频（可能需要用户交互）
      setTimeout(() => {
        if (currentAudioContextRef.current) {
          currentAudioContextRef.current.resume().then(() => {
            audioEnabledRef.current = true;
            setAudioEnabled(true);
            setStatus('已就绪');
            
            if (audioQueueRef.current.length > 0 && !isPlayingRef.current) {
              startPlayback();
            }
          }).catch((err) => {
            console.error('[音频播放器] 自动恢复 AudioContext 失败，需要用户交互:', err);
            setStatus('需要启用音频');
          });
        }
      }, 100);
    };
    
    newWs.onmessage = (wsEvent) => {
      try {
        const msg = JSON.parse(wsEvent.data);
        console.log('[前端] 收到 WebSocket 消息:', msg);
        
        // 处理事件格式消息（新协议）
        // 支持两种格式：
        // 1. { key: 'publish', event: 'tts/audio', payload: [...] }
        // 2. { event: 'tts/audio', payload: [...] }
        const eventName = msg.key === 'publish' ? msg.event : (msg.event ? msg.event : null);
        const payload = msg.payload;
        
        if (eventName) {
          console.log('[前端] 处理事件:', eventName, 'payload:', payload);
          
          // 处理 TTS 音频数据
          if (eventName === 'tts/audio') {
            const [audioData] = payload || [];
            console.log('[前端] TTS 音频数据:', {
              hasAudio: !!audioData?.audio,
              audioLength: audioData?.audio?.length || 0,
              audioPreview: audioData?.audio?.substring(0, 50) || 'N/A',
            });
            if (audioData?.audio) {
              console.log('[前端] 收到 TTS 音频数据，base64 长度:', audioData.audio.length, '字节');
              
              // 新协议：如果当前有 audio message 在等待，标记为播放中
              if (currentAudioMessageRef.current && currentAudioMessageRef.current.status === 'pending') {
                currentAudioMessageRef.current.status = 'playing';
                console.log('[新协议] Audio message 开始播放 TTS:', currentAudioMessageRef.current.messageId);
              }
              
              playAudioChunk(audioData.audio);
            } else {
              console.warn('[前端] TTS 音频数据格式错误:', audioData);
            }
          } else if (eventName === 'tts/done') {
            console.log('[前端] TTS 音频生成完成');
            (window as any).audioDataSentComplete = true;
            
            // 旧协议兼容：如果当前有 audio message 在播放，等待播放完成后再发送 complete
            // 播放完成事件会在 startPlayback 的 onended 回调中发送
          }
          // 新协议：等待 TTS 播放事件（服务器通知客户端开始播放）
          else if (eventName === 'agent/wait_tts_playback') {
            console.log('[新协议] 收到 agent/wait_tts_playback，开始播放音频');
            // 如果音频队列中有数据且未开始播放，立即开始播放
            if (audioQueueRef.current.length > 0 && !isPlayingRef.current && audioEnabledRef.current) {
              console.log('[新协议] 开始播放音频队列，队列长度:', audioQueueRef.current.length);
              startPlayback();
            } else if (!audioEnabledRef.current) {
              console.warn('[新协议] 音频未启用，无法播放');
            } else if (isPlayingRef.current) {
              console.log('[新协议] 音频已在播放中');
            } else if (audioQueueRef.current.length === 0) {
              console.warn('[新协议] 音频队列为空，等待音频数据');
            }
          }
          // 新协议：核心 message 事件
          else if (eventName === 'agent/message') {
            const [message] = payload || [];
            if (message) {
              console.log('[前端] 收到 agent/message 事件，完整消息:', JSON.stringify(message, null, 2));
              handleAgentMessage(message);
            } else {
              console.warn('[前端] agent/message 事件 payload 为空');
            }
          }
          // 新协议：消息级别事件
          else if (eventName === 'agent/message/start') {
            console.log('[新协议] 消息开始（整个对话轮次开始）');
            // 可以在这里重置状态或显示加载状态
          } else if (eventName === 'agent/message/end') {
            console.log('[新协议] 消息结束（整个对话轮次结束）');
            // 可以在这里清理状态
          }
          // 新协议：内容输出阶段事件（仅用于实时预览，不创建最终消息）
          else if (eventName === 'agent/content/start') {
            console.log('[新协议] 内容输出开始（寒暄阶段开始）');
            currentContentRef.current = '';  // 重置内容累积
            // 创建预览消息用于实时显示（临时消息，会被 agent/message 替换）
            setMessages((prev) => {
              const newMessage: Message = {
                role: 'assistant',
                content: '',
                timestamp: new Date(),
                hasAudio: false,  // 预览消息，没有音频
              };
              previewMessageIndexRef.current = prev.length;  // 记录预览消息索引
              return [...prev, newMessage];
            });
          } else if (eventName === 'agent/content') {
            // 新协议：内容流式输出（寒暄内容）- 仅用于实时预览
            const [content] = payload || [];
            if (content && typeof content === 'string') {
              // 累积内容
              currentContentRef.current += content;
              console.log('[新协议] 内容流式更新（预览）:', currentContentRef.current.substring(0, 50) + '...');
              
              // 更新预览消息（如果存在）
              if (previewMessageIndexRef.current >= 0) {
                setMessages((prev) => {
                  const newMessages = [...prev];
                  const previewIndex = previewMessageIndexRef.current;
                  if (previewIndex >= 0 && previewIndex < newMessages.length) {
                    const previewMsg = newMessages[previewIndex];
                    if (previewMsg.role === 'assistant' && !previewMsg.hasAudio) {
                      newMessages[previewIndex] = {
                        ...previewMsg,
                        content: currentContentRef.current,
                      };
                      return newMessages;
                    }
                  }
                  // 如果预览消息索引无效，创建新消息
                  console.log('[新协议] 预览消息索引无效，创建新消息');
                  previewMessageIndexRef.current = newMessages.length;
                  return [...newMessages, {
                    role: 'assistant',
                    content: currentContentRef.current,
                    timestamp: new Date(),
                    hasAudio: false,
                  }];
                });
              } else {
                // 如果没有预览消息，创建一个（可能没有收到 content/start）
                console.log('[新协议] 没有预览消息，创建新预览消息');
                setMessages((prev) => {
                  const newMessage: Message = {
                    role: 'assistant',
                    content: currentContentRef.current,
                    timestamp: new Date(),
                    hasAudio: false,
                  };
                  previewMessageIndexRef.current = prev.length;
                  return [...prev, newMessage];
                });
              }
            }
          } else if (eventName === 'agent/content/end') {
            const [contentData] = payload || [];
            const content = typeof contentData === 'string' ? contentData : contentData?.content;
            console.log('[新协议] 内容输出结束（寒暄阶段结束）:', content?.substring(0, 50) || 'N/A');
            // 内容输出结束，更新预览消息的最终内容（等待 agent/message 创建正式消息）
            if (content) {
              currentContentRef.current = content;
              if (previewMessageIndexRef.current >= 0) {
                setMessages((prev) => {
                  const newMessages = [...prev];
                  const previewIndex = previewMessageIndexRef.current;
                  if (previewIndex >= 0 && previewIndex < newMessages.length) {
                    const previewMsg = newMessages[previewIndex];
                    if (previewMsg.role === 'assistant' && !previewMsg.hasAudio) {
                      newMessages[previewIndex] = {
                        ...previewMsg,
                        content: content,
                      };
                    }
                  }
                  return newMessages;
                });
              } else {
                // 如果没有预览消息，但收到了 content/end，创建一个消息（可能没有 agent/message）
                console.log('[新协议] 没有预览消息，但收到 content/end，创建消息');
                setMessages((prev) => [...prev, {
                  role: 'assistant',
                  content: content,
                  timestamp: new Date(),
                  hasAudio: false,  // 没有收到 agent/message，所以没有音频
                }]);
              }
            }
          } else if (eventName === 'client/agent/content_start' || eventName === 'agent/content_start') {
            // AI 开始输出内容，创建新消息
            setMessages((prev) => {
              // 如果最后一条消息已经是 assistant 的且内容为空，复用它
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.content) {
                return prev;
              }
              // 否则创建新消息
              return [...prev, {
                role: 'assistant',
                content: '',
                timestamp: new Date(),
              }];
            });
          } else if (eventName === 'client/agent/content') {
            // 向后兼容旧格式：流式文本更新（增量内容）
            const [content] = payload || [];
            if (content && typeof content === 'string') {
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastMsg = newMessages[newMessages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                  return [
                    ...newMessages.slice(0, -1),
                    {
                      ...lastMsg,
                      content: lastMsg.content + content,
                    },
                  ];
                }
                return [...newMessages, {
                  role: 'assistant',
                  content: content,
                  timestamp: new Date(),
                  hasAudio: false,  // 初始时没有音频，等待 agent/message 事件
                }];
              });
            }
          } else if (eventName === 'client/agent/content_complete' || eventName === 'agent/content_complete') {
            // 向后兼容旧格式：内容输出完成
            console.log('[前端] Agent 内容输出完成（旧格式）');
          }
          // 新协议：工具调用阶段事件
          else if (eventName === 'agent/tool_call/start') {
            const [toolData] = payload || [];
            const toolName = typeof toolData === 'string' ? toolData : toolData?.toolName;
            console.log('[新协议] 工具调用开始:', toolName || 'N/A');
            // 可以显示工具调用状态
          } else if (eventName === 'agent/tool_call/end') {
            const [toolData] = payload || [];
            const toolName = typeof toolData === 'string' ? toolData : toolData?.toolName;
            console.log('[新协议] 工具调用结束:', toolName || 'N/A');
          } else if (eventName === 'asr/result') {
            // ASR 识别结果
            const [result] = payload || [];
            if (result?.text) {
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastMsg = newMessages[newMessages.length - 1];
                if (lastMsg && lastMsg.role === 'user') {
                  lastMsg.content = result.text;
                  return [...newMessages];
                }
                return [...newMessages, {
                  role: 'user',
                  content: result.text,
                  timestamp: new Date(),
                }];
              });
            }
          }
        }
        // 处理旧格式消息（向后兼容）
        else if (msg.key === 'voice_chat') {
          if (msg.result) {
            const { text, aiResponse } = msg.result;
            
            if (text && aiResponse) {
              // 添加用户消息
              setMessages((prev) => [...prev, {
                role: 'user',
                content: text,
                timestamp: new Date(),
              }]);
              
              // 添加 AI 回复
              setMessages((prev) => [...prev, {
                role: 'assistant',
                content: aiResponse,
                timestamp: new Date(),
                hasAudio: false,  // 旧格式消息，默认没有音频
              }]);
            }
          }
        } else if (msg.key === 'voice_chat_text') {
          // 流式文本更新
          const { fullText } = msg;
          setMessages((prev) => {
            const newMessages = [...prev];
            const lastMsg = newMessages[newMessages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              lastMsg.content = fullText;
              return [...newMessages];
            }
            return [...newMessages, {
              role: 'assistant',
              content: fullText,
              timestamp: new Date(),
              hasAudio: false,  // 旧格式消息，默认没有音频
            }];
          });
        } else if (msg.type === 'tts/audio' && msg.audio) {
          // 旧格式 TTS 音频
          playAudioChunk(msg.audio);
        } else if (msg.type === 'done') {
          (window as any).audioDataSentComplete = true;
        }
      } catch (e) {
        console.error('[对话] 解析消息失败:', e);
      }
    };
    
    newWs.onerror = (error) => {
      console.error('[对话] WebSocket 错误:', error);
    };
    
    newWs.onclose = () => {
      console.log('[对话] WebSocket 已断开');
      setStatus('已断开');
    };
    
    setWs(newWs);
    
    return () => {
      newWs.close();
      wsRef.current = null;
      if (currentAudioContextRef.current) {
        currentAudioContextRef.current.close();
      }
    };
  }, []);



  // 手动启用音频
  const handleEnableAudio = async () => {
    if (!currentAudioContextRef.current) {
      initAudio();
    }
    
    if (currentAudioContextRef.current) {
      try {
        await currentAudioContextRef.current.resume();
        audioEnabledRef.current = true;
        setAudioEnabled(true);
        setStatus('已就绪');
        
        if (audioQueueRef.current.length > 0 && !isPlayingRef.current) {
          startPlayback();
        }
      } catch (err) {
        console.error('[音频播放器] 启用音频失败:', err);
        setStatus('启用音频失败');
      }
    }
  };

  // 发送消息
  const handleSendMessage = () => {
    if (!inputValue.trim() || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    
    const messageText = inputValue.trim();
    
    // 添加用户消息到界面
    setMessages((prev) => [...prev, {
      role: 'user',
      content: messageText,
      timestamp: new Date(),
    }]);
    
    // 发送消息到服务器
    const message = {
      key: 'publish',
      event: 'client/agent/chat',
      payload: [{
        message: messageText,
        history: messages.map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        })),
      }],
    };
    
    ws.send(JSON.stringify(message));
    console.log('[前端] 发送消息:', messageText);
    
    // 清空输入框
    setInputValue('');
  };

  // 处理回车键发送
  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // 自动滚动到底部
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <Stack gap="md" style={{ height: 'calc(100vh - 150px)' }}>
      <Group justify="space-between">
        <Title order={2}>音频播放器</Title>
        <Group gap="xs">
          <Badge color={ws?.readyState === WebSocket.OPEN ? 'green' : 'red'}>
            {status}
          </Badge>
          {isPlaying && <Badge color="orange">播放中</Badge>}
          {chunksReceived > 0 && (
            <Badge variant="light">
              {chunksReceived} 块 / {(bytesReceived / 1024).toFixed(1)} KB
            </Badge>
          )}
          {!audioEnabled && (
            <Button
              size="xs"
              leftSection={audioEnabled ? <IconVolume size={16} /> : <IconVolumeOff size={16} />}
              onClick={handleEnableAudio}
              variant="light"
            >
              启用音频
            </Button>
          )}
        </Group>
      </Group>
      
      <Card withBorder style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <ScrollArea style={{ flex: 1 }} viewportRef={scrollAreaRef}>
          <Stack gap="md" p="md">
            {messages.length === 0 ? (
              <Text c="dimmed" ta="center" py="xl">
                等待音频数据...
              </Text>
            ) : (
              messages.map((msg, index) => {
                // 根据消息类型显示不同的样式
                if (msg.role === 'tool') {
                  // Tool 消息：显示工具调用结果
                  return (
                    <Paper
                      key={index}
                      p="md"
                      withBorder
                      style={{
                        alignSelf: 'flex-start',
                        maxWidth: '70%',
                        backgroundColor: 'var(--mantine-color-gray-1)',
                      }}
                    >
                      <Group justify="space-between" mb={4}>
                        <Text size="sm" fw={500}>Tool</Text>
                        <Text size="xs" c="dimmed">{formatTimestamp(msg.timestamp)}</Text>
                      </Group>
                      <Text size="sm" mb={4}>{msg.content}</Text>
                      {msg.toolName && (
                        <Group gap="xs" mt="xs">
                          <Badge variant="light" size="sm">{msg.toolName}</Badge>
                          {msg.responseTime !== undefined && (
                            <Text size="xs" c="dimmed">Response Time: {msg.responseTime}ms</Text>
                          )}
                        </Group>
                      )}
                      {msg.toolResult && (
                        <Text size="xs" c="dimmed" mt="xs" style={{ fontStyle: 'italic' }}>
                          View result
                        </Text>
                      )}
                    </Paper>
                  );
                } else {
                  // User 或 Assistant 消息
                  const isUser = msg.role === 'user';
                  return (
                    <Paper
                      key={index}
                      p="md"
                      withBorder
                      style={{
                        alignSelf: isUser ? 'flex-end' : 'flex-start',
                        maxWidth: '70%',
                        backgroundColor: isUser 
                          ? 'var(--mantine-color-blue-0)' 
                          : 'var(--mantine-color-gray-0)',
                      }}
                    >
                      <Group justify="space-between" mb={4}>
                        <Text size="sm" fw={500}>{isUser ? '你' : 'AI'}</Text>
                        <Text size="xs" c="dimmed">{formatTimestamp(msg.timestamp)}</Text>
                      </Group>
                      <Text mb={msg.hasAudio ? 'xs' : 0}>{msg.content}</Text>
                      {msg.hasAudio && !isUser && (
                        <Group gap="xs" mt="xs" pt="xs" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
                          <Text size="xs" c="dimmed">Content generated by AI (qwen)</Text>
                          <Group gap={4} ml="auto">
                            <Tooltip label="播放/暂停">
                              <ActionIcon 
                                size="sm" 
                                variant="subtle"
                                onClick={() => {
                                  // TODO: 实现播放/暂停功能
                                  console.log('播放/暂停音频');
                                }}
                              >
                                {isPlaying ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
                              </ActionIcon>
                            </Tooltip>
                            <Tooltip label="下载">
                              <ActionIcon 
                                size="sm" 
                                variant="subtle"
                                onClick={() => {
                                  // TODO: 实现下载功能
                                  console.log('下载音频');
                                }}
                              >
                                <IconDownload size={14} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        </Group>
                      )}
                    </Paper>
                  );
                }
              })
            )}
          </Stack>
        </ScrollArea>
        
        {/* 消息输入框 */}
        <Group gap="xs" p="md" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
          <TextInput
            placeholder="输入消息..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            style={{ flex: 1 }}
            disabled={!ws || ws.readyState !== WebSocket.OPEN}
          />
          <ActionIcon
            size="lg"
            variant="filled"
            onClick={handleSendMessage}
            disabled={!inputValue.trim() || !ws || ws.readyState !== WebSocket.OPEN}
          >
            <IconSend size={18} />
          </ActionIcon>
        </Group>
      </Card>
    </Stack>
  );
}

