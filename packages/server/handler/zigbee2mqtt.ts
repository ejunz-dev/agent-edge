// @ts-nocheck
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import Zigbee2MqttService from '../service/zigbee2mqtt';

class Z2MStatusHandler extends Handler<Context> {
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

class Z2MDevicesHandler extends Handler<Context> {
    async get() {
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            const list = svc ? await svc.listDevices() : [];
            this.response.body = { devices: list };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        });
    }
}

class Z2MControlHandler extends Handler<Context> {
    async post(deviceId: string) {
        await this.ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt as Zigbee2MqttService;
            try {
                const paramsId = (this as any).request?.params?.deviceId;
                const id = typeof paramsId === 'string' ? paramsId : (typeof deviceId === 'string' ? deviceId : String(paramsId || deviceId || ''));
                const body = this.request.body || {};
                console.debug('[z2m-control] deviceId=%s body=%o', id, body);
                await svc.setDeviceState(id, body);
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

export async function apply(ctx: Context) {
    ctx.Route('z2m-status', '/zigbee2mqtt/status', Z2MStatusHandler);
    ctx.Route('z2m-devices', '/zigbee2mqtt/devices', Z2MDevicesHandler);
    ctx.Route('z2m-control', '/zigbee2mqtt/device/:deviceId', Z2MControlHandler);
    ctx.Route('z2m-permit', '/zigbee2mqtt/permit_join', Z2MPermitJoinHandler);
    class Z2MCoordinatorHandler extends Handler<Context> {
        async get() {
            // zigbee2mqtt 服务不提供 coordinator 信息，返回空
            this.response.body = { coordinator: null };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-coordinator', '/zigbee2mqtt/coordinator', Z2MCoordinatorHandler);
    class Z2MPermitStatusHandler extends Handler<Context> {
        async get() {
            // zigbee2mqtt 服务不提供 permit status，返回默认值
            this.response.body = { enabled: false, remaining: 0 };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-permit-status', '/zigbee2mqtt/permit_status', Z2MPermitStatusHandler);

    class Z2MDeviceDebugHandler extends Handler<Context> {
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
        async get(deviceId: string) {
            // zigbee2mqtt 服务不提供 LQI 信息
            this.response.body = { error: 'not_supported' };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-device-lqi', '/zigbee2mqtt/device/:deviceId/lqi', Z2MDeviceLqiHandler);
    class Z2MDeviceBasicHandler extends Handler<Context> {
        async get(deviceId: string) {
            // zigbee2mqtt 服务不提供 basic 信息
            this.response.body = { error: 'not_supported' };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-device-basic', '/zigbee2mqtt/device/:deviceId/basic', Z2MDeviceBasicHandler);
    
    // 工具执行 Handler：用于 Server 端调用 Node 工具
    class Z2MToolExecuteHandler extends Handler<Context> {
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
        async get() {
            // zigbee2mqtt 服务不提供适配器列表
            this.response.body = { candidates: [] };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-adapters', '/zigbee2mqtt/adapters', Z2MListAdaptersHandler);
    
    class Z2MAllDevicesRawHandler extends Handler<Context> {
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


