import { Badge, Group, Paper, RingProgress, Text, ThemeIcon } from '@mantine/core';
import { IconBomb, IconClockHour4 } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCs2State } from '../../hooks/useCs2State';
import { WidgetConfig } from '../../utils/widgetConfig';

interface BombStatusProps {
  config?: WidgetConfig;
}

export default function BombStatus({ config }: BombStatusProps) {
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const { state } = useCs2State();
  const round = state?.round || {};
  const bomb = state?.bomb || {};
  const [bombFlashOn, setBombFlashOn] = useState(false);
  const [bombSecondsLeft, setBombSecondsLeft] = useState<number | null>(null);
  const [bombPlantedAt, setBombPlantedAt] = useState<number | null>(null);

  const bombState = bomb?.state || round?.bomb;
  const bombTotalTime = 38;
  let bombText: string | null = null;
  let bombColor: string = 'gray';

  if (bombState === 'planting') {
    bombText = '正在安放炸弹';
    bombColor = 'yellow';
  } else if (bombState === 'planted') {
    bombText = '炸弹已安放';
    bombColor = 'red';
  } else if (bombState === 'defusing') {
    bombText = '正在拆除炸弹';
    bombColor = 'cyan';
  } else if (bombState === 'exploded') {
    bombText = '炸弹已爆炸';
    bombColor = 'orange';
  } else if (bombState === 'defused') {
    bombText = '炸弹已被拆除';
    bombColor = 'green';
  }

  const roundPhase = round?.phase || 'unknown';
  const phaseCountdown = round?.phase_ends_in;

  // 检测炸弹安放
  const [lastBombState, setLastBombState] = useState<string | null>(null);
  useEffect(() => {
    if (bombState === 'planted' && lastBombState !== 'planted') {
      setBombPlantedAt(performance.now());
      setBombSecondsLeft(bombTotalTime);
    }
    if (bombState && bombState !== 'planted') {
      setBombPlantedAt(null);
      setBombSecondsLeft(null);
    }
    setLastBombState(bombState || null);
  }, [bombState, lastBombState, bombTotalTime]);

  // 实时倒计时（使用 requestAnimationFrame）
  useEffect(() => {
    if (bombPlantedAt === null || bombSecondsLeft === null) return;

    let rafId: number;
    const update = () => {
      const elapsed = (performance.now() - bombPlantedAt!) / 1000;
      const left = bombTotalTime - elapsed;
      const newLeft = Math.max(0, left);
      setBombSecondsLeft(newLeft);

      if (newLeft > 0) {
        rafId = requestAnimationFrame(update);
      }
    };
    rafId = requestAnimationFrame(update);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [bombPlantedAt, bombTotalTime]);

  // 闪烁效果
  useEffect(() => {
    let timer: number | null = null;
    const shouldFlash = bombText === '炸弹已安放' && bombSecondsLeft !== null;

    if (shouldFlash) {
      setBombFlashOn(true);
      const interval = bombSecondsLeft! > 10 ? 500 : 250;
      timer = window.setInterval(() => {
        setBombFlashOn((prev) => !prev);
      }, interval);
    } else {
      setBombFlashOn(false);
    }

    return () => {
      if (timer !== null) window.clearInterval(timer);
    };
  }, [bombText, bombSecondsLeft]);

  const bombProgress = bombSecondsLeft !== null
    ? Math.max(0, Math.min(100, (bombSecondsLeft / bombTotalTime) * 100))
    : null;

  // 预览模式下显示示例数据
  const displayBombText = isPreview ? '炸弹已安放' : bombText;
  const displayBombColor = isPreview ? 'red' : bombColor;
  const displayBombProgress = isPreview ? 50 : bombProgress;
  const displayBombSecondsLeft = isPreview ? 19.0 : bombSecondsLeft;
  const displayRoundPhase = isPreview ? 'LIVE' : roundPhase.toUpperCase();
  const displayPhaseCountdown = isPreview ? '10s' : (typeof phaseCountdown === 'string' ? phaseCountdown : null);

  const style = config?.style || {};

  return (
    <Paper
      shadow={style.shadow || 'xl'}
      radius={style.borderRadius || 'md'}
      p={style.padding || 'md'}
      withBorder
      style={{
        minWidth: style.minWidth || 320,
        background: style.background || 'rgba(15, 15, 20, 0.74)',
        borderColor: style.borderColor || 'rgba(255, 255, 255, 0.12)',
        backdropFilter: style.backdropFilter || 'blur(12px)',
        border: style.border,
      }}
    >
      <Group gap="md" align="center">
        {config?.showIcon !== false && config?.showText !== false && (
          <>
            <ThemeIcon variant="subtle" radius="xl" color="gray" size="sm">
              <IconClockHour4 size={14} />
            </ThemeIcon>
            <Text size="xs" c="gray.2">
              {displayRoundPhase}
              {displayPhaseCountdown && ` · ${displayPhaseCountdown}`}
            </Text>
          </>
        )}
        {config?.showIcon === true && config?.showText === false && (
          <ThemeIcon variant="subtle" radius="xl" color="gray" size="lg">
            <IconBomb size={24} />
          </ThemeIcon>
        )}
        {config?.showText === true && config?.showIcon === false && (
          <Text size="sm" c="gray.2" fw={700}>
            {displayRoundPhase} {displayBombText || ''}
          </Text>
        )}

        {(displayBombText || isPreview) && config?.showText !== false && config?.showIcon !== false && (
          <Badge
            leftSection={config?.showIcon !== false ? <IconBomb size={12} /> : undefined}
            color={displayBombColor}
            radius="sm"
            variant="filled"
            style={{
              boxShadow: (bombFlashOn || isPreview) ? '0 0 14px rgba(255, 80, 80, 0.9)' : 'none',
              transform: (bombFlashOn || isPreview) ? 'scale(1.03)' : 'scale(1)',
              transition: 'all 120ms linear',
            }}
          >
            {displayBombText || '炸弹已安放'}
          </Badge>
        )}

        {((displayBombSecondsLeft !== null && displayBombProgress !== null) || isPreview) && config?.showProgress !== false ? (
          <Group gap={6} align="center">
            {config?.showProgress !== false && (
              <RingProgress
                size={36}
                thickness={4}
                sections={[{ value: displayBombProgress || 50, color: displayBombColor }]}
                style={{
                  opacity: (bombFlashOn || isPreview) ? 1 : 0.4,
                  transition: 'opacity 120ms linear',
                }}
              />
            )}
            {config?.showText !== false && (
              <Text size="sm" c={(bombFlashOn || isPreview) ? 'red.4' : 'red.2'} fw={700}>
                {(displayBombSecondsLeft || 19.0).toFixed(2)}s
              </Text>
            )}
          </Group>
        ) : null}
      </Group>
    </Paper>
  );
}

