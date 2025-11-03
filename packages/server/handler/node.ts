import { ConnectionHandler, Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { Logger } from '../utils';
import { config } from '../config';

const logger = new Logger('handler/node');

// 存储已连接的 node 实例
export const connectedNodes = new Map<string, NodeConnectionHandler>();

export class NodeConnectionHandler extends ConnectionHandler<Context> {
    private nodeId?: string;
    private mqttUrl?: string;

    async prepare() {
        // 等待 node 发送初始化消息
    }

    async message(msg: any) {
        if (typeof msg === 'object' && msg.type === 'init') {
            this.nodeId = msg.nodeId || `node_${Date.now()}`;
            // 从 server 配置获取 Broker 信息
            // server 配置中应该有 mqtt 或 zigbee2mqtt 配置段
            const brokerConfig = (config as any).mqtt || (config as any).zigbee2mqtt || {};
            this.mqttUrl = brokerConfig.mqttUrl || process.env.MQTT_URL || 'mqtt://localhost:1883';
            
            // 注册这个 node
            connectedNodes.set(this.nodeId, this);
            
            // 发送 Broker 配置给 node
            this.send({
                type: 'broker-config',
                mqttUrl: this.mqttUrl,
                baseTopic: brokerConfig.baseTopic || 'zigbee2mqtt',
                username: brokerConfig.username || '',
                password: brokerConfig.password || '',
            });
            
            logger.info('Node connected: %s, Broker: %s', this.nodeId, this.mqttUrl);
            return;
        }
        
        // 转发其他消息（如设备控制指令等）
        if (typeof msg === 'object' && msg.type) {
            try {
                this.ctx.parallel('node/message', this.nodeId, msg);
            } catch {}
        }
    }

    async cleanup() {
        if (this.nodeId) {
            connectedNodes.delete(this.nodeId);
            logger.info('Node disconnected: %s', this.nodeId);
        }
    }
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

