import { Paper, Title } from '@mantine/core';
import React from 'react';

export default function Console() {
  return (
    <div>
      <Title order={2} mb="lg">Zigbee 控制台</Title>
      <Paper withBorder p={0} style={{ height: 'calc(100vh - 200px)', minHeight: '600px', overflow: 'hidden' }}>
        <iframe
          src="/zigbee-console"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          title="Zigbee Console"
        />
      </Paper>
    </div>
  );
}

