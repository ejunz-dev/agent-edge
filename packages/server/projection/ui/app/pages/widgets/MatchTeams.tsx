import { Avatar, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { useCs2State } from '../../hooks/useCs2State';

function PlayerCard({ player }: { player: any }) {
  return (
    <Paper
      p="xs"
      radius="sm"
      style={{
        background: 'rgba(20, 20, 25, 0.9)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
      }}
    >
      <Group gap="xs" wrap="nowrap">
        {player.avatar && (
          <Avatar src={player.avatar} size="sm" radius="sm" />
        )}
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="xs" fw={600} c="white" truncate>
            {player.nickname || 'Unknown'}
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Text size="xs" c="#d1d5db">
              {player.elo || 0}
            </Text>
            {player.country && (
              <Text size="xs" c="#d1d5db">
                {player.country}
              </Text>
            )}
          </Group>
        </Stack>
      </Group>
    </Paper>
  );
}

export default function MatchTeams() {
  const { state } = useCs2State();
  const round = state?.round || {};
  const roundPhase = round?.phase || '';

  // 根据 round.phase 控制显示/隐藏
  // freezetime = 冻结时间（回合开始前的准备时间）
  const shouldShow = roundPhase === 'freezetime' || roundPhase === 'warmup';

  const { data, isLoading } = useQuery({
    queryKey: ['faceit-match'],
    queryFn: async () => {
      const res = await fetch('/api/projection/faceit-match');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '获取对局信息失败');
      }
      return res.json();
    },
    refetchInterval: shouldShow ? 10000 : false, // 只在需要显示时刷新
    enabled: true, // 始终启用，但只在 shouldShow 时刷新
    retry: 2,
  });

  const [isVisible, setIsVisible] = useState(false);

  // 渐进式显示/隐藏
  useEffect(() => {
    if (shouldShow && data?.ok && data?.match) {
      // 延迟一点显示，让动画更流畅
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, 100);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(false);
    }
  }, [shouldShow, data]);

  if (!isVisible || !data?.ok || !data?.match) {
    return null;
  }

  const match = data.match;
  const team1 = match.teams?.team1 || { players: [] };
  const team2 = match.teams?.team2 || { players: [] };

  return (
    <>
      {/* 左侧队伍 */}
      <Box
        style={{
          position: 'fixed',
          left: 0,
          top: '50%',
          width: 280,
          maxHeight: '80vh',
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? 'translate(0, -50%)' : 'translate(-100%, -50%)',
          transition: 'opacity 0.5s ease-in-out, transform 0.5s ease-in-out',
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      >
        <Paper
          p="md"
          radius="md"
          style={{
            background: 'rgba(20, 20, 25, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
          }}
        >
          <Stack gap="xs">
            <Text size="sm" fw={700} c="white" mb="xs">
              Team 1
            </Text>
            {team1.players.map((player: any) => (
              <PlayerCard key={player.id} player={player} />
            ))}
          </Stack>
        </Paper>
      </Box>

      {/* 右侧队伍 */}
      <Box
        style={{
          position: 'fixed',
          right: 0,
          top: '50%',
          width: 280,
          maxHeight: '80vh',
          opacity: isVisible ? 1 : 0,
          transform: isVisible ? 'translate(0, -50%)' : 'translate(100%, -50%)',
          transition: 'opacity 0.5s ease-in-out, transform 0.5s ease-in-out',
          zIndex: 1000,
          pointerEvents: 'none',
        }}
      >
        <Paper
          p="md"
          radius="md"
          style={{
            background: 'rgba(20, 20, 25, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
          }}
        >
          <Stack gap="xs">
            <Text size="sm" fw={700} c="white" mb="xs">
              Team 2
            </Text>
            {team2.players.map((player: any) => (
              <PlayerCard key={player.id} player={player} />
            ))}
          </Stack>
        </Paper>
      </Box>
    </>
  );
}

