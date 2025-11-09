import { AppShell, Container } from '@mantine/core';
import React from 'react';
import {
  HashRouter, Outlet, Route, Routes,
} from 'react-router-dom';
import { Header } from './components/Header';
import Dashboard from './pages/Dashboard';
import MCPTools from './pages/MCPTools';
import Logs from './pages/Logs';
import Config from './pages/Config';

function DefaultLayout() {
  return (
    <AppShell
      header={{ height: '60px' }}
      padding="md"
    >
      <AppShell.Header>
        <Header />
      </AppShell.Header>
      <AppShell.Main>
        <Container size="xl">
          <Outlet />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<DefaultLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="/mcptools" element={<MCPTools />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/config" element={<Config />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

