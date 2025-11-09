import {
  Container,
  Group, rem,
  Tabs, Text, Title,
} from '@mantine/core';
import {
  IconHome, IconSettings, IconTool, IconFileText,
} from '@tabler/icons-react';
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const iconStyle = { width: rem(18), height: rem(18) };

const mainLinks = [
  { link: '/', label: 'Dashboard', icon: <IconHome style={iconStyle} /> },
  { link: '/mcptools', label: 'MCP Tools', icon: <IconTool style={iconStyle} /> },
  { link: '/logs', label: 'Logs', icon: <IconFileText style={iconStyle} /> },
  { link: '/config', label: 'Config', icon: <IconSettings style={iconStyle} /> },
];

export function Header() {
  const nowRoute = useLocation().pathname;
  const navigate = useNavigate();

  const mainItems = mainLinks.map((item) => (
    <Tabs.Tab key={item.link} value={item.link} mr="xs" leftSection={item.icon}>
      <Text visibleFrom='md'>{item.label}</Text>
    </Tabs.Tab>
  ));

  return (
    <header>
      <Container size="xl">
        <Group justify="space-between" h="100%" px="md">
          <Title order={3}>
            MCP Provider
            { /* @ts-ignore */ }
            <Text hiddenFrom="xl">{window.Context?.contest?.id || ''}</Text>
            { /* @ts-ignore */ }
            <Text visibleFrom="xl">{window.Context?.contest?.name || 'MCP Provider Dashboard'}</Text>
          </Title>

          <Group h="100%" gap={0} visibleFrom="sm">
            <Tabs
              variant="pills"
              value={nowRoute}
              onChange={(value) => navigate(value!)}
            >
              <Tabs.List>
                {mainItems}
              </Tabs.List>
            </Tabs>
          </Group>

        </Group>
      </Container>
    </header>
  );
}

