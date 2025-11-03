// @ts-nocheck
import { Context, Service } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';

type DeviceInfo = Record<string, any>;

export interface ZigbeeState {
    connected: boolean;
    lastError?: string;
    devices: DeviceInfo[];
}

declare module 'cordis' {
    interface Context {
        zigbee: ZigbeeHerdsmanService;
    }
}

export default class ZigbeeHerdsmanService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'zigbee');
        ctx.mixin('zigbee', ['listCandidateSerialPorts', 'listDevices', 'setDeviceState', 'permitJoin', 'getCoordinator']);
    }

    public state: ZigbeeState = { connected: false, devices: [] };
    private herdsman?: any;
    private readonly logger = new Logger('zigbee');
    private permitJoinTimer?: NodeJS.Timeout;
    private permitJoinUntil?: number;
    private devfs = require('node:fs');

    private listCandidateSerialPorts(): string[] {
        try {
            const entries = this.devfs.readdirSync('/dev');
            const match = (re: RegExp) => entries.filter((n: string) => re.test(n)).map((n: string) => `/dev/${n}`);
            // 常见 Zigbee 适配器端口：ttyUSB*, ttyACM*
            const usb = match(/^ttyUSB\d+$/);
            const acm = match(/^ttyACM\d+$/);
            const ama = match(/^ttyAMA\d+$/);
            const ttyS = match(/^ttyS[0-9]+$/);
            return [...usb, ...acm, ...ama, ...ttyS].slice(0, 20);
        } catch {
            return ['/dev/ttyUSB0', '/dev/ttyACM0'];
        }
    }

    private pickAdapterPath(configured?: string): string[] {
        if (configured && configured !== 'auto') return [configured];
        const candidates = this.listCandidateSerialPorts();
        if (configured === 'auto') return candidates;
        // 未配置时优先常见口再补充候选
        const defaults = ['/dev/ttyUSB0', '/dev/ttyACM0'];
        const set = new Set<string>([...defaults, ...candidates]);
        return Array.from(set);
    }

    async [Service.init](): Promise<void> {
        if (!config.zigbee2mqtt?.enabled) {
            this.logger.info('zigbee disabled');
            return;
        }

        try {
            const { Controller } = require('zigbee-herdsman');
            const pathsToTry = this.pickAdapterPath(config.zigbee2mqtt?.adapter);
            let lastErr: any = null;
            for (const adapterPath of pathsToTry) {
                try {
                    this.logger.info('initializing zigbee adapter: %s', adapterPath);
                    this.herdsman = new Controller({
                        adapter: {
                            type: 'zstack', // 默认使用 zstack，如需其他类型可在配置中指定
                            port: {
                                path: adapterPath,
                                baudRate: 115200,
                                rtscts: true,
                            },
                        },
                        databasePath: './data/zigbee.db',
                        network: {
                            panID: 0x1a62,
                            extendedPanID: [0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD],
                            channelList: [11],
                            networkKey: [0x01, 0x03, 0x05, 0x07, 0x09, 0x0B, 0x0D, 0x0F, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0A, 0x0C, 0x0D],
                        },
                    });
                    await this.herdsman.start();
                    this.state.connected = true;
                    this.logger.success('zigbee adapter connected: %s', adapterPath);
                    try { this.ctx.parallel('zigbee/connected', adapterPath); } catch {}
                    await this.refreshDevices();
                    // 打印协调器地址
                    const coord = await this.getCoordinator();
                    if (coord?.ieee_address) {
                        this.logger.info('coordinator ieee: %s', coord.ieee_address);
                    }
                    lastErr = null;
                    break;
                } catch (e) {
                    lastErr = e;
                    this.logger.warn('zigbee init failed on %s: %s', adapterPath, (e as Error).message);
                    try { await this.herdsman?.stop?.(); } catch {}
                    this.herdsman = undefined;
                }
            }
            if (lastErr && !this.state.connected) throw lastErr;

            this.herdsman?.on('deviceJoined', (data: any) => {
                const device = data?.device || data;
                const addr = device?.ieeeAddr || device?.ieee_address || 'unknown';
                this.logger.info('device joined: %s', addr);
                void this.refreshDevices();
                try { this.ctx.parallel('zigbee/deviceJoined', device); } catch {}
            });

            this.herdsman?.on('deviceLeave', (data: any) => {
                const ieeeAddr = typeof data === 'string' ? data : (data?.ieeeAddr || data?.ieee_address || 'unknown');
                this.logger.info('device left: %s', ieeeAddr);
                void this.refreshDevices();
                try { this.ctx.parallel('zigbee/deviceLeave', ieeeAddr); } catch {}
            });

            this.herdsman?.on('deviceInterview', (data: any) => {
                const device = data?.device || data;
                const addr = device?.ieeeAddr || device?.ieee_address || 'unknown';
                this.logger.info('device interview: %s', addr);
                void this.refreshDevices();
            });
        } catch (e) {
            this.state.lastError = (e as Error).message;
            this.logger.error('zigbee init failed: %s', (e as Error).message);
        }
    }

    async [Service.dispose](): Promise<void> {
        if (this.permitJoinTimer) {
            clearTimeout(this.permitJoinTimer);
            this.permitJoinTimer = undefined;
        }
        if (this.herdsman) {
            try {
                await this.herdsman.stop();
            } catch {}
            this.herdsman = undefined;
        }
        this.state.connected = false;
    }

    async refreshDevices(): Promise<DeviceInfo[]> {
        if (!this.herdsman) return [];
        try {
            // Controller.getDevices() 获取所有设备，过滤掉协调器，仅保留可控（支持genOnOff）的设备
            const GEN_ONOFF_ID = 6;
            const hasOnOff = (ep: any): boolean => {
                try {
                    if (ep?.supportsInputCluster && ep.supportsInputCluster('genOnOff')) return true;
                    if (Array.isArray(ep?.inputClusters) && ep.inputClusters.includes(GEN_ONOFF_ID)) return true;
                    const names = (ep?.clusters || {})?.input || [];
                    if (Array.isArray(names) && names.includes('genOnOff')) return true;
                    const ids = ep?.getInputClusters?.();
                    if (Array.isArray(ids) && ids.includes(GEN_ONOFF_ID)) return true;
                } catch {}
                return false;
            };

            const raw = (this.herdsman.getDevices?.() || []).filter((d: any) => d.type !== 'Coordinator');
            const mapped = raw.map((d: any) => {
                const endpoints = d.endpoints || [];
                const supportsOnOff = endpoints.some((ep: any) => hasOnOff(ep));
                return {
                    ieee_address: d.ieeeAddr,
                    friendly_name: d.meta?.friendlyName || d.meta?.name || d.ieeeAddr,
                    definition: d.definition ? {
                        model: d.definition.model,
                        vendor: d.definition.vendor,
                    } : undefined,
                    powerSource: d.powerSource,
                    lastSeen: d.lastSeen,
                    interviewCompleted: d.interviewCompleted,
                    type: d.type,
                    supportsOnOff,
                };
            });
            // 仅显示真正可控且面试完成的设备
            this.state.devices = mapped.filter((d: any) => d.interviewCompleted && d.supportsOnOff);
            return this.state.devices;
        } catch (e) {
            this.logger.error('refresh devices failed: %s', (e as Error).message);
            return [];
        }
    }

    async listDevices(): Promise<DeviceInfo[]> {
        // 强制刷新，不使用缓存，确保实时性
        return await this.refreshDevices();
    }

    async getCoordinator(): Promise<DeviceInfo | null> {
        if (!this.herdsman) return null;
        try {
            // 优先通过 devices 列表查找类型为 Coordinator 的设备
            const all = this.herdsman.getDevices?.() || [];
            const found = all.find((d: any) => d?.type === 'Coordinator');
            if (found) {
                return {
                    ieee_address: found.ieeeAddr,
                    type: 'Coordinator',
                    definition: found.definition ? {
                        model: found.definition.model,
                        vendor: found.definition.vendor,
                    } : undefined,
                };
            }
            // 兼容旧接口：getCoordinator()
            const coord = this.herdsman.getCoordinator?.();
            const device = coord?.device || coord;
            if (!device) return null;
            return {
                ieee_address: device.ieeeAddr,
                type: 'Coordinator',
                definition: device.definition ? {
                    model: device.definition.model,
                    vendor: device.definition.vendor,
                } : undefined,
            };
        } catch {
            return null;
        }
    }

    async setDeviceState(deviceId: string, payload: Record<string, any>): Promise<void> {
        if (!this.herdsman) throw new Error('zigbee not connected');
        // 使用 findDevice 方法进行更可靠的查找
        const device = this.findDevice(deviceId);
        if (!device) {
            const all = this.herdsman.getDevices?.() || [];
            const known = all.map((d: any) => d.ieeeAddr).join(', ');
            throw new Error(`device not found: ${deviceId}, known devices: ${known}`);
        }
        
        // 不允许控制协调器
        if (device.type === 'Coordinator') {
            throw new Error('cannot control coordinator device');
        }

        // 查找支持 genOnOff 的端点（cluster 6）
        const GEN_ONOFF_ID = 6;
        const hasOnOff = (ep: any): boolean => {
            try {
                if (ep?.supportsInputCluster && ep.supportsInputCluster('genOnOff')) return true;
                if (Array.isArray(ep?.inputClusters) && ep.inputClusters.includes(GEN_ONOFF_ID)) return true;
                if (Array.isArray(ep?.outputClusters) && ep.outputClusters.includes(GEN_ONOFF_ID)) return true;
                const names = (ep?.clusters || {})?.input || [];
                if (Array.isArray(names) && names.includes('genOnOff')) return true;
                const getIds = ep?.getInputClusters?.();
                if (Array.isArray(getIds) && getIds.includes(GEN_ONOFF_ID)) return true;
            } catch {}
            return false;
        };

        let endpoint = null as any;
        const endpoints = device.endpoints || [];
        for (const ep of endpoints) {
            if (hasOnOff(ep)) { endpoint = ep; break; }
        }
        // 如果没找到，尝试使用端点 1
        if (!endpoint) {
            endpoint = device.getEndpoint(1);
        }
        if (!endpoint) throw new Error('no endpoint found or device does not support on/off control');

        // 处理 state 参数（ON/OFF）
        if (payload.state) {
            const state = String(payload.state).toUpperCase();
            const cluster = 'genOnOff';
            const command = state === 'ON' ? 'on' : (state === 'OFF' ? 'off' : 'toggle');
            try {
                await endpoint.command(cluster, command, {}, {});
                this.logger.info('set %s state = %s (endpoint %s)', deviceId, state, endpoint?.ID ?? 'unknown');
                return;
            } catch (e) {
                const epInfo = {
                    id: endpoint?.ID,
                    inputClusters: endpoint?.getInputClusters?.() || endpoint?.inputClusters,
                    outputClusters: endpoint?.getOutputClusters?.() || endpoint?.outputClusters,
                };
                this.logger.warn('set state failed on %s ep=%o: %s', deviceId, epInfo, (e as Error).message);
                throw new Error(`控制失败: ${(e as Error).message}`);
            }
        }

        // 其他参数使用 convertSet（如果可用）
        try {
            const { convertSet } = require('zigbee-herdsman-converters');
            for (const [key, value] of Object.entries(payload)) {
                try {
                    const result = convertSet(key, value, device.definition, device, endpoint);
                    if (result && result.cluster) {
                        if (result.type === 'command') {
                            await endpoint.command(result.cluster, result.command, result.data || {}, {});
                        } else {
                            await endpoint.write(result.cluster, result.attributes || {}, {});
                        }
                        this.logger.info('set %s.%s = %s', deviceId, key, value);
                    }
                } catch (e) {
                    this.logger.warn('set %s.%s failed: %s', deviceId, key, (e as Error).message);
                }
            }
        } catch (e) {
            this.logger.warn('convertSet not available, using direct command');
            throw new Error(`unsupported payload: ${JSON.stringify(payload)}`);
        }
    }

    async permitJoin(value: boolean, timeSec: number = 120): Promise<void> {
        if (!this.herdsman) throw new Error('zigbee not connected');
        
        if (this.permitJoinTimer) {
            clearTimeout(this.permitJoinTimer);
            this.permitJoinTimer = undefined;
        }

        // Controller 直接有 permitJoin 方法
        if (value) {
            await this.herdsman.permitJoin(timeSec);
            this.logger.info('permit join enabled for %d seconds', timeSec);
            this.permitJoinUntil = Date.now() + timeSec * 1000;
            if (timeSec > 0) {
                this.permitJoinTimer = setTimeout(() => {
                    void this.herdsman?.permitJoin?.(0);
                    this.logger.info('permit join disabled (timeout)');
                    this.permitJoinUntil = undefined;
                }, timeSec * 1000);
            }
        } else {
            await this.herdsman.permitJoin(0);
            this.logger.info('permit join disabled');
            this.permitJoinUntil = undefined;
        }
    }

    getPermitStatus() {
        const now = Date.now();
        const remainingMs = this.permitJoinUntil ? Math.max(0, this.permitJoinUntil - now) : 0;
        return {
            enabled: remainingMs > 0,
            remaining: Math.ceil(remainingMs / 1000),
        };
    }

    async getDeviceDebug(deviceId: string) {
        if (!this.herdsman) throw new Error('zigbee not connected');
        const all = this.herdsman.getDevices?.() || [];
        const norm = (s: any) => String(s || '').toLowerCase().trim();
        // 确保 deviceId 是字符串
        const idStr = typeof deviceId === 'string' ? deviceId : String(deviceId || '');
        const wanted = norm(idStr);
        
        // 尝试多种方式查找
        let device = this.herdsman.getDeviceByIeeeAddr?.(idStr);
        if (!device) device = this.herdsman.getDeviceByIeeeAddr?.(wanted);
        if (!device && idStr !== wanted) device = this.herdsman.getDeviceByIeeeAddr?.(idStr);
        if (!device) device = this.herdsman.getDeviceByName?.(idStr);
        
        // 如果还是没找到，遍历所有设备，精确匹配地址
        if (!device) {
            device = all.find((d: any) => {
                const addr = String(d?.ieeeAddr || '').toLowerCase().trim();
                const name = norm(d?.meta?.friendlyName || d?.meta?.name || '');
                // 精确匹配或去掉0x前缀后匹配
                const addrNoPrefix = addr.replace(/^0x/, '');
                const wantedNoPrefix = wanted.replace(/^0x/, '');
                return addr === wanted || 
                       addrNoPrefix === wantedNoPrefix ||
                       addr === ('0x' + wantedNoPrefix) ||
                       ('0x' + addrNoPrefix) === wanted ||
                       name === wanted;
            });
        }
        
        if (!device) {
            return { 
                error: 'not_found', 
                deviceId, 
                wanted,
                known: all.map((d: any) => ({ 
                    ieeeAddr: d?.ieeeAddr, 
                    type: d?.type,
                    friendlyName: d?.meta?.friendlyName || d?.meta?.name 
                })) 
            };
        }
        
        const endpoints = (device.endpoints || []).map((ep: any) => {
            try {
                return {
                    id: ep?.ID,
                    inputClusters: ep?.getInputClusters?.() || ep?.inputClusters || [],
                    outputClusters: ep?.getOutputClusters?.() || ep?.outputClusters || [],
                    clusters: ep?.clusters,
                    supportsOnOff: ep?.supportsInputCluster?.('genOnOff') || ep?.supportsInputCluster?.(6),
                };
            } catch (e) {
                return { id: ep?.ID, error: String(e) };
            }
        });
        
        return {
            ieee_address: device.ieeeAddr,
            type: device.type,
            definition: device.definition ? { 
                model: device.definition.model, 
                vendor: device.definition.vendor 
            } : undefined,
            endpoints,
            powerSource: device.powerSource,
            interviewCompleted: device.interviewCompleted,
        };
    }

    private findDevice(deviceId: string) {
        if (!this.herdsman) return null;
        const all = this.herdsman.getDevices?.() || [];
        const norm = (s: any) => String(s || '').toLowerCase().trim();
        const id = norm(deviceId);
        
        // 先尝试直接查找
        let device = this.herdsman.getDeviceByIeeeAddr?.(deviceId);
        if (!device && id !== deviceId) device = this.herdsman.getDeviceByIeeeAddr?.(id);
        if (!device) device = this.herdsman.getDeviceByName?.(deviceId);
        
        // 如果还没找到，遍历所有设备
        if (!device) {
            device = all.find((d: any) => {
                const addr = norm(d?.ieeeAddr || '');
                const friendly = norm(d?.meta?.friendlyName || d?.meta?.name || '');
                const addrNoPrefix = addr.replace(/^0x/, '');
                const idNoPrefix = id.replace(/^0x/, '');
                return addr === id || 
                       addrNoPrefix === idNoPrefix ||
                       addr === ('0x' + idNoPrefix) ||
                       ('0x' + addrNoPrefix) === id ||
                       friendly === id;
            });
        }
        return device || null;
    }

    async getDeviceLqi(deviceId: string) {
        if (!this.herdsman) throw new Error('zigbee not connected');
        const dev = this.findDevice(deviceId);
        if (!dev) return { error: 'not_found' };
        try {
            const lqi = await dev.lqi?.();
            const rt = await dev.routingTable?.();
            return { ieee_address: dev.ieeeAddr, lqi, routingTable: rt };
        } catch (e) {
            return { ieee_address: dev.ieeeAddr, error: String(e) };
        }
    }

    async getDeviceBasic(deviceId: string) {
        if (!this.herdsman) throw new Error('zigbee not connected');
        const dev = this.findDevice(deviceId);
        if (!dev) return { error: 'not_found' };
        try {
            const ep = dev.getEndpoint?.(1) || (dev.endpoints || [])[0];
            if (!ep) return { ieee_address: dev.ieeeAddr, error: 'no_endpoint' };
            const attrs = await ep.read('genBasic', ['modelId', 'manufacturerName', 'zclVersion', 'appVersion', 'stackVersion', 'hwVersion']);
            return { ieee_address: dev.ieeeAddr, attributes: attrs };
        } catch (e) {
            return { ieee_address: dev.ieeeAddr, error: String(e) };
        }
    }
}

