// @ts-nocheck
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from 'cordis';
import * as path from 'node:path';
import * as fs from 'node:fs';
import Zigbee2MqttService from '../service/zigbee2mqtt';

// 展开多端点设备为独立设备（与 zigbee2mqtt.ts 中的函数相同）
function expandMultiEndpointDevices(devices: any[]): any[] {
    const expanded: any[] = [];
    
    for (const device of devices) {
        // 检测端点
        const endpoints: string[] = [];
        
        // 从 definition.exposes 检测端点
        if (device.definition?.exposes) {
            for (const expose of device.definition.exposes) {
                if (expose.endpoint) {
                    endpoints.push(expose.endpoint);
                }
                if (expose.features && Array.isArray(expose.features)) {
                    for (const feature of expose.features) {
                        if (feature.endpoint && !endpoints.includes(feature.endpoint)) {
                            endpoints.push(feature.endpoint);
                        }
                    }
                }
            }
        }
        
        // 从 state 检测端点（state_l1, state_l2 等）
        if (device.state) {
            for (const key of Object.keys(device.state)) {
                const match = key.match(/^state_l(\d+)$/);
                if (match) {
                    const endpoint = `l${match[1]}`;
                    if (!endpoints.includes(endpoint)) {
                        endpoints.push(endpoint);
                    }
                }
            }
        }
        
        // 如果有多个端点，展开为多个设备
        if (endpoints.length > 0) {
            const baseId = device.friendly_name || device.ieee_address;
            for (const endpoint of endpoints.sort()) {
                const endpointDevice = {
                    ...device,
                    friendly_name: `${baseId}_${endpoint}`,
                    endpoint: endpoint,
                    originalDeviceId: baseId,
                    isEndpointDevice: true,
                    // 提取该端点的状态
                    state: {
                        ...device.state,
                        state: device.state?.[`state_${endpoint}`] || device.state?.state || 'OFF',
                    },
                };
                expanded.push(endpointDevice);
            }
        } else {
            // 单端点设备，直接添加
            expanded.push(device);
        }
    }
    
    return expanded;
}

// WebSocket Handler：实时推送设备状态
export class ZigbeeConsoleConnectionHandler extends ConnectionHandler<Context> {
    static active = new Set<ZigbeeConsoleConnectionHandler>();
    private subscriptions: Array<{ dispose: () => void }> = [];

    async prepare() {
        ZigbeeConsoleConnectionHandler.active.add(this);
        this.send({ type: 'connected' });
        
        // 订阅 zigbee2mqtt 事件
        await this.ctx.inject(['zigbee2mqtt'], (c) => {
            const dispose1 = c.on('zigbee2mqtt/connected', () => {
                this.send({ type: 'status', connected: true });
            });
            const dispose2 = c.on('zigbee2mqtt/devices', () => {
                void this.refreshDevices();
            });
            // 实时推送单个设备状态更新（而不是刷新整个列表）
            const dispose3 = c.on('zigbee2mqtt/deviceState', async (deviceId: string, state: any) => {
                // 获取更新后的设备信息
                await this.ctx.inject(['zigbee2mqtt'], async (c) => {
                    const svc = c.zigbee2mqtt as Zigbee2MqttService;
                    const devices = await svc.listDevices();
                    const device = devices.find((d: any) => 
                        (d.friendly_name === deviceId) || (d.ieee_address === deviceId)
                    );
                    if (device) {
                        // 展开多端点设备，然后发送所有相关端点的更新
                        const expanded = expandMultiEndpointDevices([device]);
                        for (const endpointDevice of expanded) {
                            this.send({ 
                                type: 'deviceState', 
                                deviceId: endpointDevice.friendly_name, 
                                device: endpointDevice, 
                                state: endpointDevice.state 
                            });
                        }
                    }
                });
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
        
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            
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
                        
                        // 检查是否为端点设备（格式：设备名_l1）
                        let targetDeviceId = deviceId;
                        let controlCommand: any = { state };
                        const endpointMatch = deviceId.match(/^(.+)_(l\d+)$/);
                        if (endpointMatch) {
                            targetDeviceId = endpointMatch[1];
                            const endpoint = endpointMatch[2];
                            controlCommand = { [`state_${endpoint}`]: state };
                            console.log('[zigbee-console] 端点控制: 设备=%s, 端点=%s, 命令=%o', targetDeviceId, endpoint, controlCommand);
                        }
                        
                        await svc.setDeviceState(targetDeviceId, controlCommand);
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
        await this.ctx.inject(['zigbee2mqtt'], (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            this.send({ 
                type: 'status', 
                connected: svc?.state.connected || false,
                error: svc?.state.lastError || '',
            });
        });
    }

    private async sendCoordinator() {
        // zigbee2mqtt 服务不提供 coordinator 信息
        this.send({ type: 'coordinator', coordinator: null });
    }

    private async sendPermitStatus() {
        // zigbee2mqtt 服务不提供 permit status
        this.send({ type: 'permitStatus', enabled: false, remaining: 0 });
    }

    private async refreshDevices() {
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            const devices = await svc.listDevices();
            // 展开多端点设备
            const expanded = expandMultiEndpointDevices(devices);
            this.send({ type: 'devices', devices: expanded });
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
    noCheckPermView = true;
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
    ctx.Route('zigbee-console', '/zigbee-console', ZigbeeConsolePage);
    ctx.Connection('zigbee-console-ws', '/zigbee-ws', ZigbeeConsoleConnectionHandler);
}
