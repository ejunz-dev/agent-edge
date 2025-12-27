import { AppShell, Container } from '@mantine/core';
import React, { useEffect } from 'react';
import {
  BrowserRouter, Outlet, Route, Routes,
} from 'react-router-dom';
import { Header } from './components/Header';
import Dashboard from './pages/Dashboard';
import Live from './pages/Live';
import Config from './pages/Config';
import Chat from './pages/Chat';
import Widget from './pages/Widget';
import WidgetList from './pages/WidgetList';
import SceneList from './pages/SceneList';
import SceneDetail from './pages/SceneDetail';
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
    
    // 调试日志
    console.log('[App] 当前路径:', window.location.pathname);
    console.log('[App] 当前 hash:', window.location.hash);
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        {/* OBS 组件路由（无 Header，背景透明）- 必须在 DefaultLayout 之前，确保优先匹配 */}
        <Route path="/widget/:name" element={<Widget />} />
        <Route path="/" element={<DefaultLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="live" element={<Live />} />
          <Route path="chat" element={<Chat />} />
          <Route path="config" element={<Config />} />
          <Route path="widgets" element={<WidgetList />} />
          <Route path="scenes" element={<SceneList />} />
          <Route path="scenes/:id" element={<SceneDetail />} />
        </Route>
      </Routes>
      {/* 全局对局信息组件（在 freeze 时显示） */}
      <MatchTeams />
    </BrowserRouter>
  );
}


