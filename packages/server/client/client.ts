import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';
import { VoiceClient } from './voice';

const logger = new Logger('client');

// 全局语音客户端实例
let globalVoiceClient: VoiceClient | null = null;

function normalizeUpstreamFromHost(host: string): string {
    if (!host) return '';
    // 支持用户把 host 写成完整 URL
    if (/^https?:\/\//i.test(host)) {
        const base = host.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
        return new URL(base.endsWith('/') ? 'edge/conn' : '/edge/conn', base).toString();
    }
    if (/^wss?:\/\//i.test(host)) {
        return new URL(host.endsWith('/') ? 'edge/conn' : '/edge/conn', host).toString();
    }
    // 默认使用 wss
    return `wss://${host}/edge/conn`;
}

function resolveUpstream(): string | null {
    const fromServer = normalizeUpstreamFromHost((config as any).server || '');
    const target = fromServer || process.env.EDGE_UPSTREAM || '';
    return target || null;
}

function startConnecting(ctx?: Context) {
    const url = resolveUpstream();
    if (!url) {
        logger.warn('未配置上游，跳过主动连接。请在 client 配置中设置 server 或通过环境变量 EDGE_UPSTREAM 指定。');
        return () => {};
    }

    let WS: any;
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        WS = require('ws');
    } catch (e) {
        logger.error('缺少 ws 依赖，请安装依赖 "ws" 后重试。');
        return () => {};
    }

    let ws: any = null;
    let stopped = false;
    let retryDelay = 3000;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let connecting = false;

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return; // 已经安排了重连
        const nextDelay = Math.min(retryDelay, 30000);
        logger.info('将在 %ds 后重试连接...', Math.round(nextDelay / 1000));
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!stopped) connect();
        }, nextDelay);
        retryDelay = Math.min(nextDelay * 2, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (connecting) { logger.debug?.('已有连接尝试进行中，跳过本次 connect'); return; }
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) {
            logger.debug?.('当前连接尚未关闭，跳过本次 connect');
            return;
        }
        connecting = true;
        logger.info('尝试连接上游：%s', url);
        ws = new WS(url);

        ws.on('open', () => {
            logger.info('上游连接已建立：%s', url);
            retryDelay = 3000; // 重置退避
            connecting = false;
            try { ws.send('{"key":"ping"}'); } catch { /* ignore */ }
            // 初始化语音客户端
            globalVoiceClient = new VoiceClient({ ws });
            globalVoiceClient.on('error', (err: Error) => {
                logger.error('语音客户端错误: %s', err.message);
            });
            globalVoiceClient.on('response', (data: any) => {
                logger.info('收到语音回复');
            });
            // 通知 Electron（如果正在运行）
            if (typeof process.send === 'function') {
                try {
                    process.send({ type: 'voice-client-ready' });
                } catch { /* ignore */ }
            }
        });

        ws.on('message', async (data: any) => {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            if (text === 'ping') {
                try { ws.send('pong'); } catch { /* ignore */ }
                return;
            }
            // 非 JSON-RPC 的简单消息日志
            logger.debug?.('上游消息：%s', text.slice(0, 2000));
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('上游连接关闭（code=%s, reason=%s）', code, reason?.toString?.() || '');
            connecting = false;
            scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            logger.error('上游连接错误：%s', err.message);
            connecting = false;
            try { ws.close(); } catch { /* ignore */ }
            scheduleReconnect();
        });
    };

    connect();

    return () => {
        stopped = true;
        globalVoiceClient = null;
        try { ws?.close?.(1000, 'shutdown'); } catch { /* ignore */ }
    };
}

// 导出语音客户端访问接口
export function getVoiceClient(): VoiceClient | null {
    return globalVoiceClient;
}

export async function apply(ctx: Context) {
    // 使用定时器持有清理函数，避免类型不匹配的事件绑定
    const dispose = startConnecting(ctx);
    // 优雅关闭
    process.on('SIGINT', () => { try { dispose(); } catch { /* ignore */ } process.exit(0); });
    process.on('SIGTERM', () => { try { dispose(); } catch { /* ignore */ } process.exit(0); });
}


