// @ts-nocheck
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import Zigbee2MqttService from '../service/zigbee2mqtt';

class Z2MStatusHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        await this.ctx.inject(['zigbee2mqtt'], (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            this.response.body = {
                connected: svc?.state.connected || false,
                error: svc?.state.lastError || '',
                devicesCached: svc?.state.devices.length || 0,
            };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        });
    }
}

// 展开多端点设备为独立设备
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

class Z2MDevicesHandler extends Handler<Context> {
    noCheckPermView = true;
    async get() {
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            const list = svc ? await svc.listDevices() : [];
            // 展开多端点设备
            const expanded = expandMultiEndpointDevices(list);
            this.response.body = { devices: expanded };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        });
    }
}

class Z2MControlHandler extends Handler<Context> {
    noCheckPermView = true;
    notUsage = true;
    allowCors = true;
    async post(deviceId: string) {
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            try {
                const paramsId = (this as any).request?.params?.deviceId;
                const id = typeof paramsId === 'string' ? paramsId : (typeof deviceId === 'string' ? deviceId : String(paramsId || deviceId || ''));
                const body = this.request.body || {};
                
                // 检查是否为端点设备（格式：设备名_l1）
                let targetDeviceId = id;
                let controlCommand: any = { ...body };
                
                const endpointMatch = id.match(/^(.+)_(l\d+)$/);
                if (endpointMatch) {
                    // 提取原始设备ID和端点
                    targetDeviceId = endpointMatch[1];
                    const endpoint = endpointMatch[2];
                    
                    // 如果 body 中有 state 属性，转换为端点特定的命令
                    if (body.state !== undefined) {
                        controlCommand = { [`state_${endpoint}`]: body.state };
                        // 删除通用的 state 属性
                        delete controlCommand.state;
                    }
                    
                    console.debug('[z2m-control] 端点控制: 设备=%s, 端点=%s, 原始命令=%o, 转换后命令=%o', targetDeviceId, endpoint, body, controlCommand);
                } else {
                    console.debug('[z2m-control] 普通控制: deviceId=%s body=%o', id, body);
                }
                
                await svc.setDeviceState(targetDeviceId, controlCommand);
                this.response.body = { ok: 1 };
            } catch (err) {
                this.response.status = 400;
                this.response.body = { error: (err as Error).message };
            }
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        });
    }
}

class Z2MPermitJoinHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    async post() {
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            const body = this.request.body || {};
            const value = !!body.value;
            const time = Number(body.time || 120);
            await svc.permitJoin(value, time);
            this.response.body = { ok: 1 };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        });
    }
}

class Z2MRefreshDevicesHandler extends Handler<Context> {
    noCheckPermView = true;
    allowCors = true;
    async post() {
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            try {
                // 强制刷新设备列表
                const devices = await svc.refreshDevices(10000);
                
                // 触发 zigbee2mqtt/devices 事件，让 node client 重新构建动态工具
                this.ctx.parallel('zigbee2mqtt/devices', devices);
                
                this.response.body = { 
                    ok: 1, 
                    message: '设备列表已刷新',
                    count: devices.length 
                };
            } catch (e) {
                this.response.status = 500;
                this.response.body = { error: (e as Error).message };
            }
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('z2m-status', '/zigbee2mqtt/status', Z2MStatusHandler);
    ctx.Route('z2m-devices', '/zigbee2mqtt/devices', Z2MDevicesHandler);
    ctx.Route('z2m-control', '/zigbee2mqtt/device/:deviceId', Z2MControlHandler);
    ctx.Route('z2m-permit', '/zigbee2mqtt/permit_join', Z2MPermitJoinHandler);
    ctx.Route('z2m-refresh', '/zigbee2mqtt/refresh', Z2MRefreshDevicesHandler);
    class Z2MCoordinatorHandler extends Handler<Context> {
        noCheckPermView = true;
        async get() {
            // zigbee2mqtt 服务不提供 coordinator 信息，返回空
            this.response.body = { coordinator: null };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-coordinator', '/zigbee2mqtt/coordinator', Z2MCoordinatorHandler);
    class Z2MPermitStatusHandler extends Handler<Context> {
        noCheckPermView = true;
        async get() {
            // zigbee2mqtt 服务不提供 permit status，返回默认值
            this.response.body = { enabled: false, remaining: 0 };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-permit-status', '/zigbee2mqtt/permit_status', Z2MPermitStatusHandler);

    class Z2MDeviceDebugHandler extends Handler<Context> {
        noCheckPermView = true;
        async get(deviceId: string) {
            await this.ctx.inject(['zigbee2mqtt'], async (c) => {
                const svc = c.zigbee2mqtt as Zigbee2MqttService;
                // 确保 deviceId 是字符串
                const id = typeof deviceId === 'string' ? deviceId : String(deviceId || '');
                const devices = await svc.listDevices();
                const device = devices.find((d: any) => 
                    d.friendly_name === id || 
                    d.ieee_address === id ||
                    String(d.friendly_name).toLowerCase() === String(id).toLowerCase()
                );
                if (device) {
                    this.response.body = device;
                } else {
                    this.response.body = { error: 'not_found', deviceId: id, known: devices };
                }
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-device-debug', '/zigbee2mqtt/device/:deviceId/debug', Z2MDeviceDebugHandler);
    class Z2MDeviceLqiHandler extends Handler<Context> {
        noCheckPermView = true;
        async get(deviceId: string) {
            // zigbee2mqtt 服务不提供 LQI 信息
            this.response.body = { error: 'not_supported' };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-device-lqi', '/zigbee2mqtt/device/:deviceId/lqi', Z2MDeviceLqiHandler);
    class Z2MDeviceBasicHandler extends Handler<Context> {
        noCheckPermView = true;
        async get(deviceId: string) {
            // zigbee2mqtt 服务不提供 basic 信息
            this.response.body = { error: 'not_supported' };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-device-basic', '/zigbee2mqtt/device/:deviceId/basic', Z2MDeviceBasicHandler);
    
    // 工具执行 Handler：用于 Server 端调用 Node 工具
    class Z2MToolExecuteHandler extends Handler<Context> {
        noCheckPermView = true;
        async post() {
            const body = this.request.body || {};
            const { toolName, arguments: args } = body;
            
            if (!toolName) {
                this.response.status = 400;
                this.response.body = { error: '缺少 toolName 参数' };
                this.response.addHeader('Access-Control-Allow-Origin', '*');
                return;
            }
            
            try {
                // 调用 Node 端的工具
                const { callNodeTool } = require('../mcp-tools/node');
                const result = await callNodeTool(this.ctx, { name: toolName, arguments: args || {} });
                this.response.body = { result };
            } catch (e) {
                this.response.status = 500;
                this.response.body = { error: (e as Error).message };
            }
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-tool-execute', '/zigbee2mqtt/tool/execute', Z2MToolExecuteHandler);
    
    class Z2MListAdaptersHandler extends Handler<Context> {
        noCheckPermView = true;
        async get() {
            // zigbee2mqtt 服务不提供适配器列表
            this.response.body = { candidates: [] };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-adapters', '/zigbee2mqtt/adapters', Z2MListAdaptersHandler);
    
    class Z2MAllDevicesRawHandler extends Handler<Context> {
        noCheckPermView = true;
        async get() {
            await this.ctx.inject(['zigbee2mqtt'], async (c) => {
                const svc = c.zigbee2mqtt as Zigbee2MqttService;
                const devices = await svc.listDevices();
                this.response.body = {
                    count: devices.length,
                    devices: devices.map((d: any) => ({
                        ieee_address: d.ieee_address,
                        friendly_name: d.friendly_name,
                        type: d.type,
                        definition: d.definition,
                        lastSeen: d.lastSeen,
                    })),
                };
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-all-raw', '/zigbee2mqtt/all_devices_raw', Z2MAllDevicesRawHandler);
}

