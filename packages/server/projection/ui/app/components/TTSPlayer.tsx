import { Box, Progress, Text, Group, Badge } from '@mantine/core';
import React, { useEffect, useRef, useState } from 'react';
import { useProjectionMessage } from '../hooks/useProjectionWebSocket';

const sampleRate = 24000; // 采样率

interface TTSPlayerProps {
  size?: 'sm' | 'md' | 'lg';
  showProgress?: boolean;
}

export default function TTSPlayer({ size = 'md', showProgress = true }: TTSPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<'idle' | 'playing' | 'finished'>('idle');
  const [isVisible, setIsVisible] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const audioEnabledRef = useRef(true);
  const totalSamplesRef = useRef(0);
  const playedSamplesRef = useRef(0);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const isReceivingRef = useRef(false);
  const lastChunkTimeRef = useRef<number | null>(null);
  const isVisibleRef = useRef(false); // 使用 ref 跟踪可见性状态

  // 初始化音频上下文
  useEffect(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate });
      audioContextRef.current = ctx;
    }
  }, []);

  // 清空所有音频状态（立即停止并清空）
  const clearAudioState = () => {
    console.log('[TTSPlayer] clearAudioState 被调用，isPlaying:', isPlayingRef.current, 'queueLength:', audioQueueRef.current.length);
    
    // 首先停止播放标志，这样 playNext 循环会退出
    isPlayingRef.current = false;
    setIsPlaying(false);
    
    // 立即停止当前播放的音频源
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
        currentSourceRef.current.disconnect();
      } catch (e) {
        // 忽略错误（可能已经停止）
        console.log('[TTSPlayer] 停止音频源时出错（可忽略）:', e);
      }
      currentSourceRef.current = null;
    }
    
    // 立即清空队列（防止 playNext 继续播放）
    const queueLength = audioQueueRef.current.length;
    audioQueueRef.current = [];
    console.log('[TTSPlayer] 已清空队列，之前有', queueLength, '个分片');
    
    // 重置采样计数
    totalSamplesRef.current = 0;
    playedSamplesRef.current = 0;
    
    // 重置接收状态
    isReceivingRef.current = false;
    lastChunkTimeRef.current = null;
    
    // 清除进度定时器
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    
    // 重置进度和状态
    setProgress(0);
    setStatus('idle');
  };

  // 播放音频分片
  const playAudioChunk = (base64Data: string) => {
    if (!audioContextRef.current || !base64Data || base64Data.length === 0) {
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
      totalSamplesRef.current += floatData.length;
      isReceivingRef.current = true;
      lastChunkTimeRef.current = Date.now();
      
      // 收到音频数据时显示组件
      if (!isVisibleRef.current) {
        isVisibleRef.current = true;
        setIsVisible(true);
        setStatus('playing');
        console.log('[TTSPlayer] 收到音频数据，显示组件');
      }

      // 如果还没开始播放且音频已启用，立即开始
      if (!isPlayingRef.current && audioEnabledRef.current) {
        startPlayback();
      }
    } catch (err) {
      console.error('[TTSPlayer] 处理音频分片失败:', err);
    }
  };

  // 开始播放
  const startPlayback = () => {
    if (isPlayingRef.current) return;
    if (!audioEnabledRef.current) return;
    if (!audioContextRef.current) return;
    if (audioQueueRef.current.length === 0) return;

    // 恢复 AudioContext（如果被暂停）
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }

    isPlayingRef.current = true;
    setIsPlaying(true);
    setStatus('playing');
    playedSamplesRef.current = 0;

    // 开始进度更新
    const updateProgress = () => {
      // 检查是否还在接收数据（如果超过 500ms 没收到新数据，认为接收完成）
      if (lastChunkTimeRef.current && Date.now() - lastChunkTimeRef.current > 500) {
        isReceivingRef.current = false;
      }

      if (totalSamplesRef.current > 0) {
        const baseProgress = (playedSamplesRef.current / totalSamplesRef.current) * 100;
        // 如果不再接收数据且队列为空，可以显示到 100%
        const currentProgress = (isReceivingRef.current || audioQueueRef.current.length > 0)
          ? Math.min(95, baseProgress) 
          : Math.min(100, baseProgress);
        setProgress(currentProgress);
      }
      
      if (isPlayingRef.current) {
        progressTimerRef.current = window.setTimeout(updateProgress, 100);
      } else {
        // 播放停止，确保进度显示为 100%
        if (totalSamplesRef.current > 0 && playedSamplesRef.current >= totalSamplesRef.current) {
          setProgress(100);
        }
      }
    };
    updateProgress();

    const playNext = () => {
      // 检查是否还在播放状态
      if (!isPlayingRef.current) {
        return;
      }
      
      if (audioQueueRef.current.length === 0) {
        // 队列为空，检查是否还在接收数据
        if (isReceivingRef.current) {
          // 还在接收数据，等待一段时间后继续
          setTimeout(() => {
            if (isPlayingRef.current) {
              playNext();
            }
          }, 200);
          return;
        }
        
         // 不再接收数据，但可能还有当前音频源在播放
         // 等待当前音频源播放完成（通过 onended 回调）
         // 如果当前没有音频源在播放，说明已经全部播放完成
         if (!currentSourceRef.current) {
           // 没有音频源在播放，再等待一小段时间确保真的播放完成
           setTimeout(() => {
             // 再次检查：确保队列仍然为空且没有音频源在播放
             if (!isPlayingRef.current) {
               return; // 已经被停止，不处理
             }
             
             if (audioQueueRef.current.length === 0 && !currentSourceRef.current && !isReceivingRef.current) {
               // 确实播放完成了
               const finalProgress = totalSamplesRef.current > 0 
                 ? ((playedSamplesRef.current / totalSamplesRef.current) * 100).toFixed(1)
                 : '0';
               console.log('[TTSPlayer] ✅ 播放完成！队列为空且没有音频源在播放，已播放:', playedSamplesRef.current, '/', totalSamplesRef.current, `(${finalProgress}%)`);
               isPlayingRef.current = false;
               setIsPlaying(false);
               setStatus('finished');
               setProgress(100);
               
               // 正常播放完成，重置计数
               totalSamplesRef.current = 0;
               playedSamplesRef.current = 0;
               
               // 通知服务器播放完成
               try {
                 // 通过全局 wsManager 发送播放完成事件
                 const manager = (window as any).__projectionWsManager;
                 if (manager && manager.ws && manager.ws.readyState === WebSocket.OPEN) {
                   manager.ws.send(JSON.stringify({
                     key: 'publish',
                     event: 'tts/playback_completed',
                     payload: []
                   }));
                   console.log('[TTSPlayer] ✅ 已通知服务器播放完成');
                 } else {
                   console.warn('[TTSPlayer] WebSocket 未连接，无法发送播放完成通知');
                 }
               } catch (e) {
                 console.error('[TTSPlayer] 发送播放完成通知失败:', e);
               }
               
               // 延迟后隐藏组件（给用户看到"播放完成"状态）
               setTimeout(() => {
                 // 再次检查是否还在播放状态（防止在延迟期间被新播放覆盖）
                 if (!isPlayingRef.current) {
                   isVisibleRef.current = false;
                   setIsVisible(false);
                   setStatus('idle');
                   setProgress(0);
                   console.log('[TTSPlayer] ✅ 已隐藏组件');
                 }
               }, 500);
             } else {
               // 还有数据或音频源，继续播放
               console.log('[TTSPlayer] ⏳ 延迟检查：队列=', audioQueueRef.current.length, '音频源=', !!currentSourceRef.current, '接收中=', isReceivingRef.current);
               playNext();
             }
           }, 100); // 等待 100ms 确保真的播放完成
         } else {
           // 还有音频源在播放，等待它完成（通过 onended 回调会继续 playNext）
           const currentProgress = totalSamplesRef.current > 0 
             ? ((playedSamplesRef.current / totalSamplesRef.current) * 100).toFixed(1)
             : '0';
           console.log('[TTSPlayer] ⏳ 队列为空但还有音频源在播放，等待完成。已播放:', playedSamplesRef.current, '/', totalSamplesRef.current, `(${currentProgress}%)`);
         }
         return;
      }

      const chunk = audioQueueRef.current.shift();
      if (!chunk || !audioContextRef.current || !isPlayingRef.current) {
        if (!isPlayingRef.current) {
          return;
        }
        setTimeout(playNext, 0);
        return;
      }

      // 创建 AudioBuffer
      const buffer = audioContextRef.current.createBuffer(1, chunk.length, sampleRate);
      buffer.getChannelData(0).set(chunk);

      // 创建并播放
      const source = audioContextRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContextRef.current.destination);
      currentSourceRef.current = source;

      // 更新已播放采样数
      playedSamplesRef.current += chunk.length;

      source.onended = () => {
        currentSourceRef.current = null;
        const progressPercent = totalSamplesRef.current > 0 
          ? ((playedSamplesRef.current / totalSamplesRef.current) * 100).toFixed(1)
          : '0';
        console.log('[TTSPlayer] 音频分片播放完成，已播放:', playedSamplesRef.current, '/', totalSamplesRef.current, `(${progressPercent}%)`, '队列剩余:', audioQueueRef.current.length, '还在接收:', isReceivingRef.current);
        
        if (isPlayingRef.current) {
          // 继续播放下一个分片
          setTimeout(playNext, 0);
        } else {
          console.log('[TTSPlayer] 播放已被停止，不再继续播放');
          // 如果播放被停止但队列还有数据，清空队列
          if (audioQueueRef.current.length > 0) {
            console.log('[TTSPlayer] ⚠️ 播放被停止但队列还有数据，清空队列');
            audioQueueRef.current = [];
          }
        }
      };

      try {
        source.start(0);
      } catch (err) {
        console.error('[TTSPlayer] 播放分片失败:', err);
        isPlayingRef.current = false;
        setIsPlaying(false);
        setTimeout(playNext, 0);
      }
    };

    playNext();
  };

  // 监听 tts/start - TTS 开始，清空旧数据并准备新播放
  useProjectionMessage('tts/start', () => {
    console.log('[TTSPlayer] TTS 开始，清空旧数据。当前状态: isPlaying=', isPlayingRef.current, 'queueLength=', audioQueueRef.current.length);
    // 立即清空所有旧数据（这会停止播放循环）
    clearAudioState();
    // 准备接收新数据
    isReceivingRef.current = true;
    lastChunkTimeRef.current = Date.now();
    // 先隐藏，等收到音频数据再显示
    isVisibleRef.current = false;
    setIsVisible(false);
    console.log('[TTSPlayer] 已清空旧数据，准备接收新音频');
  });

  // 监听 tts/end - TTS 结束，标记接收完成
  useProjectionMessage('tts/end', () => {
    console.log('[TTSPlayer] TTS 结束，标记接收完成');
    // 标记不再接收新数据
    isReceivingRef.current = false;
    lastChunkTimeRef.current = null;
    // 等待队列播放完成
  });

  // 监听 TTS 音频
  // 上游服务器格式：payload = [{ audio: string }] - audio 是 base64 编码的音频数据
  useProjectionMessage('tts/audio', (data: any) => {
    const audioData = data;
    
    // 如果这是第一个音频数据且还在播放旧数据，先清空（防止没有 tts/started 事件）
    if (!isReceivingRef.current && (isPlayingRef.current || audioQueueRef.current.length > 0)) {
      console.log('[TTSPlayer] ⚠️ 收到新音频数据但还在播放旧数据，清空旧数据（可能没有收到 tts/started）');
      clearAudioState();
      isReceivingRef.current = true;
      lastChunkTimeRef.current = Date.now();
    }
    
    // 确保接收状态为 true
    if (!isReceivingRef.current) {
      isReceivingRef.current = true;
      lastChunkTimeRef.current = Date.now();
    }
    
    // 优先使用 audio 字段（上游服务器标准格式）
    if (audioData?.audio) {
      playAudioChunk(audioData.audio);
    } else if (audioData?.chunk) {
      playAudioChunk(audioData.chunk);
    } else if (audioData?.base64) {
      playAudioChunk(audioData.base64);
    } else if (typeof audioData === 'string') {
      // 兼容直接是字符串的情况
      playAudioChunk(audioData);
    }
  });

  // 清理
  useEffect(() => {
    return () => {
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
      }
      if (currentSourceRef.current) {
        try {
          currentSourceRef.current.stop();
        } catch (e) {
          // 忽略错误
        }
      }
    };
  }, []);

  // 根据状态显示不同的颜色和文本
  const getStatusColor = () => {
    switch (status) {
      case 'playing':
        return 'blue';
      case 'finished':
        return 'green';
      default:
        return 'gray';
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'playing':
        return '播放中';
      case 'finished':
        return '播放完成';
      default:
        return '等待中';
    }
  };

  const sizeStyles = {
    sm: { fontSize: '12px', height: '20px' },
    md: { fontSize: '14px', height: '24px' },
    lg: { fontSize: '16px', height: '28px' },
  };

  const currentSizeStyle = sizeStyles[size];

  // 如果不可见，不渲染组件
  if (!isVisible || !isVisibleRef.current) {
    console.log('[TTSPlayer] 组件不可见，不渲染。isVisible:', isVisible, 'isVisibleRef:', isVisibleRef.current);
    return null;
  }
  
  console.log('[TTSPlayer] 渲染组件，状态:', status, '可见:', isVisible);

  return (
    <Box
      style={{
        width: '400px',
        height: '120px',
        minWidth: '400px',
        minHeight: '120px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'transparent',
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(-20px)',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
    >
      <Box
        style={{
          width: '100%',
          height: '100%',
          padding: '16px',
          backgroundColor: 'rgba(15, 15, 20, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '8px',
          boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(12px)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <Group gap="md" align="center" mb={showProgress ? 'md' : 0} justify="space-between">
          <Badge 
            color={getStatusColor()} 
            size={size}
            variant="filled"
            style={{
              fontSize: size === 'sm' ? '12px' : size === 'md' ? '14px' : '16px',
              padding: size === 'sm' ? '4px 8px' : size === 'md' ? '6px 12px' : '8px 16px',
            }}
          >
            {getStatusText()}
          </Badge>
          {isPlaying && (
            <Text 
              size={size} 
              c="white" 
              fw={600}
              style={{ 
                fontSize: currentSizeStyle.fontSize,
                minWidth: '50px',
                textAlign: 'right',
              }}
            >
              {Math.round(progress)}%
            </Text>
          )}
        </Group>
        {showProgress && (
          <Progress
            value={progress}
            color={getStatusColor()}
            size={size === 'sm' ? 'xs' : size === 'md' ? 'sm' : 'md'}
            animated={status === 'playing'}
            style={{ 
              width: '100%',
              height: size === 'sm' ? '6px' : size === 'md' ? '8px' : '10px',
            }}
          />
        )}
      </Box>
    </Box>
  );
}
