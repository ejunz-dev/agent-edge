import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import { Logger } from '../utils';
import { listNodeTools, setDynamicNodeTools, getNodeToolEntry } from '../mcp-tools/node';

const logger = new Logger('handler/node-mcp-tools');

class NodeMCPToolsListHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const tools = listNodeTools(true);
            this.response.type = 'application/json';
            this.response.body = {
                tools: tools.map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                    metadata: t.metadata || {},
                })),
                total: tools.length,
            };
        } catch (e) {
            logger.error('获取工具列表失败', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class NodeMCPToolsRegisterHandler extends Handler<Context> {
    allowCors = true;

    async post() {
        try {
            logger.info('开始识别设备并注册 MCP 工具...');
            
            // 获取设备列表
            let devices: any[] = [];
            await this.ctx.inject(['zigbee2mqtt'], async (c) => {
                const svc = c.zigbee2mqtt;
                if (!svc) {
                    throw new Error('Zigbee2MQTT 服务未初始化');
                }
                devices = await svc.listDevices();
            });
            
            logger.info('找到 %d 个设备', devices.length);
            
            // 使用与 node.ts 相同的逻辑生成工具
            const { buildDynamicToolEntries, resolveNodeId } = require('../client/node');
            const nodeId = resolveNodeId();
            
            // 生成工具（使用与自动注册相同的逻辑）
            const tools = buildDynamicToolEntries(devices, nodeId);
            logger.info('生成了 %d 个 MCP 工具', tools.length);
            
            // 注册工具（会自动通过 WebSocket 通知上游服务器）
            setDynamicNodeTools(tools);
            logger.info('工具已注册，将自动同步到上游服务器');
            
            // 统计支持开关的设备数量
            const switchableDevices = devices.filter((d: any) => {
                // 使用与 buildDynamicToolEntries 相同的判断逻辑
                if (d.supportsOnOff === false) return false;
                // 检查是否有开关能力
                if (d.definition?.exposes && Array.isArray(d.definition.exposes)) {
                    return d.definition.exposes.some((feature: any) => {
                        const type = String(feature?.type || '').toLowerCase();
                        const property = String(feature?.property || '').toLowerCase();
                        const name = String(feature?.name || '').toLowerCase();
                        const label = String(feature?.label || '').toLowerCase();
                        return type === 'switch' || type === 'binary' || property === 'state'
                            || property === 'on' || property === 'off' || name === 'state'
                            || label.includes('switch') || label.includes('开关');
                    });
                }
                return true;
            });
            
            this.response.type = 'application/json';
            this.response.body = {
                success: true,
                devicesFound: devices.length,
                devicesRegistered: switchableDevices.length,
                toolsRegistered: tools.length,
                tools: tools.map((entry) => ({
                    name: entry.tool.name,
                    description: entry.tool.description,
                    deviceId: entry.metadata?.deviceId || entry.tool.metadata?.deviceId,
                })),
            };
        } catch (e) {
            logger.error('注册工具失败', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class NodeMCPToolsCallHandler extends Handler<Context> {
    allowCors = true;

    async post() {
        try {
            const { toolName, arguments: args } = this.request.body || {};
            
            if (!toolName) {
                this.response.status = 400;
                this.response.body = { error: '缺少 toolName 参数' };
                return;
            }
            
            const entry = getNodeToolEntry(toolName);
            if (!entry) {
                this.response.status = 404;
                this.response.body = { error: `工具 ${toolName} 不存在` };
                return;
            }
            
            const result = await entry.handler(this.ctx, args || {});
            this.response.type = 'application/json';
            this.response.body = { success: true, result };
        } catch (e) {
            logger.error('调用工具失败', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class NodeMCPToolsUpdateHandler extends Handler<Context> {
    allowCors = true;

    async post() {
        try {
            const { toolName, description } = this.request.body || {};
            
            if (!toolName || !description) {
                this.response.status = 400;
                this.response.body = { error: '缺少 toolName 或 description 参数' };
                return;
            }
            
            const entry = getNodeToolEntry(toolName);
            if (!entry) {
                this.response.status = 404;
                this.response.body = { error: `工具 ${toolName} 不存在` };
                return;
            }
            
            // 更新工具描述
            entry.tool.description = description;
            
            // 工具描述更新后，会通过下次工具同步自动通知上游服务器
            logger.info('工具描述已更新，将在下次同步时通知上游服务器');
            
            this.response.type = 'application/json';
            this.response.body = { success: true, tool: { name: toolName, description } };
        } catch (e) {
            logger.error('更新工具描述失败', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('node_mcp_tools_list', '/api/node/mcp-tools', NodeMCPToolsListHandler);
    ctx.Route('node_mcp_tools_register', '/api/node/mcp-tools/register', NodeMCPToolsRegisterHandler);
    ctx.Route('node_mcp_tools_call', '/api/node/mcp-tools/call', NodeMCPToolsCallHandler);
    ctx.Route('node_mcp_tools_update', '/api/node/mcp-tools/update', NodeMCPToolsUpdateHandler);
}

