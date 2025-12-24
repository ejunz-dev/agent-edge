import {
  Box,
  Group,
  Paper,
  Stack,
  Text,
  Title,
  ThemeIcon,
  Progress,
  Badge,
  RingProgress,
} from '@mantine/core';
import {
  IconSword, IconShield, IconClockHour4, IconBomb,
} from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { useProjectionMessage, useProjectionWebSocket } from '../hooks/useProjectionWebSocket';

type Cs2State = any;

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Group justify="space-between">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {value}
      </Text>
    </Group>
  );
}

export default function Overlay() {
  const [state, setState] = useState<Cs2State | null>(null);
  const { connected } = useProjectionWebSocket();
  const [bombFlashOn, setBombFlashOn] = useState(false);
  const [bombSecondsLeft, setBombSecondsLeft] = useState<number | null>(null);
  const [bombPlantedAt, setBombPlantedAt] = useState<number | null>(null);

  // 使用共享的 WebSocket 连接监听 state 消息
  useProjectionMessage('state', (data: any) => {
    setState(data || null);
  });

  // 初次加载时通过 REST 拉一次（避免没有推送时界面是空的）
  useEffect(() => {
    fetch('/api/projection/state')
      .then((res) => res.json())
      .then((data) => {
        if (data?.state) setState(data.state);
      })
      .catch(() => {});
  }, []);

  const player = state?.player || {};
  const round = state?.round || {};
  const map = state?.map || {};
  const bomb = state?.bomb || {};

  const hp = Number(player?.state?.health ?? 0);
  const armor = Number(player?.state?.armor ?? 0);
  const money = Number(player?.state?.money ?? 0);
  const team = player?.team || map?.team_ct?.name || '';

  const tScore = map?.team_t?.score ?? 0;
  const ctScore = map?.team_ct?.score ?? 0;

  const roundPhase = round?.phase || 'unknown';
  const phaseCountdown = round?.phase_ends_in;

  // 武器与道具解析（基于 CS2 GSI player.weapons 结构）
  const weaponsObj = player?.weapons || {};
  const weapons: any[] = weaponsObj ? Object.values(weaponsObj) : [];

  const activeWeapon = weapons.find((w) => w?.state === 'active') || null;
  const primaryWeapon = weapons.find((w) => ['Rifle', 'SniperRifle', 'SubmachineGun', 'Shotgun', 'MachineGun'].includes(w?.type)) || null;
  const secondaryWeapon = weapons.find((w) => w?.type === 'Pistol') || null;
  const grenades = weapons.filter((w) => w?.type === 'Grenade');

  function formatWeapon(w: any | null) {
    if (!w) return '无';
    const name = w.name || '未知';
    if (typeof w.ammo_clip === 'number') {
      const reserve = typeof w.ammo_reserve === 'number' ? w.ammo_reserve : 0;
      return `${name} ${w.ammo_clip}/${reserve}`;
    }
    return name;
  }

  const activeWeaponText = formatWeapon(activeWeapon || primaryWeapon);
  const secondaryWeaponText = formatWeapon(secondaryWeapon);

  const grenadeSummary = (() => {
    if (!grenades.length) return '无';
    const mapCount = new Map<string, number>();
    grenades.forEach((g) => {
      const n = g.name || 'Grenade';
      mapCount.set(n, (mapCount.get(n) || 0) + 1);
    });
    return Array.from(mapCount.entries())
      .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
      .join(' / ');
  })();

  // 炸弹状态文案（基于 CS2 GSI 标准字段 bomb.state / bomb.position 等）
  let bombText: string | null = null;
  let bombColor: string = 'gray';
  // 优先使用 bomb.state；如果没有，则使用 round.bomb（例如 "planted"）
  const bombState = bomb?.state || round?.bomb;
  const bombTotalTime = 38; // 视觉倒计时起点（约等于安放完成后到爆炸的时间）
  let bombProgress: number | null = null;

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

  // 本地炸弹计时：检测炸弹从未安放 -> 已安放的边沿，记录开始时间
  const [lastBombState, setLastBombState] = useState<string | null>(null);
  useEffect(() => {
    if (bombState === 'planted' && lastBombState !== 'planted') {
      // 安放完成检测到的瞬间，从 38s 开始倒计时
      setBombPlantedAt(performance.now());
      setBombSecondsLeft(bombTotalTime);
    }
    if (bombState && bombState !== 'planted') {
      setBombPlantedAt(null);
      setBombSecondsLeft(null);
    }
    setLastBombState(bombState || null);
  }, [bombState, lastBombState]);

  // 高频刷新炸弹秒数（基于本地时间，连续小数倒计时）
  useEffect(() => {
    if (!bombPlantedAt || bombState !== 'planted') return undefined;

    let frame: number;
    const tick = () => {
      const elapsed = (performance.now() - bombPlantedAt) / 1000;
      const left = bombTotalTime - elapsed;
      const clamped = left > 0 ? left : 0;
      setBombSecondsLeft(clamped);
      if (clamped > 0 && bombState === 'planted') {
        frame = window.requestAnimationFrame(tick);
      }
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [bombPlantedAt, bombState, bombTotalTime]);

  if (bombText === '炸弹已安放' && bombSecondsLeft !== null) {
    bombProgress = Math.max(0, Math.min(100, (bombSecondsLeft / bombTotalTime) * 100));
  }

  // 炸弹临近爆炸时的闪烁效果（仅在炸弹已安放且还有时间时启用）
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

  return (
    <Box
      style={{
        width: '100%',
        minHeight: '100vh', // 避免根节点高度为 0，确保页面可见
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        padding: '16px',
        boxSizing: 'border-box',
        backgroundColor: '#05070a',
        pointerEvents: 'none', // 方便叠加在 OBS 里不挡鼠标
      }}
    >
      <Paper
        shadow="xl"
        radius="md"
        p="md"
        withBorder
        style={{
          minWidth: 420,
          maxWidth: 560,
          background: 'rgba(15, 15, 20, 0.74)',
          borderColor: 'rgba(255, 255, 255, 0.12)',
          backdropFilter: 'blur(12px)',
          pointerEvents: 'auto',
        }}
      >
        <Group justify="space-between" mb="xs" align="flex-end">
          <Stack gap={2}>
            <Title order={3} c="white">
              {player?.name || '等待 CS2 GSI 数据...'}
            </Title>
            <Text size="sm" c="dimmed">
              {team || '未知阵营'}
            </Text>
          </Stack>
          <Stack gap={2} align="flex-end">
            <Text size="sm" c="dimmed">
              {map?.name || '未知地图'}
            </Text>
            <Group gap="xs">
              <Text size="sm" c="yellow">
                T {tScore}
              </Text>
              <Text size="sm" c="dimmed">
                :
              </Text>
              <Text size="sm" c="cyan">
                CT {ctScore}
              </Text>
            </Group>
          </Stack>
        </Group>

        <Box mb="sm">
          <Group gap="xs" mb={4}>
            <ThemeIcon variant="light" radius="xl" color="red" size="sm">
              <IconSword size={14} />
            </ThemeIcon>
            <Text size="xs" c="red.2" tt="uppercase">
              HP {hp}
            </Text>
          </Group>
          <Progress value={Math.max(0, Math.min(100, hp))} color="red" size="lg" radius="xl" />
        </Box>

        <Group mb="xs" gap="md">
          <Box flex={1}>
            <Group gap="xs" mb={4}>
              <ThemeIcon variant="light" radius="xl" color="blue" size="sm">
                <IconShield size={14} />
              </ThemeIcon>
              <Text size="xs" c="blue.2" tt="uppercase">
                Armor {armor}
              </Text>
            </Group>
            <Progress
              value={Math.max(0, Math.min(100, armor))}
              color="blue"
              size="sm"
              radius="xl"
            />
          </Box>

          <Box>
            <Text size="xs" c="yellow.3">
              $ {money}
            </Text>
          </Box>
        </Group>

        <Group mb="xs" gap="md" align="center">
          <ThemeIcon variant="subtle" radius="xl" color="gray" size="sm">
            <IconClockHour4 size={14} />
          </ThemeIcon>
          <Text size="xs" c="gray.2">
            {roundPhase.toUpperCase()}
            {typeof phaseCountdown === 'string' && ` · ${phaseCountdown}s`}
          </Text>

          {bombText && (
            <Badge
              leftSection={<IconBomb size={12} />}
              color={bombColor}
              radius="sm"
              variant="filled"
              ml="xs"
              style={{
                boxShadow: bombFlashOn ? '0 0 14px rgba(255, 80, 80, 0.9)' : 'none',
                transform: bombFlashOn ? 'scale(1.03)' : 'scale(1)',
                transition: 'all 120ms linear',
              }}
            >
              {bombText}
            </Badge>
          )}

          {bombSecondsLeft !== null && bombProgress !== null && (
            <Group gap={6} align="center">
              <RingProgress
                size={36}
                thickness={4}
                sections={[{ value: bombProgress, color: bombColor }]}
                style={{
                  opacity: bombFlashOn ? 1 : 0.4,
                  transition: 'opacity 120ms linear',
                }}
              />
              <Text size="sm" c={bombFlashOn ? 'red.4' : 'red.2'} fw={700}>
                {bombSecondsLeft.toFixed(2)}
                s
              </Text>
            </Group>
          )}
        </Group>

        <Stack gap={4} mt="xs">
          <InfoRow label="当前武器" value={activeWeaponText} />
          <InfoRow label="副武器" value={secondaryWeaponText} />
          <InfoRow label="道具" value={grenadeSummary} />
          <InfoRow label="连接状态" value={connected ? '实时连接中' : '等待连接'} />
        </Stack>
      </Paper>
    </Box>
  );
}


