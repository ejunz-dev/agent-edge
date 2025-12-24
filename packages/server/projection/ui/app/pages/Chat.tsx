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
} from '@mantine/core';
import { IconVolume, IconVolumeOff, IconPlayerPlay, IconPlayerPause } from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';
import { useProjectionMessage, useProjectionWebSocket } from '../hooks/useProjectionWebSocket';

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
  toolName?: string;
  toolResult?: any;
  hasAudio?: boolean;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const { connected } = useProjectionWebSocket();
  const status = connected ? '已连接' : '连接断开';
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const audioEnabledRef = useRef(false);
  const currentAudioContextRef = useRef<AudioContext | null>(null);
  const sampleRate = 24000;
  const currentContentRef = useRef<string>('');
  const previewMessageIndexRef = useRef<number>(-1);

  // 初始化音频播放器
  const initAudio = () => {
    if (currentAudioContextRef.current && currentAudioContextRef.current.state !== 'closed') {
      return;
    }
    
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate });
    currentAudioContextRef.current = ctx;
    setAudioContext(ctx);
    audioEnabledRef.current = false;
  };

  const playAudioChunk = (base64Data: string) => {
    if (!currentAudioContextRef.current || !base64Data || base64Data.length === 0) {
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

      // 添加到队列
      audioQueueRef.current.push(floatData);

      // 如果还没开始播放且音频已启用，立即开始
      if (!isPlayingRef.current && audioEnabledRef.current) {
        startPlayback();
      }
    } catch (err) {
      console.error('[音频播放器] 处理音频分片失败:', err);
    }
  };

  const startPlayback = () => {
    if (isPlayingRef.current) return;
    if (!audioEnabledRef.current) return;
    if (!currentAudioContextRef.current) return;
    if (audioQueueRef.current.length === 0) return;

    isPlayingRef.current = true;
    setIsPlaying(true);

    const playNext = () => {
      if (audioQueueRef.current.length === 0) {
    isPlayingRef.current = false;
    setIsPlaying(false);
        return;
      }

      const chunk = audioQueueRef.current.shift();
      if (!chunk || !currentAudioContextRef.current) {
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
        setTimeout(playNext, 0);
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

  // 使用共享的 WebSocket 连接
  useEffect(() => {
    if (connected) {
      initAudio();
    }
  }, [connected]);

  // 监听 TTS 音频
  useProjectionMessage('tts/audio', (data: any) => {
    const audioData = data;
    if (audioData?.chunk) {
      playAudioChunk(audioData.chunk);
    } else if (audioData?.base64) {
      playAudioChunk(audioData.base64);
    } else if (audioData?.audio) {
      // 兼容 client 模式的格式
      playAudioChunk(audioData.audio);
    }
  });

  // 监听 agent/content/start - 内容开始
  useProjectionMessage('agent/content/start', () => {
    console.log('[Chat] 内容输出开始');
    currentContentRef.current = '';
    // 创建预览消息用于实时显示
    setMessages((prev) => {
      const newMessage: Message = {
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        hasAudio: false,
      };
      previewMessageIndexRef.current = prev.length;
      return [...prev, newMessage];
    });
  });

  // 监听 agent/content - 流式内容更新
  useProjectionMessage('agent/content', (data: any) => {
    const contentData = data;
    let newChunk = '';
    
    if (typeof contentData === 'string') {
      newChunk = contentData;
    } else if (contentData?.content) {
      newChunk = contentData.content;
    } else if (contentData?.chunk) {
      newChunk = contentData.chunk;
    }
    
    if (newChunk) {
      // 累积内容
      currentContentRef.current += newChunk;
      
      // 更新预览消息
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
          return newMessages;
        });
      }
    }
  });

  // 监听 agent/content/end - 内容结束
  useProjectionMessage('agent/content/end', () => {
    console.log('[Chat] 内容输出结束');
    // 预览消息会在 agent/message 时被替换
  });

  // 监听 agent/message - 最终消息（包含完整内容和音频标记）
  useProjectionMessage('agent/message', (data: any) => {
    const message = data;
    if (message?.content) {
      const finalContent = typeof message.content === 'string' 
        ? message.content 
        : message.content.text || currentContentRef.current;
      
      // 如果有预览消息，替换它；否则创建新消息
      if (previewMessageIndexRef.current >= 0) {
        setMessages((prev) => {
          const newMessages = [...prev];
          const previewIndex = previewMessageIndexRef.current;
          if (previewIndex >= 0 && previewIndex < newMessages.length) {
            newMessages[previewIndex] = {
              role: 'assistant',
              content: finalContent,
              timestamp: new Date(),
              hasAudio: message.type === 'audio' || !!message.hasAudio,
            };
          }
          previewMessageIndexRef.current = -1;
          return newMessages;
        });
      } else {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: finalContent,
          timestamp: new Date(),
          hasAudio: message.type === 'audio' || !!message.hasAudio,
        }]);
      }
      
      currentContentRef.current = '';
    }
  });

  // 自动滚动到底部
  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  const toggleAudio = () => {
    if (!currentAudioContextRef.current) {
      initAudio();
      return;
    }

    if (audioEnabledRef.current) {
      audioEnabledRef.current = false;
      setAudioEnabled(false);
    } else {
      // 恢复 AudioContext（如果被暂停）
      if (currentAudioContextRef.current.state === 'suspended') {
        currentAudioContextRef.current.resume();
      }
      audioEnabledRef.current = true;
      setAudioEnabled(true);
      
      // 如果队列中有数据，立即开始播放
      if (audioQueueRef.current.length > 0 && !isPlayingRef.current) {
        startPlayback();
      }
    }
  };

  const formatTimestamp = (date: Date) => {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  };

  return (
    <Stack gap="md" style={{ height: '100%', maxHeight: '100vh' }}>
      <Group justify="space-between">
        <Title order={2}>Agent 对话</Title>
        <Group>
          <Badge color={connected ? 'green' : 'red'}>
            {status}
          </Badge>
          <Tooltip label={audioEnabled ? '禁用音频' : '启用音频'}>
            <ActionIcon
              variant="light"
              color={audioEnabled ? 'blue' : 'gray'}
              onClick={toggleAudio}
              disabled={!audioContext}
            >
              {audioEnabled ? <IconVolume size={18} /> : <IconVolumeOff size={18} />}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <Card 
        shadow="sm" 
        padding={0} 
        radius="md" 
        withBorder
        style={{ 
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <ScrollArea 
          style={{ 
            flex: 1,
            height: '100%',
          }}
          viewportRef={scrollAreaRef}
        >
          <Stack gap="xs" p="md">
            {messages.length === 0 ? (
              <Text c="dimmed" ta="center" py="xl">
                等待回合结束，Agent 将自动分析并回复...
              </Text>
            ) : (
              messages.map((msg, idx) => (
                <Paper
                  key={idx}
                  p="md"
                  radius="md"
                  style={{
                    width: '100%',
                    maxWidth: '100%',
                    backgroundColor: msg.role === 'assistant' 
                      ? 'rgba(37, 99, 235, 0.1)' 
                      : 'rgba(0, 0, 0, 0.05)',
                    border: `1px solid ${msg.role === 'assistant' ? 'rgba(37, 99, 235, 0.2)' : 'rgba(0, 0, 0, 0.1)'}`,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <Group justify="space-between" mb="xs" gap="xs">
                    <Badge size="sm" color={msg.role === 'assistant' ? 'blue' : 'gray'} variant="light">
                      {msg.role === 'assistant' ? 'Agent' : msg.role}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      {formatTimestamp(msg.timestamp)}
                    </Text>
                  </Group>
                  <Text 
                    size="md" 
                    style={{ 
                      width: '100%',
                      lineHeight: 1.6,
                      wordBreak: 'break-word',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'break-word',
                    }}
                  >
                    {msg.content}
                  </Text>
                  {msg.hasAudio && (
                    <Badge size="xs" color="green" variant="light" mt="xs" style={{ alignSelf: 'flex-start' }}>
                      有音频
                    </Badge>
                  )}
                </Paper>
              ))
            )}
          </Stack>
        </ScrollArea>
      </Card>
    </Stack>
  );
}

