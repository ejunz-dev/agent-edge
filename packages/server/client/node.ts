// @ts-nocheck
import crypto from 'node:crypto';
import os from 'node:os';
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';
import { listNodeTools, setDynamicNodeTools, NodeToolRegistryEntry, NodeToolDefinition } from '../mcp-tools/node';
import { callZigbeeControlTool } from '../mcp-tools/nodeZigbee';

const logger = new Logger('node-client');

// 连接到本地MQTT Broker（用于zigbee2mqtt控制）
function connectToLocalMqttBroker(ctx?: Context) {
    if (!ctx) return;
    
    // 使用zigbee2mqtt配置连接到本地broker
    const z2mConfig = (config as any).zigbee2mqtt || {};
    
    const mqttUrl = z2mConfig.mqttUrl || 'mqtt://localhost:1883';
    const baseTopic = z2mConfig.baseTopic || 'zigbee2mqtt';
    const username = z2mConfig.username || '';
    const password = z2mConfig.password || '';
    
    logger.info('连接到本地MQTT Broker: %s', mqttUrl);
    
    try {
        ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (z2mSvc && typeof z2mSvc.connectToBroker === 'function') {
                await z2mSvc.connectToBroker(mqttUrl, {
                    baseTopic,
                    username,
                    password,
                });
                logger.info('已连接到本地MQTT Broker: %s', mqttUrl);
            }
        });
    } catch (e) {
        logger.error('连接本地MQTT Broker失败: %s', (e as Error).message);
    }
}

// 连接到远程MQTT Broker（用于与上游服务器通信）
function connectToRemoteMqttBroker(ctx?: Context) {
    if (!ctx) return;
    
    const mqttConfig = (config as any).mqtt || {};
    const mqttUrl = mqttConfig.mqttUrl || '';
    
    if (!mqttUrl) {
        logger.info('未配置远程MQTT Broker，跳过连接');
        return;
    }
    
    const baseTopic = mqttConfig.baseTopic || 'zigbee2mqtt';
    const username = mqttConfig.username || '';
    const password = mqttConfig.password || '';
    
    logger.info('连接到远程MQTT Broker: %s (用户名: %s)', mqttUrl, username || '无');
    
    try {
        let mqtt: any;
        try {
            mqtt = require('mqtt');
        } catch (e) {
            logger.error('mqtt 依赖缺失，请安装依赖 "mqtt" 后重试');
            return;
        }
        
        // 从用户名中提取domainId和nodeId（格式: domainId:nodeId）
        let domainId = 'system';
        let nodeId = '1';
        if (username && username.includes(':')) {
            const parts = username.split(':');
            domainId = parts[0] || 'system';
            nodeId = parts[1] || '1';
        }
        
        // 使用示例代码中的客户端ID格式
        const clientId = `node_${domainId}_${nodeId}_${Date.now()}`;
        
        // MQTT连接选项
        const connectOptions: any = {
            clientId,
            username: username || undefined,
            password: password || undefined,
            keepalive: 60, // 保持连接，60秒
            connectTimeout: 30000, // 连接超时30秒
            reconnectPeriod: 5000, // 重连间隔5秒（自动重连）
            clean: true, // 清理会话
            // 确保主动连接，不等待
            connectOnCreate: true, // 立即尝试连接
        };
        
        // 如果是WebSocket连接，需要特殊配置
        if (mqttUrl.startsWith('ws://') || mqttUrl.startsWith('wss://')) {
            // 对于WebSocket连接，mqtt.js需要明确的协议标识
            connectOptions.protocol = mqttUrl.startsWith('wss://') ? 'wss' : 'ws';
            // WebSocket连接需要更长的超时时间
            connectOptions.connectTimeout = 60000; // WebSocket连接超时60秒
            // WebSocket特定选项
            connectOptions.wsOptions = {
                handshakeTimeout: 30000, // WebSocket握手超时
                perMessageDeflate: false, // 禁用压缩
            };
            // 确保使用MQTT协议（不是其他协议）
            connectOptions.protocolId = 'MQTT';
            connectOptions.protocolVersion = 4; // MQTT 3.1.1
        }
        
        logger.info('MQTT连接选项: clientId=%s, keepalive=%d, timeout=%dms, protocol=%s, reconnectPeriod=%dms, username=%s', 
            clientId, connectOptions.keepalive, connectOptions.connectTimeout, 
            connectOptions.protocol || 'mqtt', connectOptions.reconnectPeriod, username || '无');
        
        logger.info('正在主动建立MQTT连接... (URL: %s)', mqttUrl);
        const client = mqtt.connect(mqttUrl, connectOptions);
        
        // 确认连接已开始尝试
        logger.debug('MQTT客户端已创建，连接状态: %s', client.connected ? '已连接' : '连接中...');
        
        // 添加连接状态监控
        let connectStartTime = Date.now();
        const connectionTimeout = setTimeout(() => {
            const elapsed = Date.now() - connectStartTime;
            if (!client.connected) {
                logger.warn('MQTT连接已等待 %d 秒，仍在尝试连接...', Math.round(elapsed / 1000));
            }
        }, 10000); // 10秒后提示
        
        client.on('connect', async (connack: any) => {
            clearTimeout(connectionTimeout);
            const elapsed = Date.now() - connectStartTime;
            logger.success('已连接到远程MQTT Broker: %s (clientId: %s, 耗时: %dms)', 
                mqttUrl, clientId, elapsed);
            if (connack) {
                logger.debug('CONNACK: returnCode=%d, sessionPresent=%s', 
                    connack.returnCode !== undefined ? connack.returnCode : connack, 
                    connack.sessionPresent || false);
            }
            
            // 订阅设备控制指令
            const controlTopic = 'devices/+/set';
            client.subscribe(controlTopic, (err) => {
                if (err) {
                    logger.error('订阅控制指令失败: %s', err.message);
                } else {
                    logger.info('已订阅控制指令: %s', controlTopic);
                }
            });
            
            // 发送设备发现消息
            if (ctx) {
                try {
                    await sendDeviceDiscovery(ctx, client, parseInt(nodeId, 10));
                } catch (e) {
                    logger.error('发送设备发现消息失败: %s', (e as Error).message);
                }
            }
        });
        
        // 接收控制指令
        client.on('message', async (topic: string, message: Buffer) => {
            if (topic.includes('/set')) {
                try {
                    const deviceId = topic.split('/')[1]; // 从 topic 中提取 deviceId
                    const command = JSON.parse(message.toString());
                    logger.info('收到控制指令: %s, 命令: %o', deviceId, command);
                    
                    // 执行控制指令
                    if (ctx) {
                        await executeDeviceControl(ctx, deviceId, command);
                        
                        // 更新设备状态
                        await updateDeviceState(ctx, client, parseInt(nodeId, 10), deviceId, command);
                    }
                } catch (e) {
                    logger.error('处理控制指令失败: %s', (e as Error).message);
                }
            }
        });
        
        client.on('error', (err: Error) => {
            clearTimeout(connectionTimeout);
            logger.error('远程MQTT Broker连接错误: %s', err.message);
            if (err.stack) {
                logger.debug('错误堆栈: %s', err.stack);
            }
            // 检查是否是网络相关错误
            if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
                logger.error('网络连接失败，请检查：');
                logger.error('  1. 服务器地址是否正确: %s', mqttUrl);
                logger.error('  2. 网络是否可达');
                logger.error('  3. 防火墙是否阻止连接');
            }
            // connack timeout 特定错误
            if (err.message.includes('connack timeout')) {
                logger.error('MQTT CONNACK 超时，可能的原因：');
                logger.error('  1. 认证信息错误（用户名/密码: %s/%s）', username || '无', password ? '***' : '无');
                logger.error('  2. 服务器不支持该客户端ID格式: %s', clientId);
                logger.error('  3. WebSocket子协议不匹配');
                logger.error('  4. 服务器端MQTT协议版本不匹配');
            }
        });
        
        client.on('close', () => {
            clearTimeout(connectionTimeout);
            logger.warn('远程MQTT Broker连接已关闭');
        });
        
        client.on('reconnect', () => {
            const elapsed = Date.now() - connectStartTime;
            logger.info('正在主动重连远程MQTT Broker... (clientId: %s, 已等待: %ds)', 
                clientId, Math.round(elapsed / 1000));
            connectStartTime = Date.now(); // 重置计时
        });
        
        client.on('offline', () => {
            logger.warn('远程MQTT Broker已离线');
        });
        
        // 添加end事件监听
        client.on('end', () => {
            logger.info('远程MQTT Broker连接已结束');
        });
        
        // 监听zigbee2mqtt设备状态变化并自动发送更新
        if (ctx) {
            setupDeviceStateListener(ctx, client, parseInt(nodeId, 10));
        }
        
        // 使用ctx的私有存储来保存客户端引用（如果支持）
        // 注意：不直接设置ctx属性，避免错误
        try {
            if (ctx && typeof (ctx as any).set === 'function') {
                (ctx as any).set('remoteMqttClient', client);
            }
        } catch (e) {
            // 如果无法存储，至少连接已建立
            logger.debug('无法存储远程MQTT客户端引用: %s', (e as Error).message);
        }
        
    } catch (e) {
        logger.error('连接远程MQTT Broker失败: %s', (e as Error).message);
        logger.debug('错误堆栈: %s', (e as Error).stack);
    }
}

// 发送设备发现消息
async function sendDeviceDiscovery(ctx: Context, client: any, nodeId: number) {
    try {
        await ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (!z2mSvc) {
                logger.warn('Zigbee2MQTT 服务未初始化，无法发送设备发现消息');
                return;
            }
            
            const devices = await z2mSvc.listDevices();
            logger.info('准备发送设备发现消息，共 %d 个设备', devices.length);
            
            // 转换设备格式
            const deviceList = devices.map((d: any) => {
                const deviceId = d.friendly_name || d.ieee_address;
                const state: any = {};
                
                // 从设备信息中提取状态
                if (d.state) {
                    Object.assign(state, d.state);
                }
                
                // 构建能力列表
                const capabilities: string[] = [];
                if (d.supportsOnOff !== false) {
                    capabilities.push('on', 'off');
                }
                if (d.state?.brightness !== undefined) {
                    capabilities.push('brightness');
                }
                if (d.state?.color !== undefined) {
                    capabilities.push('color');
                }
                
                return {
                    id: deviceId,
                    name: d.friendly_name || deviceId,
                    type: d.type === 'Router' ? 'router' : (d.type === 'EndDevice' ? 'enddevice' : 'unknown'),
                    manufacturer: d.definition?.vendor || d.vendor || '未知厂商',
                    model: d.definition?.model || d.model || '未知型号',
                    state: state,
                    capabilities: capabilities.length > 0 ? capabilities : ['on', 'off'],
                };
            });
            
            const topic = `node/${nodeId}/devices/discover`;
            const payload = JSON.stringify({ devices: deviceList });
            
            client.publish(topic, payload, (err: Error | null) => {
                if (err) {
                    logger.error('发布设备发现消息失败: %s', err.message);
                } else {
                    logger.success('设备发现消息已发送: %s (共 %d 个设备)', topic, deviceList.length);
                }
            });
        });
    } catch (e) {
        logger.error('发送设备发现消息失败: %s', (e as Error).message);
        throw e;
    }
}

// 执行设备控制指令
async function executeDeviceControl(ctx: Context, deviceId: string, command: any) {
    try {
        await ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (!z2mSvc || typeof z2mSvc.setDeviceState !== 'function') {
                logger.error('Zigbee2MQTT 服务未初始化或不支持设备控制');
                return;
            }
            
            logger.info('执行设备控制: %s, 命令: %o', deviceId, command);
            await z2mSvc.setDeviceState(deviceId, command);
            logger.success('设备控制执行成功: %s', deviceId);
        });
    } catch (e) {
        logger.error('执行设备控制失败: %s', (e as Error).message);
        throw e;
    }
}

// 更新设备状态
async function updateDeviceState(ctx: Context, client: any, nodeId: number, deviceId: string, state: any) {
    try {
        const topic = `node/${nodeId}/devices/${deviceId}/state`;
        const payload = JSON.stringify(state);
        
        client.publish(topic, payload, (err: Error | null) => {
            if (err) {
                logger.error('发布状态更新失败: %s', err.message);
            } else {
                logger.debug('状态更新已发送: %s', topic);
            }
        });
    } catch (e) {
        logger.error('更新设备状态失败: %s', (e as Error).message);
    }
}

// 设置设备状态监听器，监听zigbee2mqtt设备状态变化并自动发送更新
function setupDeviceStateListener(ctx: Context, client: any, nodeId: number) {
    try {
        ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (!z2mSvc || !z2mSvc.client) {
                logger.warn('Zigbee2MQTT 服务未初始化，无法设置设备状态监听');
                return;
            }
            
            // 监听本地MQTT消息，当设备状态变化时自动发送到上游
            z2mSvc.client.on('message', (topic: string, payload: Buffer) => {
                // 监听设备状态更新（格式: zigbee2mqtt/{deviceId}）
                if (topic.startsWith(z2mSvc.baseTopic + '/') && !topic.includes('/bridge/')) {
                    const deviceId = topic.substring(z2mSvc.baseTopic.length + 1);
                    try {
                        const state = JSON.parse(payload.toString());
                        const stateTopic = `node/${nodeId}/devices/${deviceId}/state`;
                        const statePayload = JSON.stringify(state);
                        
                        client.publish(stateTopic, statePayload, (err: Error | null) => {
                            if (err) {
                                logger.debug('自动发送状态更新失败: %s', err.message);
                            } else {
                                logger.debug('自动发送状态更新: %s -> %s', deviceId, stateTopic);
                            }
                        });
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            });
            
            logger.info('已设置设备状态自动更新监听器');
        });
    } catch (e) {
        logger.warn('设置设备状态监听器失败: %s', (e as Error).message);
    }
}

const NODE_TOOL_REFRESH_INTERVAL = 10 * 60 * 1000;

function sanitizeIdentifier(value: string): string {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'device';
}

function normalizeNodeUpstream(target: string): string | null {
    if (!target) return null;
    let value = String(target).trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) {
        const url = new URL(value);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '') url.pathname = '/node/conn';
        else if (!/\/node\/conn$/i.test(path)) url.pathname = `${path}/node/conn`;
        return url.toString();
    }
    if (/^wss?:\/\//i.test(value)) {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '') url.pathname = '/node/conn';
        else if (!/\/node\/conn$/i.test(path)) url.pathname = `${path}/node/conn`;
        return url.toString();
    }
    if (!value.includes('://')) {
        return normalizeNodeUpstream(`ws://${value}`);
    }
    try {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, '');
        if (!path || path === '') url.pathname = '/node/conn';
        else if (!/\/node\/conn$/i.test(path)) url.pathname = `${path}/node/conn`;
        return url.toString();
    } catch (e) {
        return null;
    }
}

export function resolveNodeId(): string {
    const explicit = ((config as any).nodeId || process.env.NODE_ID || '').toString().trim();
    if (explicit) return explicit;
    const mqttUsername = ((config as any).mqtt?.username || '').toString();
    if (mqttUsername.includes(':')) {
        const [, nodePart] = mqttUsername.split(':');
        if (nodePart && nodePart.trim()) return nodePart.trim();
    }
    const host = os.hostname();
    if (host) return host;
    return `node-${process.pid}`;
}

function resolveAdvertisedHost(): string {
    const candidates = [
        process.env.NODE_PUBLIC_HOST,
        (config as any).publicHost,
        (config as any).advertiseHost,
        (config as any).host,
        os.hostname(),
        'localhost',
    ];
    for (const candidate of candidates) {
        if (candidate && String(candidate).trim()) return String(candidate).trim();
    }
    return 'localhost';
}

function resolveAdvertisedPort(): number {
    const candidates = [
        process.env.NODE_PUBLIC_PORT,
        (config as any).publicPort,
        (config as any).advertisePort,
        config.port,
        5284,
    ];
    for (const candidate of candidates) {
        const num = Number(candidate);
        if (!Number.isNaN(num) && num > 0) return num;
    }
    return 5284;
}

function flattenExposes(exposes: any): any[] {
    const result: any[] = [];
    const walk = (items: any): void => {
        if (!items) return;
        if (Array.isArray(items)) {
            for (const item of items) walk(item);
            return;
        }
        result.push(items);
        if (Array.isArray(items.features)) walk(items.features);
        if (Array.isArray(items.children)) walk(items.children);
    };
    walk(exposes);
    return result;
}

function hasSwitchCapability(device: any): boolean {
    if (!device) return false;
    if (device.supportsOnOff === false) return false;
    const exposures = flattenExposes(device.definition?.exposes || device.exposes || []);
    if (exposures.length) {
        if (exposures.some((feature) => {
            const type = String(feature?.type || '').toLowerCase();
            const property = String(feature?.property || '').toLowerCase();
            const name = String(feature?.name || '').toLowerCase();
            const label = String(feature?.label || '').toLowerCase();
            return type === 'switch'
                || type === 'binary'
                || property === 'state'
                || property === 'on'
                || property === 'off'
                || name === 'state'
                || label.includes('switch')
                || label.includes('开关');
        })) {
            return true;
        }
    }
    if (device.features && Array.isArray(device.features)) {
        if (device.features.some((f: any) => String(f?.property || '').toLowerCase() === 'state')) return true;
    }
    if (device.state && (device.state.state !== undefined || device.state.on !== undefined)) return true;
    if (device.definition?.supportsOnOff) return true;
    return device.supportsOnOff !== false;
}

export function buildDynamicToolEntries(devices: any[], nodeId: string): NodeToolRegistryEntry[] {
    const entries: NodeToolRegistryEntry[] = [];
    const seenTargets = new Set<string>();
    const sanitizedNode = sanitizeIdentifier(nodeId);
    for (const device of devices || []) {
        const controlTargetId = device?.friendly_name || device?.ieee_address || device?.id;
        if (!controlTargetId) continue;
        if (seenTargets.has(controlTargetId)) continue;
        if (!hasSwitchCapability(device)) continue;
        seenTargets.add(controlTargetId);

        const sanitizedDevice = sanitizeIdentifier(controlTargetId);
        const hashSource = `${nodeId}:${device?.ieee_address || controlTargetId}`;
        const uniqueSuffix = crypto.createHash('sha1').update(hashSource).digest('hex').slice(0, 6);
        const toolName = `node_${sanitizedNode}_${sanitizedDevice}_${uniqueSuffix}_switch`;
        const actions = ['ON', 'OFF', 'TOGGLE'];
        const defaultDescription = `控制设备 ${device?.friendly_name || controlTargetId} 的开关`;
        const parameters = {
            type: 'object',
            properties: {
                state: {
                    type: 'string',
                    enum: actions,
                    description: '开关状态：ON=开启，OFF=关闭，TOGGLE=切换当前状态',
                },
            },
            required: ['state'],
        };
        const metadata = {
            category: 'zigbee-switch',
            nodeId,
            deviceId: controlTargetId,
            friendlyName: device?.friendly_name || controlTargetId,
            ieeeAddress: device?.ieee_address || controlTargetId,
            model: device?.definition?.model || device?.model || '',
            vendor: device?.definition?.vendor || device?.vendor || '',
            actions,
            defaultDescription,
            autoGenerated: true,
            docId: `node:${nodeId}:${toolName}`,
        };
        const entry: NodeToolRegistryEntry = {
            tool: {
                name: toolName,
                description: defaultDescription,
                inputSchema: parameters,
                metadata,
            },
            handler: async (ctx: Context, args: any) => {
                const stateRaw = args?.state;
                const normalizedState = String(stateRaw ?? '').trim().toUpperCase();
                if (!normalizedState) throw new Error('缺少 state 参数');
                if (!actions.includes(normalizedState)) {
                    throw new Error(`state 必须是 ${actions.join(', ')} 之一`);
                }
                await callZigbeeControlTool(ctx, { deviceId: controlTargetId, state: normalizedState });
                return {
                    success: true,
                    deviceId: controlTargetId,
                    state: normalizedState,
                    friendlyName: metadata.friendlyName,
                };
            },
            metadata,
            autoGenerated: true,
        };
        (entry.tool as any).parameters = parameters;
        entries.push(entry);
    }
    return entries;
}

function computeEntrySignature(entries: NodeToolRegistryEntry[]): string {
    if (!entries || !entries.length) return 'empty';
    const parts = entries.map((entry) => `${entry.tool.name}:${entry.metadata?.deviceId || ''}:${(entry.metadata?.actions || []).join(',')}`);
    parts.sort();
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function computeToolsSignature(tools: Array<{ name: string; metadata?: Record<string, any> }>): string {
    if (!tools || !tools.length) return 'empty';
    const parts = tools.map((tool) => `${tool.name}:${tool.metadata?.nodeId || ''}:${tool.metadata?.deviceId || ''}`);
    parts.sort();
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function decorateToolsForAdvertise(tools: NodeToolDefinition[], nodeId: string, host: string, port: number) {
    return (tools || []).map((tool) => {
        const inputSchema = tool.inputSchema || (tool as any).parameters || { type: 'object', properties: {} };
        const metadata = {
            defaultDescription: tool.metadata?.defaultDescription || tool.description,
            autoGenerated: tool.metadata?.autoGenerated ?? false,
            category: tool.metadata?.category || 'node-core',
            nodeId,
            host,
            port,
            status: 'online',
            docId: tool.metadata?.docId || `node:${nodeId}:${tool.name}`,
            ...tool.metadata,
        };
        metadata.nodeId = nodeId;
        metadata.host = host;
        metadata.port = port;
        metadata.status = 'online';
        metadata.docId = metadata.docId || `node:${nodeId}:${tool.name}`;
        return {
            name: tool.name,
            description: tool.description,
            inputSchema,
            parameters: inputSchema,
            metadata,
        };
    });
}

async function fetchZigbeeDevices(ctx?: Context): Promise<any[]> {
    if (!ctx) return [];
    let devices: any[] = [];
    try {
        await ctx.inject(['zigbee2mqtt'], async (c) => {
            const svc = c.zigbee2mqtt;
            if (!svc) return;
            if (typeof svc.listDevices === 'function') {
                devices = await svc.listDevices();
            } else if (Array.isArray(svc.state?.devices)) {
                devices = svc.state.devices;
            }
        });
    } catch (e) {
        logger.warn('获取 Zigbee 设备列表失败: %s', (e as Error).message);
    }
    return devices;
}

function setupNodeMCPRegistration(ctx?: Context) {
    if (!ctx) return () => {};
    const upstreamUrl = normalizeNodeUpstream(((config as any).upstream || '').toString());
    if (!upstreamUrl) {
        logger.warn('未配置上游 MCP 服务器 (config.upstream)，跳过 MCP 工具自动注册');
        return () => {};
    }

    let WS: any;
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        WS = require('ws');
    } catch (e) {
        logger.error('缺少 ws 依赖，请安装依赖 "ws" 以启用 MCP 工具自动注册');
        return () => {};
    }

    const nodeId = resolveNodeId();
    const advertiseHost = resolveAdvertisedHost();
    const advertisePort = resolveAdvertisedPort();

    let ws: any = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let retryDelay = 5000;
    let stopped = false;
    let latestToolsPayload: any[] = [];
    let currentToolsSignature = '';
    let currentDynamicSignature = '';
    const listeners: Array<() => void> = [];

    const sendTools = async (mode: 'init' | 'tools-update') => {
        if (!ws || ws.readyState !== WS.OPEN) return;
        if (!latestToolsPayload.length) {
            latestToolsPayload = decorateToolsForAdvertise(listNodeTools(true) as NodeToolDefinition[], nodeId, advertiseHost, advertisePort);
            currentToolsSignature = computeToolsSignature(latestToolsPayload);
        }
        const payload = {
            type: mode,
            nodeId,
            host: advertiseHost,
            port: advertisePort,
            tools: latestToolsPayload,
            toolsHash: computeToolsSignature(latestToolsPayload),
            timestamp: Date.now(),
        };
        try {
            ws.send(JSON.stringify(payload));
            logger.info('已向上游同步 %d 个 MCP 工具（%s）', latestToolsPayload.length, mode);
        } catch (e) {
            logger.warn('发送 MCP 工具同步消息失败: %s', (e as Error).message);
        }
    };

    const rebuildDynamicTools = async (reason: string, devices?: any[], options: { skipPush?: boolean; force?: boolean } = {}) => {
        try {
            let targetDevices = devices;
            if (!Array.isArray(targetDevices) || !targetDevices.length) {
                targetDevices = await fetchZigbeeDevices(ctx);
            }
            const entries = buildDynamicToolEntries(targetDevices, nodeId);
            const entrySignature = computeEntrySignature(entries);
            const entriesChanged = entrySignature !== currentDynamicSignature;
            if (entriesChanged || options.force) {
                setDynamicNodeTools(entries);
                currentDynamicSignature = entrySignature;
                logger.info('自动注册 %d 个 Zigbee MCP 工具（原因: %s）', entries.length, reason);
            }
            const decorated = decorateToolsForAdvertise(listNodeTools(true) as NodeToolDefinition[], nodeId, advertiseHost, advertisePort);
            latestToolsPayload = decorated;
            const newToolsSignature = computeToolsSignature(decorated);
            const signatureChanged = newToolsSignature !== currentToolsSignature;
            currentToolsSignature = newToolsSignature;
            if (!options.skipPush && (entriesChanged || signatureChanged || options.force) && ws && ws.readyState === WS.OPEN) {
                await sendTools('tools-update');
            }
        } catch (e) {
            logger.warn('刷新 MCP 工具失败（原因: %s）: %s', reason, (e as Error).message);
        }
    };

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, retryDelay);
        logger.info('将在 %d 秒后重试连接 MCP 上游', Math.round(retryDelay / 1000));
        retryDelay = Math.min(retryDelay * 1.5, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) return;
        try {
            ws = new WS(upstreamUrl, { perMessageDeflate: false });
        } catch (e) {
            logger.error('连接 MCP 上游失败: %s', (e as Error).message);
            scheduleReconnect();
            return;
        }

        ws.on('open', async () => {
            logger.info('MCP 上游连接成功: %s', upstreamUrl);
            retryDelay = 5000;
            try {
                await rebuildDynamicTools('ws-open', undefined, { skipPush: true, force: true });
                await sendTools('init');
            } catch (e) {
                logger.warn('初始 MCP 工具注册失败: %s', (e as Error).message);
            }
        });

        ws.on('message', (data: any) => {
            try {
                const text = typeof data === 'string' ? data : data.toString('utf8');
                const message = JSON.parse(text);
                if (message?.type === 'refresh-tools') {
                    logger.info('接收到上游刷新指令，开始重新同步 MCP 工具');
                    void rebuildDynamicTools('refresh-command', undefined, { force: true });
                }
            } catch (e) {
                logger.debug?.('解析 MCP 上游消息失败: %s', (e as Error).message);
            }
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('MCP 上游连接已关闭 (%s): %s', code, reason?.toString?.() || '');
            ws = null;
            if (!stopped) scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            logger.warn('MCP 上游连接错误: %s', err.message);
        });
    };

    void rebuildDynamicTools('bootstrap', undefined, { skipPush: true, force: true });

    const disposeDevices = ctx.on?.('zigbee2mqtt/devices' as any, (devs: any[]) => {
        void rebuildDynamicTools('devices-event', devs);
    });
    if (typeof disposeDevices === 'function') listeners.push(disposeDevices);

    const disposeConnected = ctx.on?.('zigbee2mqtt/connected' as any, () => {
        void rebuildDynamicTools('zigbee-connected');
    });
    if (typeof disposeConnected === 'function') listeners.push(disposeConnected);

    const interval = setInterval(() => {
        void rebuildDynamicTools('scheduled-refresh');
    }, NODE_TOOL_REFRESH_INTERVAL);
    listeners.push(() => clearInterval(interval));

    connect();

    return () => {
        stopped = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (ws) {
            try { ws.close(); } catch { /* ignore */ }
            ws = null;
        }
        for (const dispose of listeners) {
            try { dispose?.(); } catch { /* ignore */ }
        }
    };
}

function startNodeConnecting(ctx?: Context) {
    // 连接本地MQTT broker（用于zigbee2mqtt控制）
    connectToLocalMqttBroker(ctx);
    const disposeMcp = setupNodeMCPRegistration(ctx);
    return () => {
        try { disposeMcp?.(); } catch { /* ignore */ }
    };
}

export async function apply(ctx: Context) {
    startNodeConnecting(ctx);
}

