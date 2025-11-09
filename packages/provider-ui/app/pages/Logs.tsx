import {
  Badge, Button, Card, Code, Group, Paper, ScrollArea, Select, Stack, Text, Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import React, { useState, useEffect, useRef } from 'react';

export default function Logs() {
  const [level, setLevel] = useState<string>('');
  const [tool, setTool] = useState<string>('');
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 获取工具列表用于过滤
  const { data: toolsData } = useQuery({
    queryKey: ['provider_tools'],
    queryFn: () => fetch('/api/tools').then((res) => res.json()),
    refetchInterval: 30000,
  });

  // 初始化WebSocket连接
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/logs/ws`;
    
    const connect = () => {
      // 清理之前的重连定时器
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[Logs] WebSocket connected to', wsUrl);
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (data.type === 'log') {
            setLogs((prev) => {
              const newLogs = [...prev, data.data];
              // 限制日志数量，避免内存溢出
              if (newLogs.length > 500) {
                return newLogs.slice(-500);
              }
              return newLogs;
            });
          } else if (data.type === 'connected') {
            console.log('[Logs] WebSocket connected, receiving logs');
            setIsConnected(true);
          }
        } catch (e) {
          console.error('[Logs] Failed to parse WebSocket message', e, event.data);
        }
      };

      ws.onerror = (error) => {
        console.error('[Logs] WebSocket error', error);
        setIsConnected(false);
      };

      ws.onclose = (event) => {
        console.log('[Logs] WebSocket closed', event.code, event.reason);
        setIsConnected(false);
        // 5秒后重连
        reconnectTimeoutRef.current = setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.CLOSED || !wsRef.current) {
            console.log('[Logs] Attempting to reconnect...');
            connect();
          }
        }, 5000);
      };
    };

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, []);


  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, [logs, autoScroll]);

  const getLevelColor = (lvl: string) => {
    switch (lvl) {
      case 'error': return 'red';
      case 'warn': return 'yellow';
      case 'debug': return 'blue';
      default: return 'gray';
    }
  };

  const filteredLogs = logs.filter((log) => {
    if (level && log.level !== level) return false;
    if (tool && log.tool !== tool) return false;
    return true;
  });

  const handleClear = () => {
    setLogs([]);
  };

  return (
    <Stack gap="md">
      <Card shadow="sm" padding="lg" radius="md" withBorder>
        <Group justify="space-between" mb="md">
          <Title order={2}>MCP 工具调用日志</Title>
          <Group>
            <Select
              placeholder="过滤日志级别"
              data={['', 'debug', 'info', 'warn', 'error']}
              value={level}
              onChange={(value) => setLevel(value || '')}
              clearable
              style={{ width: 150 }}
            />
            <Select
              placeholder="过滤工具"
              data={['', ...(toolsData?.tools?.map((t: any) => t.name) || [])]}
              value={tool}
              onChange={(value) => setTool(value || '')}
              clearable
              style={{ width: 150 }}
            />
            <Button onClick={handleClear} variant="light" color="red">
              清空
            </Button>
            <Button
              onClick={() => setAutoScroll(!autoScroll)}
              variant={autoScroll ? 'filled' : 'light'}
              size="xs"
            >
              {autoScroll ? '自动滚动: 开' : '自动滚动: 关'}
            </Button>
          </Group>
        </Group>
        <ScrollArea h={600} viewportRef={scrollAreaRef}>
          <Stack gap="xs">
            {filteredLogs.length === 0 ? (
              <Paper p="md" withBorder>
                <Text c="dimmed" ta="center">暂无日志</Text>
              </Paper>
            ) : (
              filteredLogs.map((log: any, index: number) => (
                <Paper key={log._id || index} p="sm" withBorder>
                  <Group gap="xs" mb="xs">
                    <Badge color={getLevelColor(log.level)} size="sm">
                      {log.level}
                    </Badge>
                    {log.tool && (
                      <Badge color="blue" size="sm">
                        {log.tool}
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed">
                      {new Date(log.timestamp).toLocaleString('zh-CN')}
                    </Text>
                    {log.metadata?.duration && (
                      <Text size="xs" c="dimmed">
                        耗时: {log.metadata.duration}ms
                      </Text>
                    )}
                  </Group>
                  <Text size="sm">{log.message}</Text>
                  {log.metadata && (
                    <Code block mt="xs" style={{ fontSize: '0.8rem' }}>
                      {JSON.stringify(log.metadata, null, 2)}
                    </Code>
                  )}
                </Paper>
              ))
            )}
          </Stack>
        </ScrollArea>
        <Group mt="md" justify="space-between">
          <Text size="sm" c="dimmed">
            共 {filteredLogs.length} 条日志
          </Text>
          <Text size="sm" c={isConnected ? 'green' : 'red'}>
            {isConnected ? '🟢 实时连接中' : '🔴 连接断开'}
          </Text>
        </Group>
      </Card>
    </Stack>
  );
}

