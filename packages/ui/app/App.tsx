import { AppShell, Container } from '@mantine/core';
import React from 'react';
import {
  HashRouter, Outlet, Route, Routes,
} from 'react-router-dom';
import { Header } from './components/Header';
import Dashboard from './pages/Dashboard';
import Logs from './pages/Logs';
import MCP from './pages/MCP';
import Resolver from './Resolver';

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
        <Logs />
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
          <Route path="/mcp" element={<MCP />} />
        </Route>
        <Route path="/resolver" element={<Resolver />} />
      </Routes>
    </HashRouter>
  );
}
