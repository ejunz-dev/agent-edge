import { AppShell, Container } from '@mantine/core';
import React, { useEffect } from 'react';
import {
  HashRouter, Outlet, Route, Routes,
} from 'react-router-dom';
import { Header } from './components/Header';
import Dashboard from './pages/Dashboard';
import Live from './pages/Live';
import Config from './pages/Config';
import Widget from './pages/Widget';
import MatchTeams from './pages/widgets/MatchTeams';

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
  // 全局设置 body 背景透明，方便在 OBS 中叠加
  useEffect(() => {
    document.body.style.background = 'transparent';
    document.body.style.backgroundColor = 'transparent';
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<DefaultLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="live" element={<Live />} />
          <Route path="config" element={<Config />} />
        </Route>
        {/* OBS 组件路由（无 Header，背景透明） */}
        <Route path="/widget/:name" element={<Widget />} />
      </Routes>
      {/* 全局对局信息组件（在 freeze 时显示） */}
      <MatchTeams />
    </HashRouter>
  );
}


