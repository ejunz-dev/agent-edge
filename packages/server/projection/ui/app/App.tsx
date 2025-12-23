import { AppShell, Container } from '@mantine/core';
import React from 'react';
import {
  HashRouter, Outlet, Route, Routes,
} from 'react-router-dom';
import { Header } from './components/Header';
import Dashboard from './pages/Dashboard';
import Live from './pages/Live';
import Config from './pages/Config';

function DefaultLayout() {
  return (
    <AppShell
      header={{ height: '50px' }}
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
          <Route path="live" element={<Live />} />
          <Route path="config" element={<Config />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}


