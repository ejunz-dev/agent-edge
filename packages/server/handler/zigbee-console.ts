// @ts-nocheck
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from 'cordis';
import * as path from 'node:path';
import * as fs from 'node:fs';
import ZigbeeHerdsmanService from '../service/zigbee-herdsman';

// WebSocket Handler：实时推送设备状态
export class ZigbeeConsoleConnectionHandler extends ConnectionHandler<Context> {
    static active = new Set<ZigbeeConsoleConnectionHandler>();
    private subscriptions: Array<{ dispose: () => void }> = [];

    async prepare() {
        ZigbeeConsoleConnectionHandler.active.add(this);
        this.send({ type: 'connected' });
        
        // 订阅 zigbee 事件
        await this.ctx.inject(['zigbee'], (c) => {
            const dispose1 = c.on('zigbee/connected', () => {
                this.send({ type: 'status', connected: true });
            });
            const dispose2 = c.on('zigbee/deviceJoined', (device: any) => {
                void this.refreshDevices();
            });
            const dispose3 = c.on('zigbee/deviceLeave', () => {
                void this.refreshDevices();
            });
            this.subscriptions.push({ dispose: dispose1 }, { dispose: dispose2 }, { dispose: dispose3 });
        });
        
        // 立即发送初始状态
        void this.sendInitialState();
    }

    async cleanup() {
        for (const sub of this.subscriptions) {
            try { sub.dispose(); } catch {}
        }
        this.subscriptions = [];
        ZigbeeConsoleConnectionHandler.active.delete(this);
    }

    async message(msg: any) {
        if (!msg || typeof msg !== 'object') return;
        const { type, payload } = msg;
        
        await this.ctx.inject(['zigbee'], async (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
            
            switch (type) {
                case 'getStatus':
                    void this.sendStatus();
                    break;
                case 'getDevices':
                    void this.refreshDevices();
                    break;
                case 'getCoordinator':
                    void this.sendCoordinator();
                    break;
                case 'getPermitStatus':
                    void this.sendPermitStatus();
                    break;
                case 'permitJoin':
                    try {
                        await svc.permitJoin(!!payload?.value, Number(payload?.time || 120));
                        void this.sendPermitStatus();
                    } catch (e) {
                        this.send({ type: 'error', message: (e as Error).message });
                    }
                    break;
                case 'controlDevice':
                    try {
                        const deviceId = payload?.deviceId;
                        const state = payload?.state;
                        if (!deviceId) {
                            this.send({ type: 'controlResult', success: false, deviceId, error: '缺少设备ID' });
                            return;
                        }
                        console.log('[zigbee-console] 控制设备:', deviceId, state);
                        await svc.setDeviceState(deviceId, { state });
                        this.send({ type: 'controlResult', success: true, deviceId });
                    } catch (e) {
                        const errMsg = (e as Error).message || String(e);
                        console.error('[zigbee-console] 控制失败:', errMsg);
                        this.send({ type: 'controlResult', success: false, deviceId: payload?.deviceId, error: errMsg });
                    }
                    break;
            }
        });
    }

    private async sendInitialState() {
        await this.sendStatus();
        await this.sendCoordinator();
        await this.sendPermitStatus();
        await this.refreshDevices();
    }

    private async sendStatus() {
        await this.ctx.inject(['zigbee'], (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
            this.send({ 
                type: 'status', 
                connected: svc?.state.connected || false,
                error: svc?.state.lastError || '',
            });
        });
    }

    private async sendCoordinator() {
        await this.ctx.inject(['zigbee'], async (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
            const coord = await (svc as any).getCoordinator?.();
            this.send({ type: 'coordinator', coordinator: coord });
        });
    }

    private async sendPermitStatus() {
        await this.ctx.inject(['zigbee'], (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
            const status = (svc as any).getPermitStatus?.();
            this.send({ type: 'permitStatus', ...(status || { enabled: false, remaining: 0 }) });
        });
    }

    private async refreshDevices() {
        await this.ctx.inject(['zigbee'], async (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
            const devices = await svc.listDevices();
            this.send({ type: 'devices', devices });
        });
    }
}

// 广播设备更新给所有连接的客户端
export function broadcastZigbeeUpdate(ctx: Context, type: string, data: any) {
    for (const conn of ZigbeeConsoleConnectionHandler.active) {
        try {
            conn.send({ type, ...data });
        } catch {}
    }
}

// 前端页面 Handler
class ZigbeeConsolePage extends Handler<Context> {
    async get() {
        const htmlPath = path.join(__dirname, '../node/zigbee-console.html');
        if (fs.existsSync(htmlPath)) {
            this.response.type = 'text/html; charset=utf-8';
            this.response.addHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
            this.response.addHeader('Pragma', 'no-cache');
            this.response.addHeader('Expires', '0');
            const content = fs.readFileSync(htmlPath, 'utf8');
            // 确保文件内容完整
            if (!content.trim().endsWith('</html>')) {
                console.warn('[zigbee-console] HTML file may be incomplete');
            }
            this.response.body = content;
        } else {
            this.response.status = 404;
            this.response.body = 'zigbee-console.html not found';
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('zigbee-console', '/', ZigbeeConsolePage);
    ctx.Connection('zigbee-console-ws', '/zigbee-ws', ZigbeeConsoleConnectionHandler);
}
