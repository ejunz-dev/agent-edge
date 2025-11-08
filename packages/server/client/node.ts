// @ts-nocheck
import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { config } from '../config';

const logger = new Logger('node-client');

function resolveUpstream(): string | null {
    // 优先使用配置的upstream字段
    const upstream = (config as any).upstream || '';
    if (upstream) {
        return upstream;
    }
    // 兼容旧配置（server字段）
    const serverUrl = (config as any).server || '';
    if (serverUrl) {
        if (/^wss?:\/\//i.test(serverUrl)) {
            return serverUrl;
        }
        if (/^https?:\/\//i.test(serverUrl)) {
            return serverUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
        }
        return `wss://${serverUrl}`;
    }
    // 环境变量
    return process.env.NODE_UPSTREAM || null;
}

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

function startNodeConnecting(ctx?: Context) {
    // 连接本地MQTT broker（用于zigbee2mqtt控制）
    connectToLocalMqttBroker(ctx);
    
    // 连接方式1: 远程MQTT Broker（MQTT over WebSocket，用于设备通信）
    // 暂时注释掉，避免干扰本地 MQTTX 连接测试
    // connectToRemoteMqttBroker(ctx);
    
    // 连接方式2: Node客户端WebSocket（用于控制指令和实时通信）
    // 暂时注释掉，避免干扰本地 MQTTX 连接测试
    logger.info('已禁用 node 上游 WebSocket 连接（测试模式）。');
    return () => {};
    
    /* 注释掉的 WebSocket 连接逻辑
    const url = resolveUpstream();
    if (!url) {
        logger.info('未配置 upstream，跳过 Node 客户端 WebSocket 连接。');
        return () => {};
    }
    
    // 如果配置了 upstream，但显式禁用了上游连接（通过环境变量）
    if (process.env.DISABLE_NODE_UPSTREAM === '1' || process.env.DISABLE_NODE_UPSTREAM === 'true') {
        logger.info('已禁用 node 上游 WebSocket 连接。');
        return () => {};
    }

    let WS: any;
    try {
        WS = require('ws');
    } catch (e) {
        logger.error('缺少 ws 依赖，请安装依赖 "ws" 后重试。');
        return () => {};
    }

    let ws: any = null;
    let stopped = false;
    let retryDelay = 3000;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let connecting = false;
    let connectTimeout: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let statusUpdateTimer: NodeJS.Timeout | null = null;
    let nodeId = `node_${require('os').hostname()}_${Date.now()}`;

    const scheduleReconnect = () => {
        if (stopped) return;
        if (reconnectTimer) return;
        const nextDelay = Math.min(retryDelay, 30000);
        logger.info('将在 %ds 后重试连接...', Math.round(nextDelay / 1000));
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!stopped) connect();
        }, nextDelay);
        retryDelay = Math.min(nextDelay * 2, 30000);
    };

    const connect = () => {
        if (stopped) return;
        if (connecting) {
            logger.debug?.('已有连接尝试进行中，跳过本次 connect');
            return;
        }
        if (ws && (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING)) {
            logger.debug?.('当前连接尚未关闭，跳过本次 connect');
            return;
        }
        connecting = true;
        logger.info('尝试连接 Node 客户端 WebSocket：%s', url);

        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }

        connectTimeout = setTimeout(() => {
            if (ws && ws.readyState !== WS.OPEN && ws.readyState !== WS.CLOSED) {
                logger.error('连接超时（15秒），可能是服务器未响应');
                try {
                    ws.close();
                } catch {}
                connecting = false;
                scheduleReconnect();
            }
            connectTimeout = null;
        }, 18000);

        const wsOptions: any = {
            handshakeTimeout: 15000,
            perMessageDeflate: false,
            maxReconnects: 0,
        };

        ws = new WS(url, wsOptions);

        ws.on('open', () => {
            logger.success('已连接到 Node 客户端 WebSocket');
            connecting = false;
            retryDelay = 3000;
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }

            // 发送初始化消息，包含 Node 地址信息和连接状态
            try {
                const nodeConfig = (config as any)?.node || {};
                const nodePort = nodeConfig.port || 5284;
                // 获取本地 IP 地址
                const os = require('os');
                const networkInterfaces = os.networkInterfaces();
                let localIp = 'localhost';
                for (const name of Object.keys(networkInterfaces)) {
                    for (const iface of networkInterfaces[name] || []) {
                        if (iface.family === 'IPv4' && !iface.internal) {
                            localIp = iface.address;
                            break;
                        }
                    }
                    if (localIp !== 'localhost') break;
                }
                
                // 发送初始化消息
                ws.send(JSON.stringify({ 
                    type: 'init', 
                    nodeId,
                    host: localIp,
                    port: nodePort,
                    status: 'connected',
                    timestamp: Date.now(),
                }));
                logger.info('已发送 Node 初始化消息到 WebSocket，地址: %s:%d', localIp, nodePort);
                
                // 立即发送一次状态更新，确保前端知道连接已建立
                sendStatusUpdate();
                
                // 设置定期发送状态更新（每30秒）
                if (statusUpdateTimer) {
                    clearInterval(statusUpdateTimer);
                }
                statusUpdateTimer = setInterval(() => {
                    if (ws && ws.readyState === WS.OPEN) {
                        sendStatusUpdate();
                    }
                }, 30000);
                
                // 设置心跳（每10秒发送ping）
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                }
                heartbeatTimer = setInterval(() => {
                    if (ws && ws.readyState === WS.OPEN) {
                        try {
                            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
                        } catch (e) {
                            logger.debug('发送心跳失败: %s', (e as Error).message);
                        }
                    }
                }, 10000);
            } catch (e) {
                logger.error('发送初始化消息失败: %s', (e as Error).message);
            }
        });
        
        // 发送状态更新消息的函数
        const sendStatusUpdate = () => {
            if (!ws || ws.readyState !== WS.OPEN) return;
            try {
                ws.send(JSON.stringify({
                    type: 'status',
                    status: 'connected',
                    nodeId,
                    timestamp: Date.now(),
                }));
            } catch (e) {
                logger.debug('发送状态更新失败: %s', (e as Error).message);
            }
        };

        ws.on('message', (data: any) => {
            try {
                const text = typeof data === 'string' ? data : data.toString('utf8');
                
                // 处理ping/pong心跳消息
                if (text === 'ping' || text.trim() === 'ping') {
                    if (ws && ws.readyState === WS.OPEN) {
                        try {
                            ws.send('pong');
                        } catch (e) {
                            logger.debug('发送pong失败: %s', (e as Error).message);
                        }
                    }
                    return;
                }
                
                // 处理pong响应
                if (text === 'pong' || text.trim() === 'pong') {
                    return;
                }
                
                const msg = JSON.parse(text);
                
                // 处理ping消息（JSON格式）
                if (msg.type === 'ping') {
                    if (ws && ws.readyState === WS.OPEN) {
                        try {
                            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                        } catch (e) {
                            logger.debug('发送pong失败: %s', (e as Error).message);
                        }
                    }
                    return;
                }

                // 转发设备控制指令（如果有）
                if (msg.type === 'device-control' && ctx) {
                    try {
                        ctx.inject(['zigbee2mqtt'], async (c) => {
                            try {
                                const z2mSvc = c.zigbee2mqtt;
                                if (z2mSvc && msg.deviceId && msg.payload) {
                                    await z2mSvc.setDeviceState(msg.deviceId, msg.payload);
                                }
                            } catch (e) {
                                logger.error('控制设备失败: %s', (e as Error).message);
                            }
                        });
                    } catch (e) {
                        logger.error('设备控制错误: %s', (e as Error).message);
                    }
                }
            } catch (e) {
                logger.warn('解析上游服务器消息失败: %s', (e as Error).message);
            }
        });

        ws.on('error', (err: Error) => {
            logger.warn('WebSocket 错误: %s', err.message);
            connecting = false;
            scheduleReconnect();
        });

        ws.on('close', (code: number, reason: Buffer) => {
            logger.warn('Node 客户端 WebSocket 连接已断开: %s %s', code, reason?.toString?.() || '');
            connecting = false;
            ws = null;
            
            // 清理定时器
            if (connectTimeout) {
                clearTimeout(connectTimeout);
                connectTimeout = null;
            }
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            if (statusUpdateTimer) {
                clearInterval(statusUpdateTimer);
                statusUpdateTimer = null;
            }
            
            if (!stopped) {
                scheduleReconnect();
            }
        });
    };

    connect();

    return () => {
        stopped = true;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (connectTimeout) {
            clearTimeout(connectTimeout);
            connectTimeout = null;
        }
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        if (statusUpdateTimer) {
            clearInterval(statusUpdateTimer);
            statusUpdateTimer = null;
        }
        if (ws) {
            try {
                ws.close();
            } catch {}
            ws = null;
        }
    };
    */
}

export async function apply(ctx: Context) {
    startNodeConnecting(ctx);
}

