import { ConnectionHandler, Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';

const logger = new Logger('handler/node');

// 存储已连接的 node 实例
export const connectedNodes = new Map<string, NodeConnectionHandler>();

// 存储每个 node 的工具列表
export const nodeTools = new Map<string, Array<{
    name: string;
    description: string;
    inputSchema: any;
    parameters?: any;
    metadata?: Record<string, any>;
}>>();

type NodeToolRecord = {
    name: string;
    description: string;
    inputSchema: any;
    parameters?: any;
    metadata?: Record<string, any>;
};

async function persistNodeTools(handler: NodeConnectionHandler, nodeId: string, host: string, port: number, rawTools: any[]): Promise<NodeToolRecord[]> {
    const ctx = handler.ctx;
    const db = (ctx as any).db?.mcptool ? (ctx as any).db.mcptool : null;
    const now = Date.now();
    const toolsArray = Array.isArray(rawTools) ? rawTools : [];
    const normalizedTools: NodeToolRecord[] = [];
    const seenDocIds = new Set<string>();

    let existingDocs: any[] = [];
    if (db) {
        try {
            existingDocs = await Promise.race([
                db.find({ server: nodeId }),
                new Promise<any[]>((_, reject) => 
                    setTimeout(() => reject(new Error('数据库查询超时')), 5000)
                ),
            ]);
        } catch (e) {
            logger.warn('读取 MCP 工具数据库失败: %s', (e as Error).message);
            // 数据库查询失败不影响工具注册，继续处理
        }
    }
    const existingMap = new Map<string, any>(existingDocs.map((doc) => [doc._id, doc]));

    for (const tool of toolsArray) {
        if (!tool || !tool.name) continue;
        const name = String(tool.name);
        const inputSchema = tool.inputSchema || tool.parameters || { type: 'object', properties: {} };
        const defaultDescription = tool.metadata?.defaultDescription || tool.description || '';
        const docId = tool.metadata?.docId || `node:${nodeId}:${name}`;
        seenDocIds.add(docId);
        const existing = existingMap.get(docId);
        const description = existing?.description ?? (tool.description || defaultDescription);
        const metadata = {
            ...(existing?.metadata || {}),
            ...(tool.metadata || {}),
            nodeId,
            nodeHost: host,
            nodePort: port,
            defaultDescription,
            status: 'online',
            syncedAt: now,
            docId,
        };

        normalizedTools.push({
            name,
            description,
            inputSchema,
            parameters: tool.parameters || inputSchema,
            metadata,
        });

        if (!db) continue;
        try {
            await Promise.race([
                db.update(
                    { _id: docId },
                    {
                        $set: {
                            _id: docId,
                            name,
                            description,
                            server: nodeId,
                            callCount: existing?.callCount ?? 0,
                            lastCalled: existing?.lastCalled,
                            createdAt: existing?.createdAt ?? now,
                            metadata,
                        },
                    },
                    { upsert: true },
                ),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('数据库更新超时')), 3000)
                ),
            ]);
        } catch (e) {
            logger.warn('更新 MCP 工具数据库失败 (%s/%s): %s', nodeId, name, (e as Error).message);
            // 数据库更新失败不影响工具注册，继续处理其他工具
        }
    }

    if (db) {
        for (const doc of existingDocs) {
            if (seenDocIds.has(doc._id)) continue;
            const metadata = {
                ...(doc.metadata || {}),
                nodeId,
                nodeHost: host,
                nodePort: port,
                status: 'offline',
                syncedAt: now,
            };
            try {
                await Promise.race([
                    db.update({ _id: doc._id }, { $set: { metadata } }),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('数据库更新超时')), 2000)
                    ),
                ]);
            } catch (e) {
                logger.warn('标记离线 MCP 工具失败 (%s): %s', doc._id, (e as Error).message);
                // 标记离线失败不影响主流程
            }
        }
    }

    nodeTools.set(nodeId, normalizedTools);
    try {
        (ctx as any).emit?.('node/tools-updated', nodeId, normalizedTools);
    } catch {}
    return normalizedTools;
}

export class NodeConnectionHandler extends ConnectionHandler<Context> {
    private nodeId?: string;
    private mqttUrl?: string;
    private nodeHost?: string;
    private nodePort?: number;

    async prepare() {
        // 等待 node 发送初始化消息
        // 默认地址，后续可以从初始化消息中更新
        this.nodeHost = 'localhost';
        this.nodePort = 5284;
    }

    async message(msg: any) {
        try {
            logger.debug('收到 Node 消息: type=%s, nodeId=%s', msg?.type, msg?.nodeId);
            
            if (!msg || typeof msg !== 'object') {
                logger.debug('收到无效消息: %o', msg);
                return;
            }

            if (msg.type === 'init') {
                logger.info('处理 Node init 消息: nodeId=%s, tools=%d', msg.nodeId, Array.isArray(msg.tools) ? msg.tools.length : 0);
            this.nodeId = (msg.nodeId || this.nodeId || `node_${Date.now()}`).toString();
            if (msg.host) this.nodeHost = msg.host;
            if (msg.port) {
                const parsedPort = Number(msg.port);
                if (!Number.isNaN(parsedPort)) this.nodePort = parsedPort;
            }

            const brokerConfig = (config as any).mqtt || (config as any).zigbee2mqtt || {};
            this.mqttUrl = brokerConfig.mqttUrl || process.env.MQTT_URL || 'mqtt://localhost:1883';

            connectedNodes.set(this.nodeId, this);
            (this as any).nodeHost = this.nodeHost;
            (this as any).nodePort = this.nodePort;

                // 先发送 broker 配置，确保连接保持
                try {
                    this.send({
                        type: 'broker-config',
                        mqttUrl: this.mqttUrl,
                        baseTopic: brokerConfig.baseTopic || 'zigbee2mqtt',
                        username: brokerConfig.username || '',
                        password: brokerConfig.password || '',
                    });
                    logger.debug('已发送 broker-config 消息给 Node %s', this.nodeId);
                } catch (e) {
                    logger.error('发送 broker-config 失败: %s', (e as Error).message);
                }

                logger.info('Node connected: %s, Broker: %s, Address: %s:%d', this.nodeId, this.mqttUrl, this.nodeHost, this.nodePort);
                
                // 异步执行持久化，不阻塞消息处理
                persistNodeTools(
                    this,
                    this.nodeId,
                    this.nodeHost || 'localhost',
                    this.nodePort || 5284,
                    Array.isArray(msg.tools) ? msg.tools : [],
                ).then((persisted) => {
                    logger.info('Node %s 注册了 %d 个工具', this.nodeId, persisted.length);
                }).catch((e) => {
                    logger.error('Node %s 工具注册持久化失败: %s', this.nodeId, (e as Error).message);
                    logger.debug('错误堆栈: %s', (e as Error).stack);
                    // 不因为持久化失败而关闭连接，只记录错误
                });
                
                return;
            }

        if (msg.type === 'tools-update') {
            if (!this.nodeId) {
                logger.warn('收到 tools-update 但 nodeId 未初始化');
                return;
            }
            if (msg.host) this.nodeHost = msg.host;
            if (msg.port) {
                const parsedPort = Number(msg.port);
                if (!Number.isNaN(parsedPort)) this.nodePort = parsedPort;
            }
            // 异步执行持久化，不阻塞消息处理
            persistNodeTools(
                this,
                this.nodeId,
                this.nodeHost || 'localhost',
                this.nodePort || 5284,
                Array.isArray(msg.tools) ? msg.tools : [],
            ).then((persisted) => {
                logger.info('Node %s 更新了 %d 个工具', this.nodeId, persisted.length);
            }).catch((e) => {
                logger.error('Node %s 工具更新失败: %s', this.nodeId, (e as Error).message);
                logger.debug('错误堆栈: %s', (e as Error).stack);
                // 不因为更新失败而关闭连接，只记录错误
            });
            return;
        }

        if (msg.type === 'tool-call') {
            const { toolName, arguments: args, requestId } = msg;
            try {
                // 转发到 Node 执行（这里 Node 应该自己处理，或者通过 HTTP API）
                // 暂时先返回错误，需要 Node 实现工具调用处理
                this.send({
                    type: 'tool-result',
                    requestId,
                    success: false,
                    error: 'Node 工具调用需要通过 HTTP API 实现',
                });
            } catch (e) {
                this.send({
                    type: 'tool-result',
                    requestId,
                    success: false,
                    error: (e as Error).message,
                });
            }
            return;
        }

            if (msg.type) {
                logger.debug('收到未处理的消息类型: %s', msg.type);
                try {
                    (this.ctx as any).emit('node/message', this.nodeId, msg);
                } catch {}
            }
        } catch (e) {
            logger.error('处理 Node 消息时出错: %s', (e as Error).message);
            logger.debug('错误堆栈: %s', (e as Error).stack);
            // 不关闭连接，只记录错误
        }
    }

    async cleanup() {
        if (this.nodeId) {
            connectedNodes.delete(this.nodeId);
            nodeTools.delete(this.nodeId);
            logger.info('Node disconnected: %s', this.nodeId);
            try {
                (this.ctx as any).emit('node/tools-updated', this.nodeId, []);
            } catch {}
            const db = (this.ctx as any).db?.mcptool ? (this.ctx as any).db.mcptool : null;
            if (db) {
                try {
                    const docs = await db.find({ server: this.nodeId });
                    const now = Date.now();
                    for (const doc of docs) {
                        const metadata = {
                            ...(doc.metadata || {}),
                            status: 'offline',
                            syncedAt: now,
                        };
                        await db.update({ _id: doc._id }, { $set: { metadata } });
                    }
                } catch (e) {
                    logger.warn('标记 Node 工具离线失败 (%s): %s', this.nodeId, (e as Error).message);
                }
            }
        }
    }
}

// 获取所有 Node 工具（合并所有连接的 Node）
export function getAllNodeTools(): Array<{ name: string; description: string; inputSchema: any }> {
    const allTools: Array<{ name: string; description: string; inputSchema: any }> = [];
    for (const tools of nodeTools.values()) {
        allTools.push(...tools);
    }
    return allTools;
}

// 调用 Node 工具（通过 HTTP API）
export async function callNodeTool(nodeId: string, toolName: string, args: any): Promise<any> {
    const node = connectedNodes.get(nodeId);
    if (!node) {
        throw new Error(`Node ${nodeId} 未连接`);
    }
    
    // 通过 HTTP API 调用（因为 Node 有 HTTP 服务）
    // 这里需要知道 Node 的地址，可以通过配置或从连接信息获取
    // 暂时先尝试通过工具名称判断是否需要转发到 Node
    // 实际实现中，应该通过 HTTP 请求到 Node 的 API
    throw new Error('Node 工具调用需要通过 HTTP API 实现');
}

class NodeStatusHandler extends Handler<Context> {
    async get() {
        this.response.body = {
            connected: connectedNodes.size,
            nodes: Array.from(connectedNodes.keys()),
        };
        this.response.addHeader('Access-Control-Allow-Origin', '*');
    }
}

export async function apply(ctx: Context) {
    ctx.Connection('node_conn', '/node/conn', NodeConnectionHandler);
    ctx.Route('node_status', '/node/status', NodeStatusHandler);
}

