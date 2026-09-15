import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import NotifyWindow from './NotifyWindow';
import type { ThemeMode } from './types';
import './index.css';

dayjs.locale('zh-cn');

/** 提醒弹窗与主界面共用一个渲染层，用 ?popup=1 区分 */
const IS_POPUP = new URLSearchParams(window.location.search).get('popup') === '1';

/** 跟随系统时监听系统主题变化 */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

function Root() {
  const systemDark = useSystemDark();
  const [mode, setMode] = useState<ThemeMode>('light');

  // 启动时读一次设置，之后由设置面板通过 kefu:theme 事件通知
  useEffect(() => {
    window.kefu
      ?.settings()
      .then((s) => s?.theme && setMode(s.theme as ThemeMode))
      .catch(() => {});
    const onTheme = (e: Event) => setMode((e as CustomEvent).detail as ThemeMode);
    window.addEventListener('kefu:theme', onTheme);
    return () => window.removeEventListener('kefu:theme', onTheme);
  }, []);

  const isDark = mode === 'dark' || (mode === 'system' && systemDark);
  // 供 index.css 里自定义样式做暗色适配
  useEffect(() => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  }, [isDark]);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: { colorPrimary: '#1677ff' },
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      }}
    >
      <AntApp>{IS_POPUP ? <NotifyWindow /> : <App />}</AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
