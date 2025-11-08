import {
  Container, Paper, Tabs, Title,
} from '@mantine/core';
import {
  IconSettings, IconTerminal,
} from '@tabler/icons-react';
import React, { useState } from 'react';

export default function NodeDashboard() {
  const [activeTab, setActiveTab] = useState<string | null>('console');

  return (
    <Container size="xl" py="md">
      <Title order={2} mb="lg">Node 控制台</Title>
      
      <Tabs value={activeTab} onChange={setActiveTab}>
        <Tabs.List>
          <Tabs.Tab value="console" leftSection={<IconTerminal size={16} />}>
            Zigbee 控制台
          </Tabs.Tab>
          <Tabs.Tab value="settings" leftSection={<IconSettings size={16} />}>
            MQTT Bridge 配置
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="console" pt="md">
          <Paper withBorder p={0} style={{ height: 'calc(100vh - 280px)', minHeight: '600px', overflow: 'hidden' }}>
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
        </Tabs.Panel>

        <Tabs.Panel value="settings" pt="md">
          <Paper withBorder p={0} style={{ height: 'calc(100vh - 280px)', minHeight: '600px', overflow: 'hidden' }}>
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
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}

