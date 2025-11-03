// @ts-nocheck
import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import ZigbeeHerdsmanService from '../service/zigbee-herdsman';

class Z2MStatusHandler extends Handler<Context> {
    async get() {
        await this.ctx.inject(['zigbee'], (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
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
        await this.ctx.inject(['zigbee'], async (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
            const list = svc ? await svc.listDevices() : [];
            this.response.body = { devices: list };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        });
    }
}

class Z2MControlHandler extends Handler<Context> {
    async post(deviceId: string) {
        await this.ctx.inject(['zigbee'], async (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
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
        await this.ctx.inject(['zigbee'], async (c) => {
            const svc = c.zigbee as ZigbeeHerdsmanService;
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
            await this.ctx.inject(['zigbee'], async (c) => {
                const svc = c.zigbee as ZigbeeHerdsmanService;
                const info = await (svc as any).getCoordinator?.();
                this.response.body = { coordinator: info };
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-coordinator', '/zigbee2mqtt/coordinator', Z2MCoordinatorHandler);
    class Z2MPermitStatusHandler extends Handler<Context> {
        async get() {
            await this.ctx.inject(['zigbee'], async (c) => {
                const svc = c.zigbee as ZigbeeHerdsmanService;
                const status = (svc as any).getPermitStatus?.();
                this.response.body = status || { enabled: false, remaining: 0 };
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-permit-status', '/zigbee2mqtt/permit_status', Z2MPermitStatusHandler);

    class Z2MDeviceDebugHandler extends Handler<Context> {
        async get(deviceId: string) {
            await this.ctx.inject(['zigbee'], async (c) => {
                const svc = c.zigbee as ZigbeeHerdsmanService;
                // 确保 deviceId 是字符串
                const id = typeof deviceId === 'string' ? deviceId : String(deviceId || '');
                const info = await (svc as any).getDeviceDebug?.(id);
                if (info && Object.keys(info).length && !info.error) {
                    this.response.body = info;
                } else {
                    const known = await (svc as any).listDevices?.();
                    this.response.body = { error: 'not_found', deviceId: id, known };
                }
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-device-debug', '/zigbee2mqtt/device/:deviceId/debug', Z2MDeviceDebugHandler);
    class Z2MDeviceLqiHandler extends Handler<Context> {
        async get(deviceId: string) {
            await this.ctx.inject(['zigbee'], async (c) => {
                const svc = c.zigbee as ZigbeeHerdsmanService;
                const id = typeof deviceId === 'string' ? deviceId : String(deviceId || '');
                const info = await (svc as any).getDeviceLqi?.(id);
                this.response.body = info || {};
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-device-lqi', '/zigbee2mqtt/device/:deviceId/lqi', Z2MDeviceLqiHandler);
    class Z2MDeviceBasicHandler extends Handler<Context> {
        async get(deviceId: string) {
            await this.ctx.inject(['zigbee'], async (c) => {
                const svc = c.zigbee as ZigbeeHerdsmanService;
                const id = typeof deviceId === 'string' ? deviceId : String(deviceId || '');
                const info = await (svc as any).getDeviceBasic?.(id);
                this.response.body = info || {};
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-device-basic', '/zigbee2mqtt/device/:deviceId/basic', Z2MDeviceBasicHandler);
    class Z2MListAdaptersHandler extends Handler<Context> {
        async get() {
            const svc = (this.ctx as any).zigbee as any;
            const list = svc?.listCandidateSerialPorts?.() || [];
            this.response.body = { candidates: list };
            this.response.addHeader('Access-Control-Allow-Origin', '*');
        }
    }
    ctx.Route('z2m-adapters', '/zigbee2mqtt/adapters', Z2MListAdaptersHandler);
    
    class Z2MAllDevicesRawHandler extends Handler<Context> {
        async get() {
            await this.ctx.inject(['zigbee'], async (c) => {
                const svc = c.zigbee as ZigbeeHerdsmanService;
                const herdsman = (svc as any).herdsman;
                if (!herdsman) {
                    this.response.body = { error: 'not_connected' };
                    this.response.addHeader('Access-Control-Allow-Origin', '*');
                    return;
                }
                const all = herdsman.getDevices?.() || [];
                this.response.body = {
                    count: all.length,
                    devices: all.map((d: any) => ({
                        ieeeAddr: d.ieeeAddr,
                        type: d.type,
                        interviewCompleted: d.interviewCompleted,
                        lastSeen: d.lastSeen,
                        endpoints: (d.endpoints || []).map((ep: any) => ({
                            id: ep?.ID,
                            inputClusters: ep?.getInputClusters?.() || ep?.inputClusters || [],
                        })),
                        definition: d.definition ? {
                            model: d.definition.model,
                            vendor: d.definition.vendor,
                        } : null,
                    })),
                };
                this.response.addHeader('Access-Control-Allow-Origin', '*');
            });
        }
    }
    ctx.Route('z2m-all-raw', '/zigbee2mqtt/all_devices_raw', Z2MAllDevicesRawHandler);
    // 移除进程管理接口（不再需要，因为直接作为库使用）
}


