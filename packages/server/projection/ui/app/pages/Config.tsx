import {
  Code, Paper, Stack, Text, Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import React from 'react';

export default function Config() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['projection_config'],
    queryFn: () => fetch('/api/projection/info').then((res) => res.json()),
    refetchInterval: 10000,
  });

  return (
    <Stack gap="md">
      <Title order={2}>配置 / 状态</Title>
      {isLoading && <Text size="sm">加载中...</Text>}
      {error && <Text size="sm" c="red">加载失败：{(error as Error).message}</Text>}
      {data && (
        <Paper withBorder p="md" radius="md">
          <Text size="sm" c="dimmed" mb="xs">
            当前 Projection 运行信息（来自 /api/projection/info）：
          </Text>
          <Code block>
            {JSON.stringify(data, null, 2)}
          </Code>
        </Paper>
      )}
      <Text size="sm" c="dimmed">
        后续可以在这里扩展更多 projection 专用配置（比如 OBS 覆盖样式、GSI 映射等）。
      </Text>
    </Stack>
  );
}


