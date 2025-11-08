import { Paper, Title } from '@mantine/core';
import React from 'react';

export default function Settings() {
  return (
    <div>
      <Title order={2} mb="lg">MQTT Bridge 配置</Title>
      <Paper withBorder p={0} style={{ height: 'calc(100vh - 200px)', minHeight: '600px', overflow: 'hidden' }}>
        <iframe
          src="/mqtt-bridge-config"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          title="MQTT Bridge Config"
        />
      </Paper>
    </div>
  );
}

