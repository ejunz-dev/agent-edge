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
}>>();

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
        if (typeof msg === 'object' && msg.type === 'init') {
            this.nodeId = msg.nodeId || `node_${Date.now()}`;
            
            // 从初始化消息中获取 Node 地址（如果提供）
            if (msg.host) this.nodeHost = msg.host;
            if (msg.port) this.nodePort = parseInt(String(msg.port), 10);
            
            // 从 server 配置获取 Broker 信息
            const brokerConfig = (config as any).mqtt || (config as any).zigbee2mqtt || {};
            this.mqttUrl = brokerConfig.mqttUrl || process.env.MQTT_URL || 'mqtt://localhost:1883';
            
            // 注册这个 node（存储连接信息和地址）
            connectedNodes.set(this.nodeId, this);
            // 存储 Node 地址信息（用于工具调用）
            (this as any).nodeHost = this.nodeHost;
            (this as any).nodePort = this.nodePort;
            
            // 存储 node 的工具列表
            if (Array.isArray(msg.tools)) {
                nodeTools.set(this.nodeId, msg.tools);
                logger.info('Node %s 注册了 %d 个工具: %s', this.nodeId, msg.tools.length, msg.tools.map((t: any) => t.name).join(', '));
                // 触发工具更新事件（通过 emit）
                try {
                    (this.ctx as any).emit('node/tools-updated', this.nodeId, msg.tools);
                } catch {}
            }
            
            // 发送 Broker 配置给 node
            this.send({
                type: 'broker-config',
                mqttUrl: this.mqttUrl,
                baseTopic: brokerConfig.baseTopic || 'zigbee2mqtt',
                username: brokerConfig.username || '',
                password: brokerConfig.password || '',
            });
            
            logger.info('Node connected: %s, Broker: %s, Address: %s:%d', this.nodeId, this.mqttUrl, this.nodeHost, this.nodePort);
            return;
        }
        
        // 处理工具调用请求（从 Server 转发来的）
        if (typeof msg === 'object' && msg.type === 'tool-call') {
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
        
        // 转发其他消息
        if (typeof msg === 'object' && msg.type) {
            try {
                (this.ctx as any).emit('node/message', this.nodeId, msg);
            } catch {}
        }
    }

    async cleanup() {
        if (this.nodeId) {
            connectedNodes.delete(this.nodeId);
            nodeTools.delete(this.nodeId);
            logger.info('Node disconnected: %s', this.nodeId);
            // 触发工具更新事件
            try {
                (this.ctx as any).emit('node/tools-updated', this.nodeId, []);
            } catch {}
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

