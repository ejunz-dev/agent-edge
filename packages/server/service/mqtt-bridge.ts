// @ts-nocheck
import { Context, Service } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';
import * as path from 'node:path';
import { fs, yaml } from '../utils';

/**
 * MQTT Broker 桥接服务
 * 支持连接多个 MQTT Broker，并桥接设备控制指令
 */
export default class MqttBridgeService extends Service<Context> {
    private readonly logger = new Logger('mqtt-bridge');
    private clients: Map<string, any> = new Map();
    private subscriptions: Map<string, Set<string>> = new Map();
    private lastPublishedState: Map<string, { state: string, timestamp: number }> = new Map();
    private processedCommands: Map<string, number> = new Map(); // 记录已处理的命令，防止重复处理

    constructor(ctx: Context) {
        super(ctx, 'mqttBridge');
    }

    async [Service.init](): Promise<void> {
        const nodeMode = process.argv.includes('--node');
        if (!nodeMode) return;

        const bridgeConf = (config as any).mqttBridge || {};
        const enabled = bridgeConf.enabled ?? true;
        if (!enabled) {
            this.logger.info('MQTT Bridge 已禁用');
            return;
        }

        const brokers = bridgeConf.brokers || [];
        if (brokers.length === 0) {
            this.logger.warn('未配置 MQTT Broker，跳过桥接服务');
            return;
        }

        this.logger.info(`开始连接 ${brokers.length} 个 MQTT Broker...`);

        for (const brokerConfig of brokers) {
            await this.connectToBroker(brokerConfig);
        }

        // 监听设备状态变化，同步到所有 broker
        this.setupDeviceStateSync();
    }

    private setupDeviceStateSync(): void {
        // 监听 zigbee2mqtt 设备状态变化事件
        // 注意：如果不需要状态同步，可以注释掉这部分代码
        // this.ctx.on('zigbee2mqtt/deviceState', (deviceId: string, state: any) => {
        //     // 同步设备状态到所有 broker
        //     for (const [brokerName, brokerConfig] of this.getBrokerConfigs().entries()) {
        //         const baseTopic = brokerConfig.baseTopic || 'zigbee2mqtt';
        //         this.publishDeviceState(deviceId, state, baseTopic).catch((e) => {
        //             this.logger.error(`同步设备状态失败 [${brokerName}]: ${(e as Error).message}`);
        //         });
        //     }
        // });
        // 暂时禁用状态同步，避免日志爆炸
        this.logger.info('设备状态同步已禁用（避免日志过多）');
    }

    private getBrokerConfigs(): Map<string, any> {
        const bridgeConf = (config as any).mqttBridge || {};
        const brokers = bridgeConf.brokers || [];
        const configs = new Map();
        for (const brokerConfig of brokers) {
            if (brokerConfig.enabled !== false) {
                configs.set(brokerConfig.name, brokerConfig);
            }
        }
        return configs;
    }

    private async connectToBroker(brokerConfig: any): Promise<void> {
        const { name, mqttUrl, baseTopic = 'zigbee2mqtt', username, password, enabled = true, reconnect: brokerReconnect } = brokerConfig;

        if (!enabled) {
            this.logger.info(`Broker ${name} 已禁用，跳过连接`);
            return;
        }

        if (!mqttUrl) {
            this.logger.warn(`Broker ${name} 未配置 mqttUrl，跳过连接`);
            return;
        }

        const brokerName = name || mqttUrl;

        try {
            let mqtt: any;
            try {
                mqtt = require('mqtt');
            } catch (e) {
                this.logger.error('mqtt 依赖缺失，请先安装：yarn add -W mqtt');
                return;
            }

            // 获取重连配置：优先使用broker级别的配置，否则使用全局配置
            const bridgeConf = (config as any).mqttBridge || {};
            const globalReconnect = bridgeConf.reconnect || { enabled: true, period: 5000 };
            const reconnectConfig = brokerReconnect || globalReconnect;
            const reconnectEnabled = reconnectConfig.enabled !== false;
            const reconnectPeriod = reconnectConfig.period || 5000;

            this.logger.info(`连接到 Broker: ${brokerName} (${mqttUrl}), 重连: ${reconnectEnabled ? `启用(${reconnectPeriod}ms)` : '禁用'}`);

            const connectOptions: any = {
                clientId: `bridge_${brokerName}_${Date.now()}`,
                username: username || undefined,
                password: password || undefined,
                keepalive: 60,
                connectTimeout: 30000,
                reconnectPeriod: reconnectEnabled ? reconnectPeriod : 0, // 0表示禁用自动重连
                clean: true,
            };

            // WebSocket 连接配置
            if (mqttUrl.startsWith('ws://') || mqttUrl.startsWith('wss://')) {
                connectOptions.protocol = mqttUrl.startsWith('wss://') ? 'wss' : 'ws';
                connectOptions.connectTimeout = 60000;
                connectOptions.wsOptions = {
                    handshakeTimeout: 30000,
                    perMessageDeflate: false,
                };
                connectOptions.protocolId = 'MQTT';
                connectOptions.protocolVersion = 4; // MQTT 3.1.1
            }

            const client = mqtt.connect(mqttUrl, connectOptions);

            client.on('connect', () => {
                this.logger.success(`已连接到 Broker: ${brokerName}`);
                this.clients.set(brokerName, client);

                // 订阅设备控制指令主题（只订阅控制指令，不订阅状态，避免循环）
                const controlTopic = `${baseTopic}/+/set`;
                client.subscribe(controlTopic, (err: Error) => {
                    if (err) {
                        this.logger.error(`订阅失败 [${brokerName}]: ${err.message}`);
                    } else {
                        this.logger.info(`已订阅控制指令 [${brokerName}]: ${controlTopic}`);
                        if (!this.subscriptions.has(brokerName)) {
                            this.subscriptions.set(brokerName, new Set());
                        }
                        this.subscriptions.get(brokerName)!.add(controlTopic);
                    }
                });
            });

            client.on('message', async (topic: string, message: Buffer) => {
                try {
                    // 只处理控制指令（/set 结尾的主题）
                    if (!topic.endsWith('/set')) return;

                    const payloadStr = message.toString();
                    const payload = JSON.parse(payloadStr);
                    const deviceId = topic.replace(`${baseTopic}/`, '').replace('/set', '');

                    // 防重复机制：检查是否在最近 2 秒内处理过相同的命令
                    const commandKey = `${topic}:${payloadStr}`;
                    const now = Date.now();
                    const lastProcessed = this.processedCommands.get(commandKey);
                    
                    if (lastProcessed && (now - lastProcessed) < 2000) {
                        // 2 秒内已处理过相同命令，跳过
                        return;
                    }
                    
                    // 记录已处理的命令
                    this.processedCommands.set(commandKey, now);
                    
                    // 清理过期的记录（超过 10 秒）
                    for (const [key, timestamp] of this.processedCommands.entries()) {
                        if (now - timestamp > 10000) {
                            this.processedCommands.delete(key);
                        }
                    }

                    // 只记录第一次收到的控制指令
                    if (!lastProcessed) {
                        this.logger.info(`收到控制指令 [${brokerName}]: ${topic} -> ${payloadStr}`);
                    }

                    // 执行设备控制
                    await this.executeDeviceControl(deviceId, payload);

                    // 将控制指令转发到其他 broker（避免循环）
                    await this.forwardToOtherBrokers(brokerName, topic, message);
                } catch (e) {
                    this.logger.error(`处理消息失败 [${brokerName}]: ${(e as Error).message}`);
                }
            });

            client.on('error', (err: Error) => {
                this.logger.error(`Broker 连接错误 [${brokerName}]: ${err.message}`);
            });

            client.on('close', () => {
                this.logger.warn(`Broker 连接已关闭 [${brokerName}]`);
                this.clients.delete(brokerName);
            });

            client.on('reconnect', () => {
                // 只有在启用重连时才记录日志
                if (reconnectEnabled) {
                    this.logger.info(`正在重连 Broker [${brokerName}]...`);
                }
            });

            client.on('offline', () => {
                this.logger.warn(`Broker 已离线 [${brokerName}]`);
            });
        } catch (e) {
            this.logger.error(`连接 Broker 失败 [${brokerName}]: ${(e as Error).message}`);
        }
    }

    private async executeDeviceControl(deviceId: string, payload: any): Promise<void> {
        try {
            await this.ctx.inject(['zigbee2mqtt'], async (c) => {
                const z2mSvc = c.zigbee2mqtt;
                if (!z2mSvc || typeof z2mSvc.setDeviceState !== 'function') {
                    this.logger.error('Zigbee2MQTT 服务未初始化或不支持设备控制');
                    return;
                }

                // 减少日志输出，只在调试时记录
                // this.logger.info(`执行设备控制: ${deviceId}, 命令: ${JSON.stringify(payload)}`);
                await z2mSvc.setDeviceState(deviceId, payload);
                // 减少日志输出
                // this.logger.success(`设备控制执行成功: ${deviceId}`);
            });
        } catch (e) {
            this.logger.error(`执行设备控制失败: ${(e as Error).message}`);
            throw e;
        }
    }

    private async forwardToOtherBrokers(sourceBroker: string, topic: string, message: Buffer): Promise<void> {
        // 将控制指令转发到其他 broker（避免循环）
        // 注意：转发可能导致循环，已通过防重复机制避免
        for (const [brokerName, client] of this.clients.entries()) {
            if (brokerName === sourceBroker) continue; // 不转发回源 broker

            if (client && client.connected) {
                try {
                    // 静默转发，不记录日志，避免日志爆炸
                    client.publish(topic, message, { qos: 1 }, (err: Error) => {
                        if (err) {
                            this.logger.error(`转发消息失败 [${brokerName}]: ${err.message}`);
                        }
                        // 成功时不记录日志
                    });
                } catch (e) {
                    this.logger.error(`转发消息异常 [${brokerName}]: ${(e as Error).message}`);
                }
            }
        }
    }

    /**
     * 发布设备状态到所有 broker
     */
    async publishDeviceState(deviceId: string, state: any, baseTopic: string = 'zigbee2mqtt'): Promise<void> {
        const topic = `${baseTopic}/${deviceId}`;
        const message = JSON.stringify(state);
        
        // 防重复机制：如果状态相同且距离上次发布不到 1 秒，则跳过
        const stateKey = `${baseTopic}/${deviceId}`;
        const lastState = this.lastPublishedState.get(stateKey);
        const now = Date.now();
        
        if (lastState && lastState.state === message && (now - lastState.timestamp) < 1000) {
            // 状态相同且距离上次发布不到 1 秒，跳过发布
            return;
        }
        
        // 更新最后发布的状态
        this.lastPublishedState.set(stateKey, { state: message, timestamp: now });

        for (const [brokerName, client] of this.clients.entries()) {
            if (client && client.connected) {
                try {
                    // 静默发布，不记录 debug 日志，避免日志爆炸
                    client.publish(topic, message, { qos: 1 }, (err: Error) => {
                        if (err) {
                            this.logger.error(`发布状态失败 [${brokerName}]: ${err.message}`);
                        }
                        // 成功时不记录日志，减少日志量
                    });
                } catch (e) {
                    this.logger.error(`发布状态异常 [${brokerName}]: ${(e as Error).message}`);
                }
            }
        }
    }

    /**
     * 重新加载配置并重新连接所有broker
     */
    async reloadConfig(): Promise<void> {
        this.logger.info('正在重新加载配置...');
        
        // 断开所有现有连接
        await this[Service.dispose]();
        
        // 重新读取配置文件并应用schema验证
        const isNode = process.argv.includes('--node');
        const configPath = path.resolve(process.cwd(), `config.${isNode ? 'node' : 'server'}.yaml`);
        if (fs.existsSync(configPath)) {
            const configData = yaml.load(fs.readFileSync(configPath, 'utf8'));
            // 应用schema验证并更新config对象
            // 注意：这里直接更新mqttBridge部分，因为config对象是共享的
            if (configData.mqttBridge) {
                // 合并现有配置，保留schema默认值
                const currentBridge = (config as any).mqttBridge || {};
                (config as any).mqttBridge = {
                    enabled: configData.mqttBridge.enabled ?? currentBridge.enabled ?? true,
                    reconnect: {
                        enabled: configData.mqttBridge.reconnect?.enabled ?? currentBridge.reconnect?.enabled ?? true,
                        period: configData.mqttBridge.reconnect?.period ?? currentBridge.reconnect?.period ?? 5000,
                    },
                    brokers: configData.mqttBridge.brokers || [],
                };
            }
        }
        
        // 重新初始化
        await this[Service.init]();
        
        this.logger.success('配置重新加载完成');
    }

    /**
     * 获取当前配置状态
     */
    getConfigStatus(): any {
        const bridgeConf = (config as any).mqttBridge || {};
        const brokers = bridgeConf.brokers || [];
        const status: any = {
            enabled: bridgeConf.enabled ?? true,
            reconnect: bridgeConf.reconnect || { enabled: true, period: 5000 },
            brokers: brokers.map((broker: any) => ({
                name: broker.name,
                mqttUrl: broker.mqttUrl,
                baseTopic: broker.baseTopic || 'zigbee2mqtt',
                enabled: broker.enabled !== false,
                reconnect: broker.reconnect || bridgeConf.reconnect || { enabled: true, period: 5000 },
                connected: this.clients.has(broker.name) && this.clients.get(broker.name)?.connected,
            })),
        };
        return status;
    }

    async [Service.dispose](): Promise<void> {
        for (const [brokerName, client] of this.clients.entries()) {
            try {
                if (client) {
                    client.end(true);
                    this.logger.info(`已断开 Broker 连接: ${brokerName}`);
                }
            } catch (e) {
                this.logger.error(`断开连接失败 [${brokerName}]: ${(e as Error).message}`);
            }
        }
        this.clients.clear();
        this.subscriptions.clear();
    }
}

