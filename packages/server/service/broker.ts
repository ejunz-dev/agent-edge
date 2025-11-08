// @ts-nocheck
import { Context, Service } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';

export default class BrokerService extends Service<Context> {
    private readonly logger = new Logger('broker');
    private aedes?: any;
    private server?: import('net').Server;
    private wsServer?: any;

    async [Service.init](): Promise<void> {
        const nodeMode = process.argv.includes('--node');
        const brokerConf = (config as any).broker || {};
        const enabled = nodeMode ? (brokerConf.enabled ?? true) : (brokerConf.enabled ?? false);
        if (!enabled) return;
        let aedes: any;
        try { aedes = require('aedes')(); } catch (e) {
            this.logger.error('缺少依赖 aedes，请先安装：yarn add -W aedes');
            return;
        }
        const net = require('node:net');
        const port = brokerConf.port || 1883;
        this.aedes = aedes;
        this.server = net.createServer(aedes.handle);
        this.server.listen(port, '0.0.0.0', () => this.logger.success(`MQTT Broker started at 0.0.0.0:${port}`));
        
        // 启动 WebSocket 服务器
        const wsPort = brokerConf.wsPort || 8083;
        let ws: any;
        try {
            ws = require('ws');
        } catch (e) {
            this.logger.warn('缺少依赖 ws，WebSocket 服务器未启动。如需 WebSocket 支持，请安装：yarn add -W ws');
            return;
        }
        
        const http = require('http');
        const httpServer = http.createServer();
        this.wsServer = new ws.Server({ 
            server: httpServer,
            path: '/mqtt'
        });
        
        httpServer.listen(wsPort, '0.0.0.0', () => {
            this.logger.success(`MQTT WebSocket Broker started at ws://0.0.0.0:${wsPort}/mqtt`);
        });
        
        this.wsServer.on('connection', (wsClient: any, req: any) => {
            const stream = ws.createWebSocketStream(wsClient);
            aedes.handle(stream);
            this.logger.info(`WebSocket client connected from ${req.socket.remoteAddress}`);
        });
        aedes.on('client', (c: any) => {
            // 尝试从多个地方获取 keepalive 值
            // 注意：在 aedes 中，keepalive 可能在连接包中，需要从连接时的数据获取
            const keepalive = c?.keepalive || c?.keepAlive || (c?.conn?.protocol?.keepalive) || 'N/A';
            this.logger.info(`client connected: ${c?.id || ''} (username: ${c?.username || 'none'}, keepalive: ${keepalive})`);
            
            // 记录连接时的详细信息
            const connInfo = {
                id: c?.id,
                username: c?.username,
                keepalive: keepalive,
                keepaliveRaw: c?.keepalive,
                keepAliveRaw: c?.keepAlive,
                connReadable: c?.conn?.readable,
                connWritable: c?.conn?.writable,
                connDestroyed: c?.conn?.destroyed,
                protocolVersion: c?.protocolVersion,
                // 尝试从连接对象获取更多信息
                connProtocol: c?.conn?.protocol,
            };
            this.logger.debug(`client connection details: ${JSON.stringify(connInfo)}`);
            
            // 监听客户端发送的第一个包（通常是 CONNECT）
            if (c?.conn) {
                const originalWrite = c.conn.write;
                let firstPacket = true;
                c.conn.write = function(...args: any[]) {
                    if (firstPacket) {
                        firstPacket = false;
                        // 这里可以记录第一个写入的数据包信息
                    }
                    return originalWrite.apply(this, args);
                };
            }
            
            // 设置定时器，定期检查连接状态
            const checkInterval = setInterval(() => {
                if (!c?.conn || c?.conn?.destroyed) {
                    clearInterval(checkInterval);
                    return;
                }
                this.logger.debug(`client connection check [${c?.id || ''}]: readable=${c?.conn?.readable}, writable=${c?.conn?.writable}, destroyed=${c?.conn?.destroyed}`);
            }, 5000); // 每5秒检查一次
            
            // 清理定时器
            c.on('close', () => {
                clearInterval(checkInterval);
            });
            
            // 监听客户端连接错误
            c.on('error', (err: Error) => {
                this.logger.error(`client connection error [${c?.id || ''}]: ${err.message}`);
                if (err.stack) {
                    this.logger.debug(`error stack: ${err.stack}`);
                }
            });
            
            // 监听客户端关闭
            c.on('close', () => {
                this.logger.warn(`client connection closed [${c?.id || ''}] - connection readable: ${c?.conn?.readable}, writable: ${c?.conn?.writable}, destroyed: ${c?.conn?.destroyed}`);
            });
            
            // 监听客户端断开
            c.on('disconnect', (packet: any) => {
                this.logger.warn(`client disconnect packet [${c?.id || ''}]: reasonCode=${packet?.reasonCode || 'unknown'}, packet=${JSON.stringify(packet || {})}`);
            });
            
            // 监听连接结束
            if (c?.conn) {
                c.conn.on('end', () => {
                    this.logger.warn(`client connection ended [${c?.id || ''}]`);
                });
                
                c.conn.on('error', (err: Error) => {
                    this.logger.error(`client connection socket error [${c?.id || ''}]: ${err.message}`);
                });
            }
        });
        aedes.on('clientDisconnect', (c: any) => {
            let reason = 'unknown';
            if (c?.disconnected) {
                reason = 'disconnected';
            } else if (c?.conn?.destroyed) {
                reason = 'connection destroyed';
            } else if (c?.conn?.readable === false) {
                reason = 'connection not readable';
            } else if (c?.conn?.writable === false) {
                reason = 'connection not writable';
            }
            
            // 记录更多调试信息
            const debugInfo: any = {
                id: c?.id || 'unknown',
                disconnected: c?.disconnected,
                connDestroyed: c?.conn?.destroyed,
                connReadable: c?.conn?.readable,
                connWritable: c?.conn?.writable,
                keepalive: c?.keepalive,
            };
            
            this.logger.info(`client disconnected: ${c?.id || ''} (reason: ${reason}, debug: ${JSON.stringify(debugInfo)})`);
        });
        aedes.on('clientError', (c: any, err: Error) => {
            this.logger.error(`client error: ${c?.id || ''} - ${err.message}`);
            if (err.stack) {
                this.logger.debug(`error stack: ${err.stack}`);
            }
        });
        aedes.on('clientReady', (c: any) => {
            this.logger.info(`client ready: ${c?.id || ''}`);
            // 记录就绪时的连接状态
            this.logger.debug(`client ready details [${c?.id || ''}]: readable=${c?.conn?.readable}, writable=${c?.conn?.writable}, destroyed=${c?.conn?.destroyed}`);
            
            // 尝试从客户端对象获取 CONNECT 包信息
            // 在 aedes 中，CONNECT 包信息可能在客户端对象的其他属性中
            if (c?.conn?.protocol) {
                const protocol = c.conn.protocol;
                this.logger.info(`Protocol info for [${c?.id || ''}]: keepalive=${protocol.keepalive || 'N/A'}, protocolVersion=${protocol.protocolVersion || 'N/A'}`);
            }
            
            // 尝试从客户端对象本身获取 keepalive
            if (c?.keepalive !== undefined) {
                this.logger.info(`Client keepalive for [${c?.id || ''}]: ${c.keepalive}`);
            }
        });
        aedes.on('subscribe', (subscriptions: any[], client: any) => {
            const topics = subscriptions.map((s: any) => `${s.topic} (qos: ${s.qos})`).join(', ');
            this.logger.info(`client subscribe [${client?.id || ''}]: ${topics}`);
        });
        
        aedes.on('unsubscribe', (unsubscriptions: string[], client: any) => {
            this.logger.info(`client unsubscribe [${client?.id || ''}]: ${unsubscriptions.join(', ')}`);
        });
        
        // 监听客户端心跳（ping）
        aedes.on('ping', (packet: any, client: any) => {
            this.logger.debug(`client ping [${client?.id || ''}]`);
        });
        
        // 监听客户端心跳响应（pong）
        aedes.on('pong', (packet: any, client: any) => {
            this.logger.debug(`client pong [${client?.id || ''}]`);
        });
        
        aedes.on('publish', (p: any, c: any) => {
            if (p?.topic?.startsWith('$SYS')) return;
            this.logger.debug?.('publish %s bytes=%s by=%s', p?.topic, p?.payload?.length || 0, c?.id || '-');
        });
    }

    async [Service.dispose](): Promise<void> {
        try { await new Promise((r) => this.server?.close(() => r(null))); } catch {}
        try { await new Promise((r) => this.wsServer?.close(() => r(null))); } catch {}
        try { this.aedes?.close?.(); } catch {}
        this.server = undefined;
        this.wsServer = undefined;
        this.aedes = undefined;
    }
}


