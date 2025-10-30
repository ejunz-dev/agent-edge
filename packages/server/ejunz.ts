import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from './config';
import { createMCPDispatchers } from './model/mcp';

const logger = new Logger('edge');
const mcpLogger = new Logger('ejunz');

const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    yellow: '\x1b[33m',
};
function highlight(name: string) {
    return `${ANSI.bold}${ANSI.yellow}'${name}'${ANSI.reset}`;
}

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

function startConnecting(ctx?: Context) {
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
            // 主动发送一次初始化通知，帮助对端尽快进入就绪态
            try {
                const initNotify = { jsonrpc: '2.0', method: 'notifications/initialized' };
                ws.send(JSON.stringify(initNotify));
                logger.info('发送初始化通知: %s', JSON.stringify(initNotify));
            } catch { /* ignore */ }
        });

        const sdkDispatchers = createMCPDispatchers();
        ws.on('message', async (data: any) => {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            if (text === 'ping') {
                try { ws.send('pong'); } catch { /* ignore */ }
                return;
            }
            // 尝试按 JSON-RPC 处理（若非 JSON，再做原始调试日志）
            try {
                const parseMaybeNested = (raw: string): any => {
                    let parsed: any = JSON.parse(raw);
                    if (typeof parsed === 'string' && /^(\{|\[)/.test(parsed)) {
                        parsed = JSON.parse(parsed);
                    }
                    return parsed;
                };
                const handleOne = async (req: any) => {
                    const id = req?.id ?? null;
                    const method = req?.method;
                    const reply = (payload: any) => {
                        const out = { jsonrpc: '2.0', id, ...payload };
                        try {
                            ws.send(JSON.stringify(out));
                            try { logger.info('发送响应: id=%s ts=%s bytes=%s', id, Date.now(), Buffer.byteLength(JSON.stringify(out))); } catch {}
                        } catch { /* ignore */ }
                    };
                    if (!method) return;
                    const toolName = req?.params?.name;
                    if (method === 'tools/call' && toolName) {
                        try { mcpLogger.info('MCP 调用: %s id=%s args=%o', highlight(toolName), id, req?.params?.arguments || {}); } catch {}
                    } else {
                        try { mcpLogger.info('MCP 请求: %s id=%s', highlight(method), id); } catch {}
                    }
                    if (method === 'initialize') {
                        reply({
                            result: {
                                protocolVersion: '2024-11-05',
                                capabilities: { tools: {}, resources: {} },
                                serverInfo: { name: 'agent-edge-bridge', version: '1.0.0' },
                            },
                        });
                        try { mcpLogger.info('MCP 回复: %s id=%s (initialize)', highlight(method), id); } catch {}
                        return;
                    }
                    if (sdkDispatchers[method]) {
                        try {
                            const result = await sdkDispatchers[method](ctx as any, req);
                            reply({ result });
                            if (method === 'tools/call' && toolName) {
                                try { mcpLogger.info('MCP 返回: %s id=%s result=%o', highlight(toolName), id, result); } catch {}
                            } else {
                                try { mcpLogger.info('MCP 回复: %s id=%s (ok) result=%o', method, id, result); } catch {}
                            }
                        } catch (e) {
                            reply({ error: { code: -32603, message: (e as Error).message } });
                            try { mcpLogger.warn('MCP 错误: %s id=%s %s', method, id, (e as Error).message); } catch {}
                        }
                        return;
                    }
                    reply({ error: { code: -32601, message: 'Method not found' } });
                    try { mcpLogger.warn('MCP 未知方法: %s id=%s', method, id); } catch {}
                };

                const parsed = parseMaybeNested(text);
                if (Array.isArray(parsed)) {
                    await Promise.all(parsed.map((r) => handleOne(r))); // 简易批处理
                } else {
                    await handleOne(parsed);
                }
            } catch { 
                // 非 JSON 消息，才打印原始调试
                logger.debug?.('上游消息：%s', text.slice(0, 2000));
            }
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
        try { ws?.close?.(1000, 'shutdown'); } catch { /* ignore */ }
    };
}

export async function apply(ctx: Context) {
    // 使用定时器持有清理函数，避免类型不匹配的事件绑定
    const dispose = startConnecting(ctx);
    // 优雅关闭
    process.on('SIGINT', () => { try { dispose(); } catch { /* ignore */ } process.exit(0); });
    process.on('SIGTERM', () => { try { dispose(); } catch { /* ignore */ } process.exit(0); });
}


