// @ts-nocheck
import { Context, Service } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';
import childProcess from 'node:child_process';

let mqtt: typeof import('mqtt') | null = null;

type DeviceInfo = Record<string, any>;

export interface Zigbee2MqttState {
    connected: boolean;
    lastError?: string;
    devices: DeviceInfo[];
}

declare module 'cordis' {
    interface Context {
        zigbee2mqtt: Zigbee2MqttService;
    }
}

export default class Zigbee2MqttService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'zigbee2mqtt');
        ctx.mixin('zigbee2mqtt', []);
    }

    public state: Zigbee2MqttState = { connected: false, devices: [] };
    private client?: import('mqtt').MqttClient;
    private readonly logger = new Logger('z2m');
    private readonly baseTopic = config.zigbee2mqtt?.baseTopic || 'zigbee2mqtt';
    private child?: import('node:child_process').ChildProcessWithoutNullStreams;

    async [Service.init](): Promise<void> {
        if (!config.zigbee2mqtt?.enabled) {
            this.logger.info('zigbee2mqtt disabled');
            return;
        }
        // 先使用本地配置连接；若后续通过 WS 收到 server 的 Broker 配置，将自动重连覆盖
        await this.connectToBroker(
            config.zigbee2mqtt.mqttUrl || 'mqtt://localhost:1883',
            {
                baseTopic: config.zigbee2mqtt.baseTopic,
                username: config.zigbee2mqtt.username,
                password: config.zigbee2mqtt.password,
            }
        );
        // node 模式下，如果配置了 autoStart，自动启动 zigbee2mqtt 进程
        if (process.argv.includes('--node') && config.zigbee2mqtt?.autoStart) {
            void this.ensureProcess().catch((e) => {
                this.logger.error('自动启动 zigbee2mqtt 失败: %s', (e as Error).message);
            });
        }
    }

    async connectToBroker(mqttUrl: string, options?: { baseTopic?: string; username?: string; password?: string }): Promise<void> {
        try {
            mqtt = require('mqtt');
        } catch (e) {
            this.logger.error('mqtt dependency missing. Please install it in workspace.');
            this.state.lastError = 'mqtt dependency missing';
            return;
        }

        // 如果已有连接，先关闭
        if (this.client) {
            try {
                this.client.end(true);
            } catch {}
            this.client = undefined;
        }

        if (options?.baseTopic) {
            this.baseTopic = options.baseTopic;
        }

        const username = options?.username || undefined;
        const password = options?.password || undefined;

        this.logger.info('connecting mqtt %s', mqttUrl);
        this.client = mqtt.connect(mqttUrl, { username, password });
        this.client.on('connect', () => {
            this.state.connected = true;
            this.logger.success('mqtt connected');
            try { this.ctx.parallel('zigbee2mqtt/connected'); } catch {}
            this.subscribe();
            void this.refreshDevices();
        });
        this.client.on('reconnect', () => this.logger.info('mqtt reconnecting'));
        this.client.on('close', () => { this.state.connected = false; this.logger.warn('mqtt closed'); });
        this.client.on('error', (err) => { this.state.lastError = err?.message || String(err); this.logger.error(err); });
        this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    }

    async [Service.dispose](): Promise<void> {
        if (this.client) try { this.client.end(true); } catch {}
        this.client = undefined;
        await this.stopProcess();
    }

    private subscribe() {
        if (!this.client) return;
        const topics = [
            `${this.baseTopic}/#`,
            `${this.baseTopic}/bridge/#`,
        ];
        for (const t of topics) this.client.subscribe(t).catch?.(() => {});
    }

    private onMessage(topic: string, payload: Buffer) {
        let data: any = payload.toString();
        try { data = JSON.parse(data); } catch {}
        try { this.ctx.parallel('zigbee2mqtt/message', topic, data); } catch {}

        const parts = topic.split('/');
        if (parts[0] === this.baseTopic && parts[1] && parts[1] !== 'bridge') {
            try { this.ctx.parallel('zigbee2mqtt/deviceState', parts[1], data); } catch {}
        }
        if (topic === `${this.baseTopic}/bridge/response/devices`) {
            if (data && Array.isArray(data.data)) {
                this.state.devices = data.data as DeviceInfo[];
                try { this.ctx.parallel('zigbee2mqtt/devices', this.state.devices); } catch {}
            }
        }
    }

    async refreshDevices(timeoutMs = 3000): Promise<DeviceInfo[]> {
        if (!this.client) throw new Error('mqtt not connected');
        const requestTopic = `${this.baseTopic}/bridge/request/devices`;
        const responseTopic = `${this.baseTopic}/bridge/response/devices`;
        return new Promise<DeviceInfo[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('devices timeout')), timeoutMs);
            const handle = (topic: string, payload: Buffer) => {
                if (topic !== responseTopic) return;
                clearTimeout(timer);
                this.client?.off('message', handle);
                try {
                    const msg = JSON.parse(payload.toString());
                    if (msg && Array.isArray(msg.data)) {
                        this.state.devices = msg.data;
                        resolve(this.state.devices);
                    } else resolve([]);
                } catch { resolve([]); }
            };
            this.client?.on('message', handle);
            this.client?.publish(requestTopic, JSON.stringify({}))
                .catch?.((e: any) => { clearTimeout(timer); this.client?.off('message', handle); reject(e); });
        });
    }

    async listDevices(): Promise<DeviceInfo[]> {
        if (this.state.devices.length) return this.state.devices;
        try { return await this.refreshDevices(); } catch { return []; }
    }

    async setDeviceState(deviceId: string, payload: Record<string, any>): Promise<void> {
        if (!this.client) throw new Error('mqtt not connected');
        const topic = `${this.baseTopic}/${deviceId}/set`;
        await this.client.publish(topic, JSON.stringify(payload));
    }

    async permitJoin(value: boolean, timeSec: number = 120): Promise<void> {
        if (!this.client) throw new Error('mqtt not connected');
        const topic = `${this.baseTopic}/bridge/request/permit_join`;
        const body: any = { value };
        if (value && timeSec) body.time = timeSec;
        await this.client.publish(topic, JSON.stringify(body));
    }

    // -------- 进程管理：systemd 优先，npx 兜底 --------
    private systemctl(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            const cp = childProcess.spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            cp.stdout.on('data', (d) => { stdout += String(d); });
            cp.stderr.on('data', (d) => { stderr += String(d); });
            cp.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        });
    }

    async ensureProcess(): Promise<'systemd' | 'spawn' | 'none'> {
        if (!config.zigbee2mqtt?.autoStart) return 'none';
        // 尝试 systemd
        const status = await this.systemctl('is-active', '--quiet', 'zigbee2mqtt').catch(() => ({ code: 1, stdout: '', stderr: '' }));
        if (status.code === 0) return 'systemd';
        const start = await this.systemctl('start', 'zigbee2mqtt').catch(() => ({ code: 1, stdout: '', stderr: '' }));
        if (start.code === 0) return 'systemd';
        // 回退到本地 spawn npx
        return await this.spawnLocal() ? 'spawn' : 'none';
    }

    async spawnLocal(): Promise<boolean> {
        try {
            if (this.child && !this.child.killed) return true;
            const adapter = config.zigbee2mqtt?.adapter || '/dev/ttyUSB0';
            const args = ['zigbee2mqtt', '--verbose', '--serial.port', adapter];
            this.logger.info('spawning npx %s', args.join(' '));
            this.child = childProcess.spawn('npx', args, { cwd: process.cwd(), env: process.env });
            this.child.stdout.on('data', (d) => this.logger.info(`[z2m] ${String(d).trim()}`));
            this.child.stderr.on('data', (d) => this.logger.warn(`[z2m] ${String(d).trim()}`));
            this.child.on('close', (code) => { this.logger.warn(`z2m exited: ${code}`); this.child = undefined; });
            return true;
        } catch (e) {
            this.logger.error('spawn zigbee2mqtt failed: %s', (e as Error).message);
            return false;
        }
    }

    async stopProcess(): Promise<void> {
        // 尝试 systemd 停止
        const res = await this.systemctl('stop', 'zigbee2mqtt').catch(() => ({ code: 1 } as any));
        if (res.code === 0) return;
        // 本地子进程
        if (this.child && !this.child.killed) {
            try { this.child.kill('SIGTERM'); } catch {}
            this.child = undefined;
        }
    }

    async processStatus(): Promise<{ mode: 'systemd' | 'spawn' | 'none'; active: boolean }> {
        const sys = await this.systemctl('is-active', '--quiet', 'zigbee2mqtt').catch(() => ({ code: 1 } as any));
        if (sys.code === 0) return { mode: 'systemd', active: true };
        if (this.child && !this.child.killed) return { mode: 'spawn', active: true };
        return { mode: 'none', active: false };
    }
}


