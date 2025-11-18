import { AppShell, Container } from '@mantine/core';
import React from 'react';
import {
  HashRouter, Outlet, Route, Routes,
} from 'react-router-dom';
import { Header } from './components/Header';
import Chat from './pages/Chat';
import Config from './pages/Config';
import Dashboard from './pages/Dashboard';

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
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="chat" element={<Chat />} />
          <Route path="config" element={<Config />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

