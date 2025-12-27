import { Avatar, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCs2State } from '../../hooks/useCs2State';
import { useEventSystem } from '../../hooks/useEventSystem';
import { WidgetConfig } from '../../utils/widgetConfig';

function PlayerCard({ player }: { player: any }) {
  const stats = player.stats || {};
  const elo = player.elo || 0;
  const winRate = stats.winRate || 0;
  const avg = stats.avg || 0;
  const kd = stats.kd || 0;
  const adr = stats.adr || 0;
  const hsPercent = stats.hsPercent || 0;

  // 获取国旗图标 URL（使用 country code）
  const countryFlag = player.country
    ? `https://flagcdn.com/w20/${player.country.toLowerCase()}.png`
    : null;

  return (
    <Paper
      p="sm"
      radius="sm"
      style={{
        background: 'rgba(20, 20, 25, 0.95)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        marginBottom: '8px',
      }}
    >
      <Stack gap="xs">
        {/* 第一行：头像/国旗 + 昵称 + ELO */}
        <Group gap="xs" wrap="nowrap" justify="space-between">
          <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            {countryFlag && (
              <img
                src={countryFlag}
                alt={player.country}
                style={{ width: 20, height: 15, objectFit: 'cover', borderRadius: 2 }}
              />
            )}
            {player.avatar && (
              <Avatar src={player.avatar} size={24} radius="sm" />
            )}
            <Text size="sm" fw={600} c="white" truncate style={{ flex: 1 }}>
              {player.nickname || 'Unknown'}
            </Text>
          </Group>
          {elo > 0 && (
            <Text size="sm" fw={700} c="white">
              {elo}
            </Text>
          )}
        </Group>

        {/* 第二行：统计数据 */}
        {stats && (winRate > 0 || avg > 0 || kd > 0 || adr > 0 || hsPercent > 0) && (
          <Group gap="xs" wrap="nowrap" style={{ fontSize: '11px' }}>
            {winRate > 0 && (
              <Text size="xs" c="#d1d5db">
                {winRate.toFixed(0)}% Win
              </Text>
            )}
            {avg > 0 && (
              <Text size="xs" c="#d1d5db">
                {avg.toFixed(2)} AVG
              </Text>
            )}
            {kd > 0 && (
              <Text size="xs" c="#d1d5db">
                {kd.toFixed(2)} K/D
              </Text>
            )}
            {adr > 0 && (
              <Text size="xs" c="#d1d5db">
                {adr.toFixed(2)} ADR
              </Text>
            )}
            {hsPercent > 0 && (
              <Text size="xs" c="#d1d5db">
                {hsPercent.toFixed(0)}% HS
              </Text>
            )}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

interface MatchTeamsProps {
  config?: any;
}

export default function MatchTeams({ config }: MatchTeamsProps) {
  // 使用事件系统控制可见性
  const { isVisible: eventVisible } = useEventSystem('matchteams', true, false);
  const [searchParams] = useSearchParams();
  const isPreview = searchParams.get('preview') === 'true';
  const { state } = useCs2State();
  const round = state?.round || {};
  const roundPhase = round?.phase || '';

  // 检查是否在 widget 页面中（通过 URL 判断）
  const isWidgetPage = window.location.pathname.includes('/widget/matchteams');
  
  // 预览模式下始终显示，否则根据事件系统或内部逻辑控制显示/隐藏
  // freezetime = 冻结时间（回合开始前的准备时间）
  const shouldShow = isPreview || isWidgetPage || eventVisible || roundPhase === 'freezetime' || roundPhase === 'warmup';

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
    // 如果有 Faceit 数据，使用它；否则尝试使用 CS2 GSI 数据
    const hasFaceitData = shouldShow && data?.ok && data?.match && data.match.source === 'faceit';
    const hasCs2Data = shouldShow && state?.allplayers && Object.keys(state.allplayers).length > 0;
    
    // 在 widget 页面中，即使没有数据也显示（用于调试）
    if (isWidgetPage || hasFaceitData || hasCs2Data) {
      // 延迟一点显示，让动画更流畅
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, 100);
      return () => clearTimeout(timer);
    } else {
      setIsVisible(false);
    }
  }, [shouldShow, data, state, isWidgetPage]);

  // 如果没有 Faceit 数据，尝试从 CS2 GSI 构建数据
  let match = data?.ok ? data.match : null;
  let team1 = { players: [] as any[], name: 'CT' };
  let team2 = { players: [] as any[], name: 'T' };

  if (match && match.source === 'faceit') {
    // 使用 Faceit 数据
    team1 = match.teams?.team1 || { players: [], name: 'Team 1' };
    team2 = match.teams?.team2 || { players: [], name: 'Team 2' };
  } else if (state?.allplayers && (shouldShow || isWidgetPage)) {
    // 使用 CS2 GSI 数据作为备选
    const allPlayers = state.allplayers || {};
    const map = state.map || {};
    const cs2Team1: any[] = [];
    const cs2Team2: any[] = [];
    
    // 处理 allplayers 可能是对象或数组的情况
    const playersArray = Array.isArray(allPlayers) 
      ? allPlayers 
      : typeof allPlayers === 'object' 
        ? Object.values(allPlayers) 
        : [];
    
    playersArray.forEach((p: any) => {
      if (!p || !p.name) return;
      const playerData = {
        id: p.steamid || p.name,
        nickname: p.name,
        avatar: null,
        country: null,
        elo: null,
        level: null,
        stats: {},
        team: p.team || 'unknown',
        steamid: p.steamid || null,
      };
      
      if (p.team === 'CT' || p.team === 'ct') {
        cs2Team1.push(playerData);
      } else if (p.team === 'T' || p.team === 't') {
        cs2Team2.push(playerData);
      }
    });
    
    team1 = {
      players: cs2Team1,
      name: map?.team_ct?.name || 'CT',
    };
    team2 = {
      players: cs2Team2,
      name: map?.team_t?.name || 'T',
    };
  }
  
  // 预览模式下始终显示，否则根据条件显示
  const shouldRender = isPreview || isWidgetPage || isVisible;
  
  if (!shouldRender) {
    return null;
  }
  
  // 在 widget 页面中，强制设置为可见
  const finalIsVisible = isWidgetPage ? true : isVisible;

  // 在 widget 页面中使用相对定位，否则使用固定定位
  const containerStyle: React.CSSProperties = isWidgetPage
    ? {
        display: 'flex',
        gap: '20px',
        justifyContent: 'center',
        alignItems: 'flex-start',
        width: '100%',
        minHeight: '400px',
      }
    : {};

  const teamBoxStyle: React.CSSProperties = isWidgetPage
    ? {
        width: 280,
        maxWidth: '45%',
        opacity: finalIsVisible ? 1 : 0,
        transition: 'opacity 0.5s ease-in-out',
      }
    : {
        position: 'fixed',
        left: 0,
        top: '50%',
        width: 280,
        maxHeight: '80vh',
        opacity: finalIsVisible ? 1 : 0,
        transform: finalIsVisible ? 'translate(0, -50%)' : 'translate(-100%, -50%)',
        transition: 'opacity 0.5s ease-in-out, transform 0.5s ease-in-out',
        zIndex: 1000,
        pointerEvents: 'none' as const,
      };

  return (
    <Box style={containerStyle}>
      {/* 左侧队伍 */}
      <Box style={teamBoxStyle}>
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
              {team1.name || 'Team 1'}
            </Text>
            {team1.players.length > 0 ? (
              team1.players.map((player: any) => (
                <PlayerCard key={player.id || player.nickname} player={player} />
              ))
            ) : (
              <Text size="xs" c="dimmed" ta="center" py="xs">
                暂无玩家数据
              </Text>
            )}
          </Stack>
        </Paper>
      </Box>

      {/* 右侧队伍 */}
      <Box
        style={
          isWidgetPage
            ? ({
                width: 280,
                maxWidth: '45%',
                opacity: finalIsVisible ? 1 : 0,
                transition: 'opacity 0.5s ease-in-out',
              } as React.CSSProperties)
            : ({
                position: 'fixed',
                right: 0,
                top: '50%',
                width: 280,
                maxHeight: '80vh',
                opacity: finalIsVisible ? 1 : 0,
                transform: finalIsVisible ? 'translate(0, -50%)' : 'translate(100%, -50%)',
                transition: 'opacity 0.5s ease-in-out, transform 0.5s ease-in-out',
                zIndex: 1000,
                pointerEvents: 'none' as const,
              } as React.CSSProperties)
        }
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
              {team2.name || 'Team 2'}
            </Text>
            {team2.players.length > 0 ? (
              team2.players.map((player: any) => (
                <PlayerCard key={player.id || player.nickname} player={player} />
              ))
            ) : (
              <Text size="xs" c="dimmed" ta="center" py="xs">
                暂无玩家数据
              </Text>
            )}
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}

