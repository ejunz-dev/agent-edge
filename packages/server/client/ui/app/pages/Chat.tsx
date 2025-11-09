import {
  Badge,
  Card,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import React, { useEffect, useRef, useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [audioWs, setAudioWs] = useState<WebSocket | null>(null);
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null);
  const [status, setStatus] = useState('正在连接...');
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [chunksReceived, setChunksReceived] = useState(0);
  const [bytesReceived, setBytesReceived] = useState(0);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const audioEnabledRef = useRef(false);
  const sampleRate = 24000;

  // 初始化 WebSocket 连接（用于接收消息）
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/edge/conn`;
    
    const newWs = new WebSocket(wsUrl);
    
    newWs.onopen = () => {
      console.log('[对话] WebSocket 已连接');
      newWs.send(JSON.stringify({ type: 'ready' }));
    };
    
    newWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.key === 'voice_chat') {
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
            }];
          });
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
    };
    
    setWs(newWs);
    
    return () => {
      newWs.close();
    };
  }, []);

  // 初始化音频播放器（参考 audio-player.html）
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const audioWsUrl = `${protocol}//${window.location.host}/audio-ws`;
    
    const initAudio = () => {
      if (currentAudioContext && currentAudioContext.state !== 'closed') {
        return;
      }
      
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate });
      currentAudioContext = ctx;
      setAudioContext(ctx);
      audioEnabledRef.current = false;
      setStatus('已就绪（需要启用音频）');
    };

    const playAudioChunk = (base64Data: string) => {
      if (!currentAudioContext || !base64Data || base64Data.length === 0) return;

      try {
        // 解码 base64
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // 确保字节数是偶数（PCM16需要2字节对齐）
        const alignedLength = bytes.length - (bytes.length % 2);
        if (alignedLength === 0) return;
        const alignedBytes = bytes.slice(0, alignedLength);

        // 转换为 Int16Array (PCM16, 小端序)
        const pcmData = new Int16Array(alignedBytes.buffer, alignedBytes.byteOffset, alignedBytes.length / 2);
        
        // 转换为 Float32Array (-1.0 到 1.0)
        const floatData = new Float32Array(pcmData.length);
        for (let i = 0; i < pcmData.length; i++) {
          floatData[i] = pcmData[i] / 32768.0;
        }

        setChunksReceived((prev) => prev + 1);
        setBytesReceived((prev) => prev + alignedBytes.length);

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
      if (!currentAudioContext || audioQueueRef.current.length === 0 || isPlayingRef.current) return;
      if (currentAudioContext.state === 'suspended' || !audioEnabledRef.current) return;
      if (currentAudioContext.state === 'closed') {
        initAudio();
        return;
      }

      isPlayingRef.current = true;
      setIsPlaying(true);
      setStatus('正在播放');

      const playNext = () => {
        if (!currentAudioContext || currentAudioContext.state === 'closed' || currentAudioContext.state === 'suspended') {
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
        const buffer = currentAudioContext.createBuffer(1, chunk.length, sampleRate);
        buffer.getChannelData(0).set(chunk);

        // 创建并播放
        const source = currentAudioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(currentAudioContext.destination);

        source.onended = () => {
          setTimeout(() => {
            const dataSentComplete = (window as any).audioDataSentComplete === true;
            if (audioQueueRef.current.length === 0 && dataSentComplete && isPlayingRef.current) {
              isPlayingRef.current = false;
              setIsPlaying(false);
              setStatus('播放完成');
              if (audioWs && audioWs.readyState === WebSocket.OPEN) {
                try {
                  audioWs.send(JSON.stringify({ type: 'playback_complete' }));
                  (window as any).audioDataSentComplete = false;
                } catch (err) {
                  console.error('[音频播放器] 发送播放完成通知失败:', err);
                }
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


    const newAudioWs = new WebSocket(audioWsUrl);
    let currentAudioContext: AudioContext | null = null;
    
    newAudioWs.onopen = () => {
      console.log('[音频] WebSocket 已连接');
      setStatus('已连接');
      newAudioWs.send(JSON.stringify({ type: 'ready' }));
      initAudio();
      
      // 自动启用音频（用户已与页面交互）
      setTimeout(() => {
        // 使用闭包中的 currentAudioContext
        if (currentAudioContext) {
          currentAudioContext.resume().then(() => {
            audioEnabledRef.current = true;
            setAudioEnabled(true);
            setStatus('已就绪');
            
            if (audioQueueRef.current.length > 0 && !isPlayingRef.current) {
              startPlayback();
            }
          }).catch((err) => {
            console.error('[音频播放器] 恢复 AudioContext 失败:', err);
            setStatus('启用音频失败');
          });
        }
      }, 100);
    };
    
    newAudioWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'audio_chunk' && data.chunk) {
          playAudioChunk(data.chunk);
        } else if (data.type === 'done') {
          (window as any).audioDataSentComplete = true;
        }
      } catch (err) {
        // 如果不是 JSON，可能是 Blob
        if (event.data instanceof Blob) {
          // 处理 Blob 数据（如果需要）
        }
      }
    };

    newAudioWs.onerror = () => {
      setStatus('连接错误');
    };

    newAudioWs.onclose = () => {
      console.log('[音频] WebSocket 已断开');
      setStatus('已断开');
    };
    
    setAudioWs(newAudioWs);
    
    return () => {
      newAudioWs.close();
      if (audioContext) {
        audioContext.close();
      }
    };
  }, []);


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
          <Badge color={audioWs?.readyState === WebSocket.OPEN ? 'green' : 'red'}>
            {status}
          </Badge>
          {isPlaying && <Badge color="orange">播放中</Badge>}
          {chunksReceived > 0 && (
            <Badge variant="light">
              {chunksReceived} 块 / {(bytesReceived / 1024).toFixed(1)} KB
            </Badge>
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
              messages.map((msg, index) => (
                <Paper
                  key={index}
                  p="md"
                  withBorder
                  style={{
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '70%',
                    backgroundColor: msg.role === 'user' ? 'var(--mantine-color-blue-0)' : 'var(--mantine-color-gray-0)',
                  }}
                >
                  <Text size="sm" c="dimmed" mb={4}>
                    {msg.role === 'user' ? '你' : 'AI'}
                  </Text>
                  <Text>{msg.content}</Text>
                </Paper>
              ))
            )}
          </Stack>
        </ScrollArea>
      </Card>
    </Stack>
  );
}

