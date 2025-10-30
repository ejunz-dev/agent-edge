import { Context } from 'cordis';
import { Logger } from './utils';
import { config } from './config';

const logger = new Logger('ejunz');

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
    const fromHost = normalizeUpstreamFromHost((config as any).host || '');
    const target = (config as any).edgeUpstream || fromHost || process.env.EDGE_UPSTREAM || '';
    return target || null;
}

function startConnecting() {
    const url = resolveUpstream();
    if (!url) {
        logger.warn('未配置上游，跳过主动连接。可设置 host 或 edgeUpstream。');
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

    const scheduleReconnect = () => {
        if (stopped) return;
        const nextDelay = Math.min(retryDelay, 30000);
        logger.info('将在 %ds 后重试连接...', Math.round(nextDelay / 1000));
        setTimeout(() => { if (!stopped) connect(); }, nextDelay);
        retryDelay = Math.min(nextDelay * 2, 30000);
    };

    const connect = () => {
        if (stopped) return;
        logger.info('尝试连接上游：%s', url);
        ws = new WS(url);

        ws.on('open', () => {
            logger.info('上游连接已建立：%s', url);
            retryDelay = 3000; // 重置退避
            try { ws.send('{"key":"ping"}'); } catch { /* ignore */ }
        });

        ws.on('message', (data: any) => {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            if (text === 'ping') {
                try { ws.send('pong'); } catch { /* ignore */ }
                return;
            }
            logger.debug?.('上游消息：%s', text.slice(0, 2000));
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('上游连接关闭（code=%s, reason=%s）', code, reason?.toString?.() || '');
            scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            logger.error('上游连接错误：%s', err.message);
            try { ws.close(); } catch { /* ignore */ }
            scheduleReconnect();
        });
    };

    connect();

    return () => {
        stopped = true;
        try { ws?.close?.(1000, 'shutdown'); } catch { /* ignore */ }
    };
}

export async function apply(ctx: Context) {
    // 使用定时器持有清理函数，避免类型不匹配的事件绑定
    const dispose = startConnecting();
    // 优雅关闭
    process.on('SIGINT', () => { try { dispose(); } catch { /* ignore */ } process.exit(0); });
    process.on('SIGTERM', () => { try { dispose(); } catch { /* ignore */ } process.exit(0); });
}


