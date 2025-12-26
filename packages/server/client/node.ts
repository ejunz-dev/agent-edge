// @ts-nocheck
import crypto from 'node:crypto';
import os from 'node:os';
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';
import { listNodeTools, setDynamicNodeTools, NodeToolRegistryEntry, NodeToolDefinition, callNodeTool } from '../mcp-tools/node';
import { callZigbeeControlTool } from '../mcp-tools/nodeZigbee';

const logger = new Logger('node-client');

type EdgeEnvelope = {
    protocol: string;
    action: string;
    channel?: string;
    payload?: any;
    nodeId?: string | number;
    domainId?: string;
    traceId?: string;
    token?: string;
    qos?: 0 | 1 | 2;
    direction?: 'inbound' | 'outbound';
    meta?: Record<string, any>;
};

type ToolUpdateListener = (tools: NodeToolDefinition[]) => void;

interface EdgeBridgeHandle {
    send: (envelope: EdgeEnvelope) => void;
    dispose: () => void;
}

const EDGE_EVENT_INBOUND = 'edge/ws/inbound';
const EDGE_EVENT_OUTBOUND = 'edge/ws/outbound';

let cachedNodeId: string | null = null;
let edgeBridgeHandle: EdgeBridgeHandle | null = null;
const toolUpdateListeners = new Set<ToolUpdateListener>();
let cachedAdvertisedTools: NodeToolDefinition[] = [];
// 防重复处理：记录最近处理的命令（基于 traceId 或 channel+payload）
const processedCommands = new Map<string, number>();

function getResolvedNodeId(): string {
    if (!cachedNodeId) cachedNodeId = resolveNodeId();
    return cachedNodeId;
}

function generateTraceId(prefix = 'edge'): string {
    return `${prefix}-${getResolvedNodeId()}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function emitEdgeEvent(ctx: Context | undefined, direction: 'inbound' | 'outbound', envelope: EdgeEnvelope) {
    if (!ctx || typeof ctx.parallel !== 'function') return;
    const eventName = direction === 'inbound' ? EDGE_EVENT_INBOUND : EDGE_EVENT_OUTBOUND;
    try {
        ctx.parallel(eventName, envelope);
    } catch (e) {
        logger.debug?.('emitEdgeEvent failed: %s', (e as Error).message);
    }
}

function prepareEnvelopeForSend(envelope: EdgeEnvelope, direction: 'outbound' | 'inbound' = 'outbound'): EdgeEnvelope {
    const prepared: EdgeEnvelope = {
        traceId: envelope.traceId || generateTraceId(envelope.protocol || 'edge'),
        ...envelope,
        direction,
    };
    // 不再自动添加 nodeId，由上游从 token 或其他方式识别
    prepared.meta = prepared.meta || {};
    return prepared;
}

function sendEdgeEnvelope(envelope: EdgeEnvelope) {
    if (!edgeBridgeHandle) {
        logger.debug?.('Edge WS bridge not ready, drop envelope: %s/%s', envelope.protocol, envelope.action);
        return;
    }
    edgeBridgeHandle.send(envelope);
}

function notifyNodeToolsUpdated(tools: NodeToolDefinition[]) {
    cachedAdvertisedTools = tools;
    for (const listener of toolUpdateListeners) {
        try {
            listener(tools);
        } catch (e) {
            logger.warn('tools listener failed: %s', (e as Error).message);
        }
    }
}

function onNodeToolsUpdated(listener: ToolUpdateListener): () => void {
    toolUpdateListeners.add(listener);
    if (cachedAdvertisedTools.length) {
        try { listener(cachedAdvertisedTools); } catch {}
    }
    return () => {
        toolUpdateListeners.delete(listener);
    };
}

function getAdvertisedToolsSnapshot(): NodeToolDefinition[] {
    if (cachedAdvertisedTools.length) return cachedAdvertisedTools;
    const nodeId = getResolvedNodeId();
    const advertiseHost = resolveAdvertisedHost();
    const advertisePort = resolveAdvertisedPort();
    cachedAdvertisedTools = decorateToolsForAdvertise(
        listNodeTools(true) as NodeToolDefinition[],
        nodeId,
        advertiseHost,
        advertisePort,
    );
    return cachedAdvertisedTools;
}

// 连接到本地MQTT Broker（用于zigbee2mqtt控制，默认 localhost:1883）
function connectToLocalMqttBroker(ctx?: Context) {
    if (!ctx) return;
    
    // 使用本地broker（默认 localhost:1883，无需配置）
    const mqttUrl = 'mqtt://localhost:1883';
    const z2mConfig = (config as any).zigbee2mqtt || {};
    const baseTopic = z2mConfig.baseTopic || 'zigbee2mqtt';
    
    logger.info('连接到本地MQTT Broker: %s', mqttUrl);
    
    try {
        ctx.inject(['zigbee2mqtt'], async (c) => {
            const z2mSvc = c.zigbee2mqtt;
            if (z2mSvc && typeof z2mSvc.connectToBroker === 'function') {
                await z2mSvc.connectToBroker(mqttUrl, {
                    baseTopic,
                });
                logger.info('已连接到本地MQTT Broker: %s', mqttUrl);
            }
        });
    } catch (e) {
        logger.error('连接本地MQTT Broker失败: %s', (e as Error).message);
    }
}

// 注意：远程MQTT Broker连接已移除，所有通信通过Edge WebSocket进行

// 检测设备是否有多个端点（多开关）
function detectEndpoints(device: any): string[] {
    const endpoints: string[] = [];
    const deviceId = device.friendly_name || device.ieee_address;
    
    // 检查 definition.exposes 中的端点信息
    if (device.definition?.exposes) {
        const exposes = device.definition.exposes;
        for (const expose of exposes) {
            // 查找带有 endpoint 属性的开关
            if (expose.endpoint) {
                endpoints.push(expose.endpoint);
                logger.debug('[detectEndpoints] %s: 在 exposes 中找到端点: %s', deviceId, expose.endpoint);
            }
            // 查找嵌套的 features
            if (expose.features && Array.isArray(expose.features)) {
                for (const feature of expose.features) {
                    if (feature.endpoint && !endpoints.includes(feature.endpoint)) {
                        endpoints.push(feature.endpoint);
                        logger.debug('[detectEndpoints] %s: 在 features 中找到端点: %s', deviceId, feature.endpoint);
                    }
                }
            }
        }
    }
    
    // 检查设备状态中的 state_l1, state_l2 等属性
    if (device.state || device.state === undefined) {
        const state = device.state || {};
        const stateKeys = Object.keys(state);
        for (const key of stateKeys) {
            // 匹配 state_l1, state_l2, state_l3 等模式
            const match = key.match(/^state_l(\d+)$/);
            if (match) {
                const endpoint = `l${match[1]}`;
                if (!endpoints.includes(endpoint)) {
                    endpoints.push(endpoint);
                    logger.debug('[detectEndpoints] %s: 在 state 中找到端点: %s', deviceId, endpoint);
                }
            }
        }
    }
    
    // 如果没有找到端点，返回空数组
    if (endpoints.length > 0) {
        logger.info('[detectEndpoints] %s: 检测到 %d 个端点: %o', deviceId, endpoints.length, endpoints);
    }
    return endpoints.sort();
}

// 为多端点设备创建虚拟子设备
function expandMultiEndpointDevice(device: any, endpoints: string[]): any[] {
    const devices: any[] = [];
    const baseId = device.friendly_name || device.ieee_address;
    
    for (const endpoint of endpoints) {
        const endpointDevice = {
            ...device,
            friendly_name: `${baseId}_${endpoint}`,
            ieee_address: device.ieee_address,
            endpoint: endpoint,
            originalDeviceId: baseId,
            isEndpointDevice: true,
            // 提取该端点的状态
            state: extractEndpointState(device.state, endpoint),
        };
        devices.push(endpointDevice);
    }
    
    return devices;
}

// 提取特定端点的状态
function extractEndpointState(state: any, endpoint: string): any {
    if (!state) return {};
    
    const endpointState: any = {};
    const stateKey = `state_${endpoint}`;
    
    // 如果有 state_l1, state_l2 等属性，提取该端点的状态
    if (state[stateKey] !== undefined) {
        endpointState.state = state[stateKey];
    }
    
    // 复制其他可能相关的属性（如 linkquality 等）
    if (state.linkquality !== undefined) {
        endpointState.linkquality = state.linkquality;
    }
    
    return endpointState;
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
            
            // 转换设备格式，展开多端点设备
            const deviceList: any[] = [];
            for (const d of devices) {
                // 检测设备是否有多个端点
                const endpoints = detectEndpoints(d);
                
                if (endpoints.length > 0) {
                    // 多端点设备：为每个端点创建一个虚拟设备
                    logger.info('检测到多端点设备: %s，端点: %o', d.friendly_name || d.ieee_address, endpoints);
                    const endpointDevices = expandMultiEndpointDevice(d, endpoints);
                    
                    for (const ed of endpointDevices) {
                        const deviceId = ed.friendly_name || ed.ieee_address;
                        const state: any = {};
                        
                        // 从设备信息中提取状态
                        if (ed.state) {
                            Object.assign(state, ed.state);
                        }
                        
                        // 构建能力列表
                        const capabilities: string[] = [];
                        if (ed.supportsOnOff !== false) {
                            capabilities.push('on', 'off');
                        }
                        if (ed.state?.brightness !== undefined) {
                            capabilities.push('brightness');
                        }
                        if (ed.state?.color !== undefined) {
                            capabilities.push('color');
                        }
                        
                        deviceList.push({
                            id: deviceId,
                            name: ed.friendly_name || deviceId,
                            type: ed.type === 'Router' ? 'router' : (ed.type === 'EndDevice' ? 'enddevice' : 'unknown'),
                            manufacturer: ed.definition?.vendor || ed.vendor || '未知厂商',
                            model: ed.definition?.model || ed.model || '未知型号',
                            state: state,
                            capabilities: capabilities.length > 0 ? capabilities : ['on', 'off'],
                            endpoint: ed.endpoint,
                            originalDeviceId: ed.originalDeviceId,
                        });
                    }
                } else {
                    // 单端点设备：正常处理
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
                    
                    deviceList.push({
                        id: deviceId,
                        name: d.friendly_name || deviceId,
                        type: d.type === 'Router' ? 'router' : (d.type === 'EndDevice' ? 'enddevice' : 'unknown'),
                        manufacturer: d.definition?.vendor || d.vendor || '未知厂商',
                        model: d.definition?.model || d.model || '未知型号',
                        state: state,
                        capabilities: capabilities.length > 0 ? capabilities : ['on', 'off'],
                    });
                }
            }
            
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
            
            // 检查 deviceId 是否包含端点信息（格式：deviceName_l1）
            let targetDeviceId = deviceId;
            let endpoint: string | undefined;
            
            const endpointMatch = deviceId.match(/^(.+)_(l\d+)$/);
            if (endpointMatch) {
                // 提取原始设备ID和端点
                targetDeviceId = endpointMatch[1];
                endpoint = endpointMatch[2];
                logger.info('检测到端点控制: 设备=%s, 端点=%s', targetDeviceId, endpoint);
            }
            
            // 构建控制命令
            let controlCommand = { ...command };
            if (endpoint) {
                // 对于多端点设备，需要使用特定的状态键
                // 例如：{ state_l1: "ON" } 而不是 { state: "ON" }
                if (command.state !== undefined) {
                    controlCommand = { [`state_${endpoint}`]: command.state };
                    // 删除通用的 state 属性
                    delete controlCommand.state;
                }
            }
            
            logger.info('执行设备控制: %s, 命令: %o', targetDeviceId, controlCommand);
            await z2mSvc.setDeviceState(targetDeviceId, controlCommand);
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

// 设置设备状态监听器，监听 zigbee2mqtt 设备状态并通过 Edge WS 上报
function setupDeviceStateListener(ctx?: Context) {
    if (!ctx) return () => {};
    const nodeId = getResolvedNodeId();
    const baseTopic = ((config as any).zigbee2mqtt?.baseTopic || 'zigbee2mqtt').replace(/\/+$/, '');

    const forwardState = (deviceId: string, state: any) => {
        if (!deviceId) return;
        const normalizedState = state ?? {};
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'publish',
            channel: `node/${nodeId}/devices/${deviceId}/state`,
            payload: normalizedState,
        });
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'publish',
            channel: `${baseTopic}/${deviceId}`,
            payload: normalizedState,
            meta: { mirrored: true },
        });
    };

    const dispose = ctx.on?.('zigbee2mqtt/deviceState' as any, (deviceId: string, state: any) => {
        forwardState(deviceId, state);
    });

    logger.info('已设置 Zigbee 设备状态上报监听');

    return typeof dispose === 'function' ? dispose : () => {};
}

function resolveEdgeEndpoint(): string {
    const wsConfig = (config as any).ws || {};
    const explicit = (wsConfig.endpoint || '').trim();
    if (explicit) return explicit;
    // 不再支持 upstream 配置，必须使用 ws.endpoint
    logger.warn('未配置 ws.endpoint，请设置 Edge WebSocket endpoint');
    return '';
}

function extractDeviceIdFromChannel(channel: string): string | null {
    if (!channel) return null;
    const normalized = channel.replace(/^\/+|\/+$/g, '');
    
    // 匹配 node/<任意nodeId>/devices/<deviceId>/set 或 node/<任意nodeId>/devices/<deviceId>
    const nodeDevicesMatch = normalized.match(/^node\/[^/]+\/devices\/([^/]+)(?:\/set)?$/);
    if (nodeDevicesMatch) {
        return nodeDevicesMatch[1] || null;
    }
    
    // 匹配 zigbee2mqtt/<deviceId>/set 或 zigbee2mqtt/<deviceId>
    const baseTopic = ((config as any).zigbee2mqtt?.baseTopic || 'zigbee2mqtt').replace(/\/+$/, '');
    if (normalized.startsWith(`${baseTopic}/`)) {
        const rest = normalized.slice(baseTopic.length + 1);
        const [deviceId] = rest.split('/');
        // 排除 bridge 相关的 topic
        if (deviceId && deviceId !== 'bridge') {
            return deviceId || null;
        }
    }
    
    return null;
}

async function handleInboundMqttEnvelope(ctx: Context | undefined, envelope: EdgeEnvelope) {
    if (!ctx) return;
    if (envelope.action !== 'publish') return;
    const channel = envelope.channel || '';
    const deviceId = extractDeviceIdFromChannel(channel);
    if (!deviceId) {
        logger.debug?.('无法解析 MQTT channel: %s', channel);
        return;
    }
    let payload = envelope.payload;
    if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch {
            payload = { value: payload };
        }
    }
    if (payload === undefined || payload === null) payload = {};

    // 命令格式转换：将 on: true/false 转换为 state: "ON"/"OFF"
    if (typeof payload.on === 'boolean' && payload.state === undefined) {
        const onValue = payload.on;
        payload.state = onValue ? 'ON' : 'OFF';
        delete payload.on;
        logger.debug?.('命令格式转换: on=%s -> state=%s', onValue ? 'true' : 'false', payload.state);
    }

    // 防重复处理：检查是否在最近 2 秒内处理过相同的命令
    const commandKey = envelope.traceId || `${channel}:${JSON.stringify(payload)}`;
    const now = Date.now();
    const lastProcessed = processedCommands.get(commandKey);
    if (lastProcessed && (now - lastProcessed) < 2000) {
        logger.debug?.('跳过重复命令: %s (距离上次处理 %dms)', commandKey, now - lastProcessed);
        return;
    }
    processedCommands.set(commandKey, now);
    
    // 清理过期的记录（超过 10 秒）
    for (const [key, timestamp] of processedCommands.entries()) {
        if (now - timestamp > 10000) {
            processedCommands.delete(key);
        }
    }

    try {
        await executeDeviceControl(ctx, deviceId, payload);
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'publish',
            channel: `node/${getResolvedNodeId()}/devices/${deviceId}/ack`,
            payload: { ok: 1, timestamp: Date.now(), channel },
            traceId: envelope.traceId,
            meta: { source: 'node', type: 'ack' },
        });
    } catch (e) {
        sendEdgeEnvelope({
            protocol: 'mqtt',
            action: 'error',
            channel,
            payload: { message: (e as Error).message, deviceId },
            traceId: envelope.traceId,
        });
    }
}

async function handleInboundMcpEnvelope(ctx: Context | undefined, envelope: EdgeEnvelope) {
    if (!ctx) return;
    const payload = envelope.payload || {};
    if (typeof payload !== 'object') return;
    const id = payload.id ?? null;
    const method = payload.method;
    const reply = (body: any) => {
        sendEdgeEnvelope({
            protocol: 'mcp',
            action: 'jsonrpc',
            traceId: envelope.traceId,
            payload: {
                jsonrpc: '2.0',
                id,
                ...body,
            },
        });
    };

    if (!method) {
        logger.debug?.('收到 MCP 响应: %o', payload);
        return;
    }

    try {
        if (method === 'initialize') {
            reply({
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {}, resources: {} },
                    serverInfo: { name: `agent-edge-node-${getResolvedNodeId()}`, version: '1.0.0' },
                },
            });
            return;
        }

        if (method === 'tools/list') {
            reply({ result: { tools: getAdvertisedToolsSnapshot() } });
            return;
        }

        if (method === 'tools/call') {
            const { name, arguments: args } = payload.params || {};
            const result = await callNodeTool(ctx, { name, arguments: args });
            reply({ result });
            return;
        }

        if (method === 'notifications/refresh-tools') {
            reply({ result: { ok: 1 } });
            return;
        }

        reply({ error: { code: -32601, message: `Unknown MCP method: ${method}` } });
    } catch (e) {
        reply({ error: { code: -32603, message: (e as Error).message } });
    }
}

function startEdgeEnvelopeBridge(ctx?: Context) {
    if (!ctx) return () => {};
    const endpoint = resolveEdgeEndpoint();
    if (!endpoint) {
        logger.warn('未配置 ws.endpoint，跳过 Edge WS 信道');
        return () => {};
    }

    let WS: any;
    try {
        // eslint-disable-next-line global-require, import/no-extraneous-dependencies
        WS = require('ws');
    } catch (e) {
        logger.error('缺少 ws 依赖，请先安装：yarn add -W ws');
        return () => {};
    }

    let ws: any = null;
    let stopped = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let retryDelay = 5000;
    let heartbeatInterval: NodeJS.Timeout | null = null;
    const queue: EdgeEnvelope[] = [];
    const maxQueueSize = 200;
    const listeners: Array<() => void> = [];

    const flushQueue = () => {
        if (!ws || ws.readyState !== WS.OPEN) return;
        while (queue.length) {
            const item = queue.shift();
            if (!item) break;
            try {
                ws.send(JSON.stringify(item));
                emitEdgeEvent(ctx, 'outbound', item);
            } catch (e) {
                queue.unshift(item);
                logger.warn('发送队列消息失败: %s', (e as Error).message);
                break;
            }
        }
    };

    const enqueueEnvelope = (envelope: EdgeEnvelope) => {
        const prepared = prepareEnvelopeForSend(envelope, 'outbound');
        if (ws && ws.readyState === WS.OPEN) {
            try {
                ws.send(JSON.stringify(prepared));
                emitEdgeEvent(ctx, 'outbound', prepared);
                return;
            } catch (e) {
                logger.warn('发送 Envelope 失败，将进入队列: %s', (e as Error).message);
            }
        }
        queue.push(prepared);
        if (queue.length > maxQueueSize) queue.shift();
    };

    const sendHandshake = () => {
        enqueueEnvelope({
            protocol: 'mcp',
            action: 'jsonrpc',
            payload: {
                jsonrpc: '2.0',
                method: 'notifications/initialized',
                params: {
                    host: resolveAdvertisedHost(),
                    port: resolveAdvertisedPort(),
                    toolsHash: computeToolsSignature(getAdvertisedToolsSnapshot()),
                    timestamp: Date.now(),
                },
                id: generateTraceId('init'),
            },
        });
    };

    const sendToolsNotification = (reason: string, tools?: NodeToolDefinition[]) => {
        const payloadTools = tools || getAdvertisedToolsSnapshot();
        enqueueEnvelope({
            protocol: 'mcp',
            action: 'jsonrpc',
            payload: {
                jsonrpc: '2.0',
                method: 'notifications/tools-update',
                params: {
                    tools: payloadTools,
                    reason,
                    timestamp: Date.now(),
                },
                id: generateTraceId('tools'),
            },
            meta: { reason },
        });
    };

    const handleInboundMessage = async (data: any) => {
        let text: string;
        if (typeof data === 'string') text = data;
        else if (Buffer.isBuffer(data)) text = data.toString('utf8');
        else text = String(data);
        let parsed: any;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            logger.warn('Edge WS 收到非法 JSON: %s', (e as Error).message);
            return;
        }
        let envelope: EdgeEnvelope;
        if (parsed.protocol) envelope = parsed;
        else if (parsed.jsonrpc) {
            envelope = { protocol: 'mcp', action: 'jsonrpc', payload: parsed };
        } else {
            logger.debug?.('忽略未知消息: %s', text);
            return;
        }
        envelope.direction = 'inbound';
        // 不再自动设置 nodeId，由上游从 token 或其他方式识别
        emitEdgeEvent(ctx, 'inbound', envelope);
        if (envelope.protocol === 'mqtt') {
            await handleInboundMqttEnvelope(ctx, envelope);
        } else if (envelope.protocol === 'mcp') {
            await handleInboundMcpEnvelope(ctx, envelope);
        } else {
            logger.debug?.('未知协议 Envelope: %s', envelope.protocol);
        }
    };

    const stopHeartbeat = () => {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    };

    const startHeartbeat = () => {
        if (heartbeatInterval) return;
        heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === WS.OPEN) {
                try { ws.ping?.(); } catch {}
            }
        }, 30000);
    };

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, retryDelay);
        logger.info('Edge WS 将在 %d 秒后尝试重连', Math.round(retryDelay / 1000));
        retryDelay = Math.min(retryDelay * 1.5, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) return;
        logger.info('尝试连接 Edge WS: %s', endpoint);
        try {
            ws = new WS(endpoint, { perMessageDeflate: false, handshakeTimeout: 20000 });
        } catch (e) {
            logger.error('Edge WS 连接创建失败: %s', (e as Error).message);
            scheduleReconnect();
            return;
        }

        ws.on('open', () => {
            logger.success('Edge WS 连接成功: %s', endpoint);
            retryDelay = 5000;
            flushQueue();
            startHeartbeat();
            sendHandshake();
            sendToolsNotification('bootstrap');
        });

        ws.on('message', (data: any) => {
            handleInboundMessage(data).catch((err) => {
                logger.warn('处理 Edge WS 消息失败: %s', err.message);
            });
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('Edge WS 连接关闭 (%s): %s', code, reason?.toString?.() || '');
            ws = null;
            stopHeartbeat();
            if (!stopped) scheduleReconnect();
        });

        ws.on('error', (err: Error) => {
            logger.warn('Edge WS 错误: %s', err.message);
        });
    };

    connect();

    const unsubscribeTools = onNodeToolsUpdated((tools) => {
        sendToolsNotification('tools-change', tools);
    });
    listeners.push(unsubscribeTools);

    const handle: EdgeBridgeHandle = {
        send: enqueueEnvelope,
        dispose: () => {
            stopped = true;
            stopHeartbeat();
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
        },
    };

    edgeBridgeHandle = handle;

    return () => {
        if (edgeBridgeHandle === handle) edgeBridgeHandle = null;
        handle.dispose();
    };
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
    
    logger.info('[buildDynamicToolEntries] 开始处理 %d 个设备', devices?.length || 0);
    
    for (const device of devices || []) {
        const controlTargetId = device?.friendly_name || device?.ieee_address || device?.id;
        if (!controlTargetId) continue;
        if (seenTargets.has(controlTargetId)) continue;
        if (!hasSwitchCapability(device)) {
            logger.debug('[buildDynamicToolEntries] 跳过设备 %s (无开关能力)', controlTargetId);
            continue;
        }
        seenTargets.add(controlTargetId);
        
        logger.debug('[buildDynamicToolEntries] 处理设备: %s', controlTargetId);

        // 检测是否为多端点设备
        const endpoints = detectEndpoints(device);
        
        if (endpoints.length > 0) {
            // 为每个端点创建独立的工具
            for (const endpoint of endpoints) {
                const endpointDeviceId = `${controlTargetId}_${endpoint}`;
                const sanitizedDevice = sanitizeIdentifier(endpointDeviceId);
                const hashSource = `${nodeId}:${device?.ieee_address || controlTargetId}:${endpoint}`;
                const uniqueSuffix = crypto.createHash('sha1').update(hashSource).digest('hex').slice(0, 6);
                const toolName = `node_${sanitizedNode}_${sanitizedDevice}_${uniqueSuffix}_switch`;
                const actions = ['ON', 'OFF', 'TOGGLE'];
                const defaultDescription = `控制设备 ${device?.friendly_name || controlTargetId} 端点 ${endpoint} 的开关`;
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
                    deviceId: endpointDeviceId,
                    originalDeviceId: controlTargetId,
                    endpoint: endpoint,
                    friendlyName: `${device?.friendly_name || controlTargetId}_${endpoint}`,
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
                    handler: async (args: any) => {
                        logger.info('[%s] 调用工具: %o', toolName, args);
                        const { state } = args;
                        if (!state) throw new Error('缺少必要参数：state');
                        if (!actions.includes(state)) {
                            throw new Error(`state 必须是 ${actions.join(', ')} 之一`);
                        }
                        await callZigbeeControlTool(ctx, { deviceId: endpointDeviceId, state });
                        return { success: true, deviceId: endpointDeviceId, state };
                    },
                };
                entries.push(entry);
            }
        } else {
            // 单端点设备：保持原有逻辑
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
    const nodeId = getResolvedNodeId();
    const advertiseHost = resolveAdvertisedHost();
    const advertisePort = resolveAdvertisedPort();
    let currentToolsSignature = '';
    let currentDynamicSignature = '';
    const listeners: Array<() => void> = [];

    const rebuildDynamicTools = async (reason: string, devices?: any[], options: { force?: boolean } = {}) => {
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
            const decorated = decorateToolsForAdvertise(
                listNodeTools(true) as NodeToolDefinition[],
                nodeId,
                advertiseHost,
                advertisePort,
            );
            const newToolsSignature = computeToolsSignature(decorated);
            const signatureChanged = newToolsSignature !== currentToolsSignature;
            if (signatureChanged || options.force) {
                currentToolsSignature = newToolsSignature;
                notifyNodeToolsUpdated(decorated);
                logger.info('MCP 工具快照更新（原因: %s，工具数: %d）', reason, decorated.length);
            }
        } catch (e) {
            logger.warn('刷新 MCP 工具失败（原因: %s）: %s', reason, (e as Error).message);
        }
    };

    void rebuildDynamicTools('bootstrap', undefined, { force: true });

    const disposeDevices = ctx.on?.('zigbee2mqtt/devices' as any, (devs: any[]) => {
        void rebuildDynamicTools('devices-event', devs);
    });
    if (typeof disposeDevices === 'function') listeners.push(disposeDevices);

    const disposeConnected = ctx.on?.('zigbee2mqtt/connected' as any, () => {
        void rebuildDynamicTools('zigbee-connected', undefined, { force: true });
    });
    if (typeof disposeConnected === 'function') listeners.push(disposeConnected);

    const interval = setInterval(() => {
        void rebuildDynamicTools('scheduled-refresh');
    }, NODE_TOOL_REFRESH_INTERVAL);
    listeners.push(() => clearInterval(interval));

    return () => {
        for (const dispose of listeners) {
            try { dispose?.(); } catch { /* ignore */ }
        }
    };
}

function startNodeConnecting(ctx?: Context) {
    // 连接本地MQTT broker（用于zigbee2mqtt控制）
    connectToLocalMqttBroker(ctx);
    const disposeMcp = setupNodeMCPRegistration(ctx);
    const disposeEdge = startEdgeEnvelopeBridge(ctx);
    const disposeState = setupDeviceStateListener(ctx);
    return () => {
        try { disposeMcp?.(); } catch { /* ignore */ }
        try { disposeEdge?.(); } catch { /* ignore */ }
        try { disposeState?.(); } catch { /* ignore */ }
    };
}

export async function apply(ctx: Context) {
    startNodeConnecting(ctx);
}

