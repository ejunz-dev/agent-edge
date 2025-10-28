import { Context } from 'cordis';
import { BadRequestError, Handler } from '@ejunz/framework';
import { Logger, randomstring } from '../utils';
import { AuthHandler } from './misc';
import { callTool, listTools } from '../mcp-tools';

const logger = new Logger('handler/mcp');

class MCPLogsHandler extends AuthHandler {
    async get(params) {
        const { limit = 100, level, tool, server } = params;
        const query: any = {};
        if (level) query.level = level;
        if (tool) query.tool = tool;
        if (server) query.server = server;

        const logs = await this.ctx.db.mcplog.find(query).sort({ timestamp: -1 }).limit(Number(limit));
        this.response.body = { logs };
    }

    async post(params) {
        const { level = 'info', message, tool, server, metadata } = params;
        if (!message) throw new BadRequestError('Message is required');
        
        const log = await this.ctx.db.mcplog.insert({
            timestamp: Date.now(),
            level,
            message,
            tool,
            metadata: metadata ? JSON.parse(metadata) : undefined,
        });

        logger.info(`[${level}] ${tool ? `[${tool}] ` : ''}${message}`);
        
        // 如果是工具调用日志，更新工具统计
        if (tool) {
            const toolDoc = await this.ctx.db.mcptool.findOne({ name: tool });
            if (toolDoc) {
                await this.ctx.db.mcptool.updateOne(
                    { name: tool },
                    {
                        $set: {
                            callCount: toolDoc.callCount + 1,
                            lastCalled: Date.now(),
                        },
                    }
                );
                // 更新服务器统计
                if (server) {
                    const serverDoc = await this.ctx.db.mcpserver.findOne({ name: server });
                    if (serverDoc) {
                        await this.ctx.db.mcpserver.updateOne(
                            { name: server },
                            {
                                $set: {
                                    totalCalls: serverDoc.totalCalls + 1,
                                    lastUpdate: Date.now(),
                                },
                            }
                        );
                        // 触发 metrics 事件
                        await this.ctx.parallel('mcp/tool/call', server, tool);
                    }
                }
            }
        }

        this.response.body = { success: true, id: log._id };
    }
}

class MCPServersHandler extends AuthHandler {
    async get() {
        const servers = await this.ctx.db.mcpserver.find({}).sort({ name: 1 });
        this.response.body = { servers };
    }

    async postAdd(params) {
        const { name, endpoint } = params;
        if (!name || !endpoint) throw new BadRequestError('Name and endpoint are required');
        
        const existing = await this.ctx.db.mcpserver.findOne({ name });
        if (existing) throw new BadRequestError('Server already exists');

        await this.ctx.db.mcpserver.insert({
            name,
            endpoint,
            status: 'online',
            toolCount: 0,
            totalCalls: 0,
            lastUpdate: Date.now(),
            createdAt: Date.now(),
        });

        this.response.body = { success: true };
    }

    async postUpdate(params) {
        const { _id, name, endpoint, status } = params;
        if (!_id) throw new BadRequestError('ID is required');
        
        const update: any = {};
        if (name) update.name = name;
        if (endpoint) update.endpoint = endpoint;
        if (status) update.status = status;
        update.lastUpdate = Date.now();

        await this.ctx.db.mcpserver.updateOne({ _id }, { $set: update });
        this.response.body = { success: true };
    }

    async postDelete(params) {
        const { _id } = params;
        if (!_id) throw new BadRequestError('ID is required');
        
        await this.ctx.db.mcpserver.removeOne({ _id }, {});
        this.response.body = { success: true };
    }

    async postSync(params) {
        const { name } = params;
        if (!name) throw new BadRequestError('Server name is required');
        
        const server = await this.ctx.db.mcpserver.findOne({ name });
        if (!server) throw new BadRequestError('Server not found');

        // 这里应该调用 MCP 服务器的 list_tools 接口
        // 暂时模拟数据
        const mockTools = ['file_read', 'file_write', 'database_query', 'api_call'];
        
        for (const toolName of mockTools) {
            const existing = await this.ctx.db.mcptool.findOne({ name: toolName, server: name });
            if (!existing) {
                await this.ctx.db.mcptool.insert({
                    name: toolName,
                    description: `Tool: ${toolName}`,
                    server: name,
                    callCount: 0,
                    createdAt: Date.now(),
                });
            }
        }

        const tools = await this.ctx.db.mcptool.find({ server: name });
        await this.ctx.db.mcpserver.updateOne(
            { name },
            {
                $set: {
                    toolCount: tools.length,
                    lastUpdate: Date.now(),
                    status: 'online',
                },
            }
        );

        this.response.body = { success: true, toolCount: tools.length };
    }
}

class MCPToolsHandler extends AuthHandler {
    async get(params) {
        const { server, list } = params;
        
        // 如果请求列出可用的工具
        if (list === 'true' || list === true) {
            const availableTools = listTools();
            this.response.body = { tools: availableTools, total: availableTools.length };
            return;
        }
        
        const query: any = {};
        if (server) query.server = server;

        const tools = await this.ctx.db.mcptool.find(query).sort({ callCount: -1, name: 1 });
        this.response.body = { tools };
    }

    async postCall(params) {
        const { tool, arguments: args, server } = params;
        if (!tool) throw new BadRequestError('Tool name is required');
        
        logger.info(`Calling tool: ${tool}`);
        
        // 调用实际的工具处理器
        try {
            const result = await callTool(this.ctx, { name: tool, arguments: args || {} });
            
            // 更新统计
            const toolDoc = await this.ctx.db.mcptool.findOne({ name: tool });
            if (toolDoc) {
                await this.ctx.db.mcptool.updateOne(
                    { name: tool },
                    {
                        $set: {
                            callCount: toolDoc.callCount + 1,
                            lastCalled: Date.now(),
                        },
                    }
                );
            }

            if (server) {
                const serverDoc = await this.ctx.db.mcpserver.findOne({ name: server });
                if (serverDoc) {
                    await this.ctx.db.mcpserver.updateOne(
                        { name: server },
                        {
                            $set: {
                                totalCalls: serverDoc.totalCalls + 1,
                                lastUpdate: Date.now(),
                            },
                        }
                    );
                }
            }

            // 记录调用日志
            await this.ctx.db.mcplog.insert({
                timestamp: Date.now(),
                level: 'info',
                message: `Tool called: ${tool}`,
                tool,
                metadata: { server, args },
            });

            // 触发 metrics 事件
            if (server) {
                await this.ctx.parallel('mcp/tool/call', server, tool);
            }

            this.response.body = { success: true, result };
        } catch (error) {
            logger.error(`Tool call failed: ${tool}`, error);
            
            // 记录错误日志
            await this.ctx.db.mcplog.insert({
                timestamp: Date.now(),
                level: 'error',
                message: `Tool call failed: ${tool} - ${error.message}`,
                tool,
                metadata: { server, args, error: error.message },
            });
            
            throw new BadRequestError(`Tool call failed: ${error.message}`);
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('mcp_logs', '/mcp/logs', MCPLogsHandler);
    ctx.Route('mcp_servers', '/mcp/servers', MCPServersHandler);
    ctx.Route('mcp_tools', '/mcp/tools', MCPToolsHandler);
}

