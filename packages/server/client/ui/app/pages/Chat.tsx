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
} from '@mantine/core';
import { IconVolume, IconVolumeOff } from '@tabler/icons-react';
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
  const currentAudioContextRef = useRef<AudioContext | null>(null);
  const sampleRate = 24000;

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

  // 初始化 WebSocket 连接（用于接收消息和音频）
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // 在开发模式下，直接连接到后端服务器（避免 webpack-dev-server 代理问题）
    // 在生产模式下，使用 window.location.host
    const isDev = window.location.hostname === 'localhost' && window.location.port === '8082';
    const host = isDev ? 'localhost:5283' : window.location.host;
    const wsUrl = `${protocol}//${host}/client-ws`;
    
    const newWs = new WebSocket(wsUrl);
    
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
              playAudioChunk(audioData.audio);
            } else {
              console.warn('[前端] TTS 音频数据格式错误:', audioData);
            }
          } else if (eventName === 'tts/done') {
            console.log('[前端] TTS 音频生成完成');
            (window as any).audioDataSentComplete = true;
          } else if (eventName === 'agent/content') {
            // 流式文本更新
            const [content] = payload || [];
            if (content) {
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastMsg = newMessages[newMessages.length - 1];
                if (lastMsg && lastMsg.role === 'assistant') {
                  lastMsg.content = lastMsg.content + content;
                  return [...newMessages];
                }
                return [...newMessages, {
                  role: 'assistant',
                  content: content,
                  timestamp: new Date(),
                }];
              });
            }
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

