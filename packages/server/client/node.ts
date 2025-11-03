// @ts-nocheck
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';
import Zigbee2MqttService from '../service/zigbee2mqtt';

const logger = new Logger('node-client');

function normalizeUpstreamFromHost(host: string): string {
    if (!host) return '';
    if (/^https?:\/\//i.test(host)) {
        const base = host.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
        return new URL(base.endsWith('/') ? 'node/conn' : '/node/conn', base).toString();
    }
    if (/^wss?:\/\//i.test(host)) {
        return new URL(host.endsWith('/') ? 'node/conn' : '/node/conn', host).toString();
    }
    return `wss://${host}/node/conn`;
}

function resolveUpstream(): string | null {
    const serverUrl = (config as any).server || '';
    const target = normalizeUpstreamFromHost(serverUrl) || process.env.NODE_UPSTREAM || '';
    return target || null;
}

function startNodeConnecting(ctx?: Context) {
    const url = resolveUpstream();
    if (!url) {
        logger.info('未配置 server，跳过连接。node 将独立工作，使用本地 Broker。');
        return () => {};
    }
    
    // 如果配置了 server，但显式禁用了上游连接（通过环境变量）
    if (process.env.DISABLE_NODE_UPSTREAM === '1' || process.env.DISABLE_NODE_UPSTREAM === 'true') {
        logger.info('已禁用 node 上游连接，node 将独立工作。');
        return () => {};
    }

    let WS: any;
    try {
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
    let connectTimeout: NodeJS.Timeout | null = null;
    let nodeId = `node_${require('os').hostname()}_${Date.now()}`;

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return;
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
        if (connecting) {
            logger.debug?.('已有连接尝试进行中，跳过本次 connect');
            return;
        }
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) {
            logger.debug?.('当前连接尚未关闭，跳过本次 connect');
            return;
        }
        connecting = true;
        logger.info('尝试连接 server：%s', url);

        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }

        connectTimeout = setTimeout(() => {
            if (ws && ws.readyState !== WS.OPEN && ws.readyState !== WS.CLOSED) {
                logger.error('连接超时（15秒），可能是服务器未响应');
                try {
                    ws.close();
                } catch {}
                connecting = false;
                scheduleReconnect();
            }
            connectTimeout = null;
        }, 18000);

        const wsOptions: any = {
            handshakeTimeout: 15000,
            perMessageDeflate: false,
            maxReconnects: 0,
        };

        ws = new WS(url, wsOptions);

        ws.on('open', () => {
            logger.success('已连接到 server');
            connecting = false;
            retryDelay = 3000;
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }

            // 发送初始化消息，请求 Broker 配置
            try {
                ws.send(JSON.stringify({ type: 'init', nodeId }));
            } catch (e) {
                logger.error('发送初始化消息失败: %s', (e as Error).message);
            }
        });

        ws.on('message', (data: any) => {
            try {
                const text = typeof data === 'string' ? data : data.toString('utf8');
                const msg = JSON.parse(text);

                // 处理 Broker 配置
                if (msg.type === 'broker-config') {
                    logger.info('收到 server Broker 配置: %s', msg.mqttUrl);
                    // 更新 zigbee2mqtt service 的 MQTT 连接配置
                    if (ctx) {
                        ctx.inject(['zigbee2mqtt'], (c) => {
                            const z2mService = c.zigbee2mqtt as Zigbee2MqttService;
                            if (z2mService) {
                                // 重新连接 MQTT（使用 server 的 Broker）
                                z2mService.connectToBroker(msg.mqttUrl, {
                                    baseTopic: msg.baseTopic,
                                    username: msg.username,
                                    password: msg.password,
                                }).catch((e: Error) => {
                                    logger.error('连接 server Broker 失败: %s', e.message);
                                });
                            }
                        }).catch((e: Error) => {
                            logger.error('获取 zigbee2mqtt service 失败: %s', e.message);
                        });
                    }
                    return;
                }

                // 转发设备控制指令（如果有）
                if (msg.type === 'device-control' && ctx) {
                    ctx.inject(['zigbee2mqtt'], (c) => {
                        try {
                            const z2mService = c.zigbee2mqtt as Zigbee2MqttService;
                            if (z2mService && msg.deviceId && msg.payload) {
                                z2mService.setDeviceState(msg.deviceId, msg.payload).catch((e: Error) => {
                                    logger.error('控制设备失败: %s', e.message);
                                });
                            }
                        } catch (e) {
                            logger.error('设备控制错误: %s', (e as Error).message);
                        }
                    }).catch(() => {});
                }
            } catch (e) {
                logger.warn('解析 server 消息失败: %s', (e as Error).message);
            }
        });

        ws.on('error', (err: Error) => {
            logger.warn('WebSocket 错误: %s', err.message);
            connecting = false;
            scheduleReconnect();
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('与 server 的连接已断开: %s %s', code, reason?.toString?.() || '');
            connecting = false;
            ws = null;
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            if (!stopped) {
                scheduleReconnect();
            }
        });
    };

    connect();

    return () => {
        stopped = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        if (ws) {
            try {
                ws.close();
            } catch {}
            ws = null;
        }
    };
}

export async function apply(ctx: Context) {
    startNodeConnecting(ctx);
}

