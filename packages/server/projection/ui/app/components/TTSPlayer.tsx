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

  // 清空所有音频状态
  const clearAudioState = () => {
    // 停止当前播放
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
        currentSourceRef.current.disconnect();
      } catch (e) {
        // 忽略错误
      }
      currentSourceRef.current = null;
    }
    
    // 清空队列
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setIsPlaying(false);
    totalSamplesRef.current = 0;
    playedSamplesRef.current = 0;
    isReceivingRef.current = false;
    lastChunkTimeRef.current = null;
    
    // 清除进度定时器
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    
    setProgress(0);
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
        const currentProgress = isReceivingRef.current 
          ? Math.min(90, baseProgress) 
          : Math.min(100, baseProgress);
        setProgress(currentProgress);
      }
      
      if (isPlayingRef.current) {
        progressTimerRef.current = window.setTimeout(updateProgress, 100);
      }
    };
    updateProgress();

    const playNext = () => {
      // 检查是否还在播放状态
      if (!isPlayingRef.current) {
        return;
      }
      
      if (audioQueueRef.current.length === 0) {
        // 队列为空，等待一段时间看是否还有新数据
        setTimeout(() => {
          if (!isPlayingRef.current) {
            return;
          }
          
          if (audioQueueRef.current.length === 0 && !isReceivingRef.current) {
            // 确实没有更多数据了，结束播放
            isPlayingRef.current = false;
            setIsPlaying(false);
            setStatus('finished');
            setProgress(100);
            
            // 立即隐藏组件（不延迟）
            isVisibleRef.current = false;
            setIsVisible(false);
            setStatus('idle');
            setProgress(0);
            clearAudioState();
            console.log('[TTSPlayer] 播放完成，已隐藏组件');
          } else {
            // 有新数据或还在接收，继续播放
            playNext();
          }
        }, 200);
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
        if (isPlayingRef.current) {
          setTimeout(playNext, 0);
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

  // 监听 agent/content/start - 新内容开始，清空之前的音频并隐藏
  useProjectionMessage('agent/content/start', () => {
    clearAudioState();
    setStatus('idle');
    setProgress(0);
    isVisibleRef.current = false;
    setIsVisible(false); // 新内容开始时先隐藏，等收到音频再显示
    console.log('[TTSPlayer] 新内容开始，已清空之前的音频并隐藏组件');
  });

  // 监听 TTS 音频
  useProjectionMessage('tts/audio', (data: any) => {
    const audioData = data;
    if (audioData?.chunk) {
      playAudioChunk(audioData.chunk);
    } else if (audioData?.base64) {
      playAudioChunk(audioData.base64);
    } else if (audioData?.audio) {
      playAudioChunk(audioData.audio);
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
