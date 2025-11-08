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
    private zigbee2mqttProcess?: any; // zigbee2mqtt 的 start 函数返回的进程对象
    private bridgeReady: boolean = false;
    private bridgeReadyResolve?: () => void;
    private bridgeReadyPromise?: Promise<void>;

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
            // 先启动进程，再连接 MQTT（如果还没连接）
            void this.ensureProcess().then((mode) => {
                if (mode !== 'none') {
                    this.logger.info('zigbee2mqtt 进程已启动 (模式: %s)', mode);
                }
            }).catch((e) => {
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
                // 移除所有事件监听器，避免重复绑定
                this.client.removeAllListeners();
                this.client.end(true);
            } catch {}
            this.client = undefined;
        }

        // 重置 bridge ready 状态
        this.bridgeReady = false;
        this.bridgeReadyResolve = undefined;
        this.bridgeReadyPromise = new Promise((resolve) => {
            this.bridgeReadyResolve = resolve;
        });

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
            // 等待 bridge 就绪后再获取设备列表
            void this.waitForBridgeAndRefreshDevices();
        });
        this.client.on('reconnect', () => {
            this.logger.info('mqtt reconnecting');
            // 重连时重置 bridge ready 状态
            this.bridgeReady = false;
            this.bridgeReadyPromise = new Promise((resolve) => {
                this.bridgeReadyResolve = resolve;
            });
        });
        this.client.on('close', () => { 
            this.state.connected = false; 
            this.bridgeReady = false;
            this.logger.warn('mqtt closed'); 
        });
        this.client.on('error', (err) => { 
            this.state.lastError = err?.message || String(err); 
            this.logger.error(err); 
        });
        this.client.on('message', (topic, payload) => this.onMessage(topic, payload));
    }

    async [Service.dispose](): Promise<void> {
        if (this.client) try { this.client.end(true); } catch {}
        this.client = undefined;
        // 如果通过模块方式启动，需要停止 zigbee2mqtt
        if (this.zigbee2mqttProcess) {
            try {
                const zigbee2mqtt = require('zigbee2mqtt');
                if (zigbee2mqtt.stop) {
                    await zigbee2mqtt.stop();
                }
            } catch (e) {
                this.logger.warn('停止 zigbee2mqtt 模块失败: %s', (e as Error).message);
            }
            this.zigbee2mqttProcess = undefined;
        }
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

        // 监听 bridge/state 消息，判断 zigbee2mqtt 是否已准备好
        if (topic === `${this.baseTopic}/bridge/state`) {
            const state = typeof data === 'string' ? data : (data?.state || '');
            if (state === 'online' && !this.bridgeReady) {
                this.bridgeReady = true;
                this.logger.info('zigbee2mqtt bridge 已就绪');
                if (this.bridgeReadyResolve) {
                    this.bridgeReadyResolve();
                    this.bridgeReadyResolve = undefined;
                }
            } else if (state === 'offline') {
                this.bridgeReady = false;
                this.logger.warn('zigbee2mqtt bridge 已离线');
            }
        }

        const parts = topic.split('/');
        if (parts[0] === this.baseTopic && parts[1] && parts[1] !== 'bridge') {
            try { this.ctx.parallel('zigbee2mqtt/deviceState', parts[1], data); } catch {}
        }
        // 处理设备列表更新（zigbee2mqtt 直接发布到 bridge/devices）
        if (topic === `${this.baseTopic}/bridge/devices`) {
            if (data && Array.isArray(data)) {
                this.state.devices = data as DeviceInfo[];
                try { this.ctx.parallel('zigbee2mqtt/devices', this.state.devices); } catch {}
            }
        }
        // 兼容旧格式（bridge/response/devices）
        if (topic === `${this.baseTopic}/bridge/response/devices`) {
            if (data && Array.isArray(data.data)) {
                this.state.devices = data.data as DeviceInfo[];
                try { this.ctx.parallel('zigbee2mqtt/devices', this.state.devices); } catch {}
            }
        }
    }

    private async waitForBridgeAndRefreshDevices() {
        // 如果启用了 autoStart，等待 bridge 就绪（最多等待 60 秒，因为进程启动可能需要时间）
        if (process.argv.includes('--node') && config.zigbee2mqtt?.autoStart) {
            this.logger.info('等待 zigbee2mqtt bridge 就绪...');
            try {
                await Promise.race([
                    this.bridgeReadyPromise || Promise.resolve(),
                    new Promise((resolve) => setTimeout(resolve, 60000)), // 60 秒超时
                ]);
                if (this.bridgeReady) {
                    this.logger.info('zigbee2mqtt bridge 已就绪，开始获取设备列表');
                } else {
                    this.logger.warn('等待 bridge 就绪超时（60秒），zigbee2mqtt 进程可能启动失败');
                    this.logger.warn('请检查 zigbee2mqtt 进程是否正常运行');
                }
            } catch (e) {
                this.logger.warn('等待 bridge 就绪时出错: %s', (e as Error).message);
            }
        } else {
            // 非 autoStart 模式，延迟 1 秒
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // 尝试获取设备列表
        try {
            await this.refreshDevices(10000);
            this.logger.info('设备列表已刷新，共 %d 个设备', this.state.devices.length);
        } catch (e) {
            // 初始化时获取设备列表失败不抛出错误，只记录日志
            const errorMsg = (e as Error).message;
            if (errorMsg.includes('timeout')) {
                this.logger.warn('获取设备列表超时，zigbee2mqtt 可能还未完全启动');
                this.logger.warn('如果 zigbee2mqtt 进程启动失败，请检查日志或手动启动 zigbee2mqtt');
            } else {
                this.logger.warn('初始化时获取设备列表失败: %s', errorMsg);
            }
        }
    }

    async refreshDevices(timeoutMs = 3000): Promise<DeviceInfo[]> {
        if (!this.client) throw new Error('mqtt not connected');
        // zigbee2mqtt 直接发布设备列表到 bridge/devices，而不是 bridge/response/devices
        const devicesTopic = `${this.baseTopic}/bridge/devices`;
        const requestTopic = `${this.baseTopic}/bridge/request/devices`;
        
        return new Promise<DeviceInfo[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('devices timeout')), timeoutMs);
            let resolved = false;
            
            const handle = (topic: string, payload: Buffer) => {
                if (topic === devicesTopic) {
                    clearTimeout(timer);
                    this.client?.off('message', handle);
                    if (resolved) return;
                    resolved = true;
                    try {
                        const devices = JSON.parse(payload.toString());
                        if (Array.isArray(devices)) {
                            this.state.devices = devices;
                            resolve(this.state.devices);
                        } else {
                            resolve([]);
                        }
                    } catch (e) {
                        this.logger.warn('解析设备列表失败: %s', (e as Error).message);
                        resolve([]);
                    }
                }
            };
            
            this.client?.on('message', handle);
            // 请求设备列表（触发 zigbee2mqtt 发布最新列表）
            this.client?.publish(requestTopic, JSON.stringify({}))
                .catch?.((e: any) => { 
                    if (!resolved) {
                        clearTimeout(timer); 
                        this.client?.off('message', handle); 
                        reject(e);
                    }
                });
        });
    }

    async listDevices(): Promise<DeviceInfo[]> {
        let devices = this.state.devices;
        if (!devices.length) {
            try { 
                devices = await this.refreshDevices(10000); // 增加超时时间到 10 秒
            } catch (e) {
                this.logger.warn('获取设备列表失败: %s', (e as Error).message);
                return [];
            }
        }
        // 过滤掉 Coordinator（网关本身），只返回真正的终端设备
        return devices.filter((d: any) => {
            const type = d.type || '';
            const friendlyName = (d.friendly_name || '').toLowerCase();
            // 排除 Coordinator 类型的设备，以及名称包含 "coordinator" 的设备
            return type !== 'Coordinator' && !friendlyName.includes('coordinator');
        });
    }

    async setDeviceState(deviceId: string, payload: Record<string, any>): Promise<void> {
        if (!this.client) throw new Error('mqtt not connected');
        const topic = `${this.baseTopic}/${deviceId}/set`;
        await this.client.publish(topic, JSON.stringify(payload));
    }

    async permitJoin(value: boolean, timeSec: number = 120): Promise<void> {
        if (!this.client) throw new Error('mqtt not connected');
        const topic = `${this.baseTopic}/bridge/request/permit_join`;
        // zigbee2mqtt 的 permit_join API 要求：
        // - time 字段必须存在（不能是 undefined）
        // - time > 0: 开启配对，持续 time 秒
        // - time = 0: 关闭配对
        // value 字段是可选的，但为了兼容性，我们同时发送 value 和 time
        const time = value ? timeSec : 0;
        const body: any = { value, time };
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
            if (this.zigbee2mqttProcess) return true; // 如果已经通过模块方式启动，不再重复启动
            
            // 先引入需要的模块
            const path = require('node:path');
            const fs = require('node:fs');
            const { execSync } = require('node:child_process');
            
            let adapter = config.zigbee2mqtt?.adapter || '/dev/ttyUSB0';
            
            // 如果配置的设备不存在，尝试自动检测可用的设备
            if (!fs.existsSync(adapter)) {
                this.logger.warn('配置的 adapter 不存在: %s，尝试自动检测...', adapter);
                const possibleDevices = ['/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/ttyACM1'];
                for (const device of possibleDevices) {
                    if (fs.existsSync(device)) {
                        adapter = device;
                        this.logger.info('自动检测到可用设备: %s', adapter);
                        break;
                    }
                }
                if (!fs.existsSync(adapter)) {
                    this.logger.error('未找到可用的 Zigbee 适配器设备，请检查设备连接或更新配置中的 adapter 路径');
                    return false;
                }
            }
            
            try {
                // 方法1: 直接 require zigbee2mqtt 模块并调用 start 函数（推荐方式）
                try {
                    const pkgPath = require.resolve('zigbee2mqtt/package.json');
                    const pkgDir = path.dirname(pkgPath);
                    const hashFile = path.join(pkgDir, 'dist', '.hash');
                    
                    // 尝试同步 hash 文件，避免触发构建
                    // 重要：必须在 require('zigbee2mqtt') 之前设置 hash，否则会触发构建检查
                    try {
                        const distDir = path.dirname(hashFile);
                        if (!fs.existsSync(distDir)) {
                            fs.mkdirSync(distDir, { recursive: true });
                        }
                        
                        // 重要：node_modules 中的包通常不是 git 仓库
                        // 但 zigbee2mqtt 的 index.js 可能会从父目录获取 git hash
                        // 为了确保不触发构建，我们始终使用 "unknown" 作为 hash
                        // 这样 zigbee2mqtt 的检查逻辑会跳过构建（因为 hash === "unknown" 时不会触发构建）
                        let targetHash: string = 'unknown';
                        
                        // 注意：即使能获取到 git hash，也不使用它
                        // 因为 node_modules 中的包版本是固定的，不需要重新构建
                        // 使用 "unknown" 可以确保 zigbee2mqtt 跳过构建检查
                        
                        // 读取当前 hash
                        let currentHash = 'unknown';
                        if (fs.existsSync(hashFile)) {
                            try {
                                currentHash = fs.readFileSync(hashFile, 'utf8').trim();
                            } catch {}
                        }
                        
                        // 如果 hash 不匹配，更新它
                        if (currentHash !== targetHash) {
                            this.logger.info('更新 zigbee2mqtt hash 文件以避免构建: %s -> %s', currentHash, targetHash);
                            fs.writeFileSync(hashFile, targetHash);
                        } else {
                            this.logger.debug('zigbee2mqtt hash 已同步: %s', targetHash);
                        }
                    } catch (e) {
                        // 如果无法同步 hash，记录警告但继续
                        this.logger.warn('无法同步 zigbee2mqtt hash，可能会触发构建: %s', (e as Error).message);
                        // 即使失败，也尝试创建 hash 文件为 "unknown"
                        try {
                            const distDir = path.dirname(hashFile);
                            if (!fs.existsSync(distDir)) {
                                fs.mkdirSync(distDir, { recursive: true });
                            }
                            if (!fs.existsSync(hashFile)) {
                                fs.writeFileSync(hashFile, 'unknown');
                            }
                        } catch {}
                    }
                    
                    // 设置 zigbee2mqtt 的数据目录和环境变量
                    const originalEnv = process.env.ZIGBEE2MQTT_DATA;
                    const z2mDataDir = process.env.ZIGBEE2MQTT_DATA || path.join(process.env.HOME || process.cwd(), '.z2m');
                    process.env.ZIGBEE2MQTT_DATA = z2mDataDir;
                    
                    // 确保 zigbee2mqtt 配置目录存在，并设置 adapter 配置
                    if (!fs.existsSync(z2mDataDir)) {
                        fs.mkdirSync(z2mDataDir, { recursive: true });
                    }
                    
                    const z2mConfigFile = path.join(z2mDataDir, 'configuration.yaml');
                    // 读取或创建配置文件，设置 adapter 和 mqtt
                    let z2mConfig: any = {};
                    if (fs.existsSync(z2mConfigFile)) {
                        try {
                            const yaml = require('js-yaml');
                            z2mConfig = yaml.load(fs.readFileSync(z2mConfigFile, 'utf8')) || {};
                        } catch (e) {
                            this.logger.warn('读取 zigbee2mqtt 配置文件失败，将创建新配置: %s', (e as Error).message);
                        }
                    }
                    
                    // 解析 MQTT URL
                    const mqttUrl = config.zigbee2mqtt?.mqttUrl || 'mqtt://localhost:1883';
                    const url = new URL(mqttUrl);
                    const mqttHost = url.hostname;
                    const mqttPort = parseInt(url.port || '1883', 10);
                    const mqttUsername = config.zigbee2mqtt?.username || '';
                    const mqttPassword = config.zigbee2mqtt?.password || '';
                    
                    // 更新 MQTT 配置（必需）
                    if (!z2mConfig.mqtt) z2mConfig.mqtt = {};
                    z2mConfig.mqtt.server = `mqtt://${mqttHost}:${mqttPort}`;
                    if (mqttUsername) {
                        z2mConfig.mqtt.user = mqttUsername;
                    }
                    if (mqttPassword) {
                        z2mConfig.mqtt.password = mqttPassword;
                    }
                    
                    // 更新 baseTopic 配置
                    const baseTopic = config.zigbee2mqtt?.baseTopic || 'zigbee2mqtt';
                    z2mConfig.mqtt.base_topic = baseTopic;
                    
                    // 更新 adapter 配置
                    if (!z2mConfig.serial) z2mConfig.serial = {};
                    z2mConfig.serial.port = adapter;
                    // 设置 adapter 类型（默认使用 zstack，这是最常见的 Zigbee 适配器类型）
                    // 如果配置文件中已有 adapter 类型，则保留；否则使用默认值
                    if (!z2mConfig.serial.adapter) {
                        z2mConfig.serial.adapter = 'zstack';
                    }
                    
                    // 保存配置文件
                    try {
                        const yaml = require('js-yaml');
                        fs.writeFileSync(z2mConfigFile, yaml.dump(z2mConfig));
                        this.logger.info('已更新 zigbee2mqtt 配置文件: adapter=%s, mqtt=%s', adapter, z2mConfig.mqtt.server);
                    } catch (e) {
                        this.logger.warn('保存 zigbee2mqtt 配置文件失败: %s', (e as Error).message);
                    }
                    
                    // 设置环境变量，让 corepack 使用 yarn 而不是 pnpm（如果触发构建）
                    process.env.COREPACK_ENABLE_STRICT = '0';
                    process.env.npm_config_package_manager = 'yarn';
                    
                    // 临时修改 GIT_DIR 环境变量，让 zigbee2mqtt 无法获取 git hash
                    // 这样它会返回 "unknown"，与我们的 hash 文件匹配，不会触发构建
                    const originalGitDir = process.env.GIT_DIR;
                    const originalGitWorkTree = process.env.GIT_WORK_TREE;
                    process.env.GIT_DIR = '/dev/null'; // 设置为无效路径
                    delete process.env.GIT_WORK_TREE;
                    
                    // 直接 require zigbee2mqtt 模块并调用 start 函数
                    this.logger.info('通过 Node.js 模块方式启动 zigbee2mqtt (adapter: %s)', adapter);
                    const zigbee2mqtt = require('zigbee2mqtt');
                    
                    // 异步启动，不阻塞
                    void zigbee2mqtt.start().then(() => {
                        this.logger.success('zigbee2mqtt 已通过模块方式启动');
                        this.zigbee2mqttProcess = true;
                    }).catch((e: Error) => {
                        this.logger.error('zigbee2mqtt 启动失败: %s', e.message);
                        this.zigbee2mqttProcess = undefined;
                    });
                    
                    // 恢复环境变量
                    if (originalEnv !== undefined) {
                        process.env.ZIGBEE2MQTT_DATA = originalEnv;
                    }
                    if (originalGitDir !== undefined) {
                        process.env.GIT_DIR = originalGitDir;
                    } else {
                        delete process.env.GIT_DIR;
                    }
                    if (originalGitWorkTree !== undefined) {
                        process.env.GIT_WORK_TREE = originalGitWorkTree;
                    }
                    
                    return true;
                } catch (e) {
                    this.logger.warn('无法通过模块方式启动 zigbee2mqtt，回退到进程方式: %s', (e as Error).message);
                }
                
                // 方法2: 回退到通过 child_process 启动（如果模块方式失败）
                const pkgPath = require.resolve('zigbee2mqtt/package.json');
                const pkgDir = path.dirname(pkgPath);
                const mainPath = path.join(pkgDir, 'index.js');
                
                if (fs.existsSync(mainPath)) {
                    const args = [mainPath, '--verbose', '--serial.port', adapter];
                    this.logger.info('spawning local zigbee2mqtt (via node): node %s', args.join(' '));
                    const env = {
                        ...process.env,
                        NODE_ENV: process.env.NODE_ENV || 'production',
                        COREPACK_ENABLE_STRICT: '0',
                        npm_config_package_manager: 'yarn',
                        ZIGBEE2MQTT_DATA: process.env.ZIGBEE2MQTT_DATA || path.join(process.env.HOME || process.cwd(), '.z2m'),
                    };
                    this.child = childProcess.spawn('node', args, { 
                        cwd: pkgDir,
                        env 
                    });
                    this.setupChildProcess();
                    return true;
                }
            } catch (e) {
                this.logger.error('启动 zigbee2mqtt 失败: %s', (e as Error).message);
                return false;
            }
            
            return false;
        } catch (e) {
            this.logger.error('spawn zigbee2mqtt failed: %s', (e as Error).message);
            return false;
        }
    }

    private setupChildProcess() {
        if (!this.child) return;
        
        this.child.stdout.on('data', (d) => this.logger.info(`[z2m] ${String(d).trim()}`));
        this.child.stderr.on('data', (d) => {
            const msg = String(d).trim();
            this.logger.warn(`[z2m] ${msg}`);
        });
        this.child.on('close', (code) => { 
            if (code !== 0 && code !== null) {
                this.logger.error(`zigbee2mqtt 进程异常退出 (code: ${code})`);
                this.logger.error('请检查 zigbee2mqtt 是否已正确安装，或手动启动 zigbee2mqtt 服务');
            } else {
                this.logger.warn(`z2m exited: ${code}`);
            }
            this.child = undefined; 
        });
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


