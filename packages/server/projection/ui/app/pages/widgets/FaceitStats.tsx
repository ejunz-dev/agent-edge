import { Group, Paper, Stack, Text, Title, Avatar, Badge, Box } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

function StatItem({ label, value, color = 'white' }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <Stack gap={4} style={{ flex: 1 }}>
      <Text size="sm" c="#d1d5db" ta="center" fw={500}>
        {label}
      </Text>
      <Text size="xl" fw={700} c={color} ta="center" style={{ lineHeight: 1.2 }}>
        {value}
      </Text>
    </Stack>
  );
}

export default function FaceitStats() {
  const [searchParams] = useSearchParams();
  const nickname = searchParams.get('nickname') || '';
  const [showStats, setShowStats] = useState(false);

  // 每1分钟展开，展开后5秒折叠
  useEffect(() => {
    const interval = setInterval(() => {
      setShowStats(true);
      setTimeout(() => {
        setShowStats(false);
      }, 5000); // 5秒后折叠
    }, 60000); // 每1分钟（60秒）执行一次

    // 首次立即展开一次
    setShowStats(true);
    const firstTimeout = setTimeout(() => {
      setShowStats(false);
    }, 5000);

    return () => {
      clearInterval(interval);
      clearTimeout(firstTimeout);
    };
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ['faceit-stats', nickname],
    queryFn: async () => {
      const url = nickname 
        ? `/api/projection/faceit?nickname=${encodeURIComponent(nickname)}`
        : '/api/projection/faceit';
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '获取 Faceit 数据失败');
      }
      return res.json();
    },
    refetchInterval: 30000, // 30 秒刷新一次
    retry: 2,
  });

  if (isLoading) {
    return (
      <Paper
        shadow="xl"
        radius="md"
        p="md"
        withBorder
        style={{
          minWidth: 400,
          background: 'rgba(15, 15, 20, 0.74)',
          borderColor: 'rgba(255, 255, 255, 0.12)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <Text c="dimmed" ta="center">加载 Faceit 数据中...</Text>
      </Paper>
    );
  }

  if (error || !data?.ok) {
    return (
      <Paper
        shadow="xl"
        radius="md"
        p="md"
        withBorder
        style={{
          minWidth: 400,
          background: 'rgba(15, 15, 20, 0.74)',
          borderColor: 'rgba(255, 255, 255, 0.12)',
          backdropFilter: 'blur(12px)',
        }}
      >
        <Text c="red" ta="center">
          {error ? (error as Error).message : '获取 Faceit 数据失败'}
        </Text>
      </Paper>
    );
  }

  const player = data.player || {};
  const stats = data.stats || {};
  const today = data.today || { wins: 0, losses: 0, eloChange: 0 };

  // 计算统计数据
  const kills = stats['Average K/D Ratio'] ? parseFloat(stats['Average K/D Ratio']) : 0;
  const hsPercent = stats['Average Headshots %'] ? parseFloat(stats['Average Headshots %']) : 0;
  const winRate = stats['Win Rate %'] ? parseFloat(stats['Win Rate %']) : 0;
  const totalKills = stats['Total Kills'] || 0;

  return (
    <Paper
      shadow="xl"
      radius="md"
      p="lg"
      withBorder={false}
      style={{
        width: 'fit-content',
        background: 'rgba(30, 30, 35, 0.95)',
        borderColor: 'rgba(255, 255, 255, 0.12)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
      }}
    >
      <Stack gap="md">
        {/* 顶部区域：左侧头像/徽章 + 中间信息 + 右侧胜负圆圈 */}
        <Group justify="space-between" align="center" wrap="nowrap" gap="lg">
          {/* 左侧：头像或红色圆形徽章 */}
          {player.avatar ? (
            <Avatar
              src={player.avatar}
              size={48}
              radius="50%"
              style={{
                flexShrink: 0,
                border: '2px solid rgba(255, 255, 255, 0.1)',
              }}
            />
          ) : (
            <Box
              style={{
                width: 48,
                height: 48,
                borderRadius: '50%',
                background: '#dc2626',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Text size="xl" fw={700} c="white" style={{ lineHeight: 1 }}>
                →
              </Text>
            </Box>
          )}

          {/* 中间：玩家信息 */}
          <Stack gap={2} style={{ flex: 1 }}>
            <Title order={3} c="white" style={{ lineHeight: 1.2, fontSize: '1.5rem' }}>
              {player.nickname || '未知玩家'}
            </Title>
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" c="#d1d5db" fw={500}>
                {player.elo || 0} ELO
              </Text>
              <Text size="sm" c="#d1d5db" fw={500}>
                (
              </Text>
              {today.eloChange > 0 ? (
                <>
                  <Text size="sm" c="#22c55e" fw={500}>↑</Text>
                  <Text size="sm" c="#22c55e" fw={500}>
                    +{today.eloChange}
                  </Text>
                </>
              ) : today.eloChange < 0 ? (
                <>
                  <Text size="sm" c="#dc2626" fw={500}>↓</Text>
                  <Text size="sm" c="#dc2626" fw={500}>
                    {today.eloChange}
                  </Text>
                </>
              ) : (
                <Text size="sm" c="#d1d5db" fw={500}>-</Text>
              )}
              <Text size="sm" c="#d1d5db" fw={500}>
                )
              </Text>
            </Group>
          </Stack>

          {/* 右侧：胜负圆圈 */}
          <Group gap="sm" wrap="nowrap">
            <Box
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: '#22c55e',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Text size="lg" fw={700} c="white">
                {today.wins}
              </Text>
            </Box>
            <Box
              style={{
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: '#dc2626',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Text size="lg" fw={700} c="white">
                {today.losses}
              </Text>
            </Box>
          </Group>
        </Group>

        {/* 底部统计数据 - 渐进式展开/折叠 */}
        <Box
          style={{
            maxHeight: showStats ? 200 : 0,
            opacity: showStats ? 1 : 0,
            overflow: 'hidden',
            transition: 'max-height 0.5s ease-in-out, opacity 0.5s ease-in-out',
          }}
        >
          <Group justify="space-around" gap="lg" wrap="nowrap" style={{ padding: '8px 0' }}>
            <StatItem
              label="Kills"
              value={totalKills > 0 ? totalKills.toLocaleString() : '-'}
              color="white"
            />
            <StatItem
              label="K/D"
              value={kills > 0 ? kills.toFixed(2) : '-'}
              color="white"
            />
            <StatItem
              label="HS %"
              value={hsPercent > 0 ? `${hsPercent.toFixed(0)}%` : '-'}
              color="white"
            />
            <StatItem
              label="Win %"
              value={winRate > 0 ? `${winRate.toFixed(0)}%` : '-'}
              color="white"
            />
          </Group>
        </Box>
      </Stack>
    </Paper>
  );
}

