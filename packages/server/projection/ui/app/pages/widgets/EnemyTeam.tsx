import { Avatar, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useState, useRef } from 'react';
import { useCs2State } from '../../hooks/useCs2State';

function PlayerCard({ player }: { player: any }) {
  const stats = player.stats || {};
  const elo = player.elo || null;
  const winRate = stats.winRate || null;
  const avg = stats.avg || null;
  const kd = stats.kd || null;
  const adr = stats.adr || null;
  const hsPercent = stats.hsPercent || null;

  // 获取国旗图标 URL（使用 country code）
  const countryFlag = player.country
    ? `https://flagcdn.com/w20/${player.country.toLowerCase()}.png`
    : null;

  // 格式化数据，没有数据时显示 "-"
  const formatValue = (value: number | null, format: 'percent' | 'decimal' | 'integer' = 'integer') => {
    if (value === null || value === undefined || value === 0) return '-';
    if (format === 'percent') return `${value.toFixed(0)}%`;
    if (format === 'decimal') return value.toFixed(2);
    return value.toString();
  };

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
          <Text size="sm" fw={700} c="white">
            {elo !== null && elo > 0 ? elo : '-'}
          </Text>
        </Group>

        {/* 第二行：统计数据（始终显示所有标题） */}
        <Group gap="xs" wrap="nowrap" style={{ fontSize: '11px' }}>
          <Text size="xs" c="#d1d5db">
            {formatValue(winRate, 'percent')} Win
          </Text>
          <Text size="xs" c="#d1d5db">
            {formatValue(avg, 'decimal')} AVG
          </Text>
          <Text size="xs" c="#d1d5db">
            {formatValue(kd, 'decimal')} K/D
          </Text>
          <Text size="xs" c="#d1d5db">
            {formatValue(adr, 'decimal')} ADR
          </Text>
          <Text size="xs" c="#d1d5db">
            {formatValue(hsPercent, 'percent')} HS
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}

// 默认玩家数据模板
const DEFAULT_PLAYERS = [
  { id: '1', nickname: 'Player 1', avatar: null, country: null, elo: null, stats: {} },
  { id: '2', nickname: 'Player 2', avatar: null, country: null, elo: null, stats: {} },
  { id: '3', nickname: 'Player 3', avatar: null, country: null, elo: null, stats: {} },
  { id: '4', nickname: 'Player 4', avatar: null, country: null, elo: null, stats: {} },
  { id: '5', nickname: 'Player 5', avatar: null, country: null, elo: null, stats: {} },
];

export default function EnemyTeam() {
  const { state } = useCs2State();
  const round = state?.round || {};
  const roundPhase = round?.phase || '';
  const player = state?.player || {};

  // 只在 live 时显示，且只显示前10秒
  const shouldShow = roundPhase === 'live';

  const { data } = useQuery({
    queryKey: ['faceit-match'],
    queryFn: async () => {
      const res = await fetch('/api/projection/faceit-match');
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || '获取对局信息失败');
      }
      return res.json();
    },
    refetchInterval: shouldShow ? 10000 : false,
    enabled: shouldShow,
    retry: 2,
  });

  const [isVisible, setIsVisible] = useState(false);
  const liveStartTimeRef = useRef<number | null>(null);

  // 确定敌方队伍（与当前玩家的 team 相反）
  const myTeam = player?.team || 'CT';
  const enemyTeam = myTeam === 'CT' || myTeam === 'ct' ? 'T' : 'CT';

  // 渐进式显示/隐藏（在 live 时显示前10秒）
  useEffect(() => {
    if (shouldShow) {
      // live 阶段开始，记录开始时间
      const now = Date.now();
      if (liveStartTimeRef.current === null) {
        liveStartTimeRef.current = now;
      }
      
      // 显示组件
      const showTimer = setTimeout(() => {
        setIsVisible(true);
      }, 100);

      // 10秒后隐藏
      const elapsed = now - liveStartTimeRef.current;
      const remainingTime = Math.max(0, 10000 - elapsed);
      const hideTimer = setTimeout(() => {
        setIsVisible(false);
      }, remainingTime);

      return () => {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
      };
    } else {
      // 不是 live 阶段，重置开始时间并隐藏
      liveStartTimeRef.current = null;
      setIsVisible(false);
    }
  }, [shouldShow]);

  // 获取玩家列表
  let match = data?.ok ? data.match : null;
  let enemyTeamPlayers: any[] = [];

  if (match && match.source === 'faceit') {
    // 使用 Faceit 数据
    const team1 = match.teams?.team1 || { players: [], name: 'Team 1' };
    const team2 = match.teams?.team2 || { players: [], name: 'Team 2' };
    
    // 尝试通过队伍名称匹配（CT/T vs Team 1/Team 2）
    const map = state?.map || {};
    const team1Name = team1.name || '';
    const team2Name = team2.name || '';
    const ctName = map?.team_ct?.name || 'CT';
    const tName = map?.team_t?.name || 'T';
    
    // 如果敌方是 CT，且 team1 匹配 CT，则使用 team1；否则使用 team2
    const enemyTeamLower = (enemyTeam || '').toLowerCase();
    if (enemyTeamLower === 'ct' && 
        (team1Name.includes('CT') || team1Name === ctName)) {
      enemyTeamPlayers = team1.players || [];
    } else if (enemyTeamLower === 't' && 
               (team2Name.includes('T') || team2Name === tName)) {
      enemyTeamPlayers = team2.players || [];
    } else {
      // 如果 myTeam 是 team1，则 enemyTeam 是 team2，反之亦然
      const myTeamLower = (myTeam || '').toLowerCase();
      const myTeamName = myTeamLower === 'ct' ? ctName : tName;
      if (team1Name === myTeamName || team1.players.some((p: any) => p.nickname === player?.name)) {
        enemyTeamPlayers = team2.players || [];
      } else {
        enemyTeamPlayers = team1.players || [];
      }
    }
  } else if (match && match.source === 'cs2-gsi') {
    // 使用 API 返回的 CS2-GSI 数据
    const team1 = match.teams?.team1 || { players: [] };
    const team2 = match.teams?.team2 || { players: [] };
    
    // 根据敌方队伍选择
    const enemyTeamLower = (enemyTeam || '').toLowerCase();
    if (enemyTeamLower === 'ct') {
      enemyTeamPlayers = team1.players || [];
    } else if (enemyTeamLower === 't') {
      enemyTeamPlayers = team2.players || [];
    }
  }

  // 确保始终有5个玩家（用默认数据填充）
  const displayPlayers = [...enemyTeamPlayers];
  while (displayPlayers.length < 5) {
    const defaultPlayer = { ...DEFAULT_PLAYERS[displayPlayers.length] };
    defaultPlayer.id = `default-${displayPlayers.length + 1}`;
    displayPlayers.push(defaultPlayer);
  }
  // 只取前5个
  const finalPlayers = displayPlayers.slice(0, 5);

  return (
    <Box
      style={{
        width: '100%',
        maxWidth: 320,
        padding: '16px',
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateX(0)' : 'translateX(100%)',
        transition: 'opacity 0.5s ease-in-out, transform 0.5s ease-in-out',
        pointerEvents: isVisible ? 'auto' : 'none',
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
            敌方队伍
          </Text>
          {finalPlayers.map((player: any, index: number) => (
            <PlayerCard key={player.id || `player-${index}`} player={player} />
          ))}
        </Stack>
      </Paper>
    </Box>
  );
}

