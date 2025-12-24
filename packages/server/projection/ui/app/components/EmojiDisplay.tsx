import { Box } from '@mantine/core';
import React, { useEffect, useState, useRef } from 'react';

// 表情包列表
const emojiImages = [
  'cry.png',
  'shy.png',
  'happy.png',
  'smile.png',
  'angry.png',
  'bored.png',
  'mad.png',
  'confused.png',
  'shocked.png',
];

interface EmojiDisplayProps {
  /**
   * 触发切换表情包的键值（当这个值变化时，会切换到下一个表情包）
   */
  trigger?: number | string;
  /**
   * 表情包大小
   */
  size?: number;
  /**
   * 是否随机选择
   */
  random?: boolean;
}

export default function EmojiDisplay({ trigger = 0, size = 100, random = false }: EmojiDisplayProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const lastTriggerRef = useRef<number | string | undefined>(undefined);

  // 初始化时显示第一个表情包
  useEffect(() => {
    console.log('[EmojiDisplay] 组件初始化，当前索引:', currentIndex, '表情包列表:', emojiImages);
  }, []);

  // 当 trigger 变化时，切换到下一个表情包
  useEffect(() => {
    // 只有当 trigger 真正变化时才切换
    if (trigger !== undefined && trigger !== null && trigger !== lastTriggerRef.current) {
      lastTriggerRef.current = trigger;
      if (random) {
        // 随机选择
        const randomIndex = Math.floor(Math.random() * emojiImages.length);
        setCurrentIndex(randomIndex);
        console.log('[EmojiDisplay] 随机切换到索引:', randomIndex);
      } else {
        // 按顺序循环
        setCurrentIndex((prev) => {
          const next = (prev + 1) % emojiImages.length;
          console.log('[EmojiDisplay] 顺序切换: 从', prev, '到', next);
          return next;
        });
      }
    }
  }, [trigger, random]);

  const currentEmoji = emojiImages[currentIndex];
  const imagePath = `/images/${currentEmoji}`;

  // 调试信息
  useEffect(() => {
    console.log('[EmojiDisplay] 当前表情包:', currentEmoji, '路径:', imagePath, '索引:', currentIndex);
  }, [currentEmoji, imagePath, currentIndex]);

  console.log('[EmojiDisplay] 渲染，当前索引:', currentIndex, '表情包:', currentEmoji, '路径:', imagePath);

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        minWidth: size,
        minHeight: size,
      }}
    >
      <img
        src={imagePath}
        alt={currentEmoji.replace('.png', '')}
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          display: 'block',
        }}
        onLoad={() => {
          console.log('[EmojiDisplay] ✅ 表情包加载成功:', imagePath, '完整URL:', window.location.origin + imagePath);
        }}
        onError={(e) => {
          const fullUrl = window.location.origin + imagePath;
          console.error('[EmojiDisplay] ❌ 加载表情包失败:', {
            imagePath,
            fullUrl,
            currentEmoji,
            currentIndex,
            emojiImages,
          });
          // 如果加载失败，显示错误占位符而不是隐藏
          const img = e.target as HTMLImageElement;
          img.style.border = '2px solid red';
          img.style.backgroundColor = 'rgba(255, 0, 0, 0.3)';
          // 显示错误文本
          img.alt = `加载失败: ${imagePath}`;
          // 创建一个文本节点显示错误信息
          const errorText = document.createElement('div');
          errorText.textContent = `加载失败: ${imagePath}`;
          errorText.style.color = 'red';
          errorText.style.fontSize = '12px';
          errorText.style.position = 'absolute';
          errorText.style.top = '50%';
          errorText.style.left = '50%';
          errorText.style.transform = 'translate(-50%, -50%)';
          if (img.parentElement && !img.parentElement.querySelector('.error-text')) {
            errorText.className = 'error-text';
            img.parentElement.appendChild(errorText);
          }
        }}
      />
    </Box>
  );
}

