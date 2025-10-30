import { Context } from 'cordis';
import { BadRequestError, Handler, ConnectionHandler } from '@ejunz/framework';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Logger, randomstring } from '../utils';
import { AuthHandler } from './misc';
import { callTool, listTools } from '../mcp-tools';

const logger = new Logger('handler/mcp');

// 全局 MCP Server（使用 SDK）
const mcpServer = new MCPServer({
    name: 'remote-mcp-server',
    version: '1.0.0',
});

function getMCPTools() {
    // 将内部工具注册表转换为 MCP 规范：{ name, description, inputSchema }
    const tools = listTools().map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
    }));
    return tools;
}

// 注册工具列表
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getMCPTools() }));

// 注册工具调用
mcpServer.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params || {};
    const result = await callTool((global as any).__cordis_ctx || ({} as Context), { name, arguments: args || {} });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

// 注册资源列表（示例）
mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
        { uri: 'file:///tmp/example.txt', name: '示例文件', description: '一个示例文本文件', mimeType: 'text/plain' },
        { uri: '/mcp/api/info', name: '服务器信息', description: '服务器状态信息', mimeType: 'application/json' },
    ],
}));

// 注册资源读取（示例）
mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request: any) => {
    const { uri } = request.params || {};
    if (uri === 'file:///tmp/example.txt') {
        return { contents: [{ uri, mimeType: 'text/plain', text: '这是一个示例文件的内容。' }] };
    }
    if (uri === '/mcp/api/info') {
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({
            server: 'Remote MCP Server', version: '1.0.0', uptime: process.uptime(), timestamp: new Date().toISOString(),
        }) }] };
    }
    throw new Error(`资源不存在: ${uri}`);
});

// 本地分发映射，避免直接访问 SDK 内部实现
const sdkDispatchers: Record<string, (ctx: Context, req: any) => Promise<any>> = {
    'tools/list': async () => ({ tools: getMCPTools() }),
    'tools/call': async (ctx, request) => {
        const { name, arguments: args } = request.params || {};
        const result = await callTool(ctx, { name, arguments: args || {} });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
    'resources/list': async () => ({
        resources: [
            { uri: 'file:///tmp/example.txt', name: '示例文件', description: '一个示例文本文件', mimeType: 'text/plain' },
            { uri: '/mcp/api/info', name: '服务器信息', description: '服务器状态信息', mimeType: 'application/json' },
        ],
    }),
    'resources/read': async (_ctx, request) => {
        const { uri } = request.params || {};
        if (uri === 'file:///tmp/example.txt') {
            return { contents: [{ uri, mimeType: 'text/plain', text: '这是一个示例文件的内容。' }] };
        }
        if (uri === '/mcp/api/info') {
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({
                server: 'Remote MCP Server', version: '1.0.0', uptime: process.uptime(), timestamp: new Date().toISOString(),
            }) }] };
        }
        throw new Error(`资源不存在: ${uri}`);
    },
    'notifications/initialized': async () => ({}),
};

class MCPApiRootHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const payload = {
                jsonrpc: '2.0',
                result: {
                    server: 'Remote MCP Server',
                    version: '1.0.0',
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                },
                id: null,
            };
            this.response.type = 'application/json';
            this.response.body = payload;
        } catch (e) {
            this.response.type = 'application/json';
            this.response.body = { jsonrpc: '2.0', error: { code: -32603, message: (e as Error).message }, id: null };
        }
    }

    async post(params) {
        const request = this.request.body;
        const id = request?.id ?? null;
        const method = request?.method;

        // 低层日志（请求）
        try {
            logger.info('[mcp/api] incoming', {
                headers: this.request.headers,
                method: this.request.method,
                path: this.request.path,
                body: request,
            } as any);
        } catch {}

        const reply = (data: any) => ({ jsonrpc: '2.0', id, ...data });

        if (method === 'initialize') {
            this.response.type = 'application/json';
            this.response.body = reply({
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {}, resources: {} },
                    serverInfo: { name: 'remote-mcp-server', version: '1.0.0' },
                },
            });
            return;
        }
        try {
            if (sdkDispatchers[method]) {
                const result = await sdkDispatchers[method](this.ctx, request);
                // 记录并广播
                try {
                    const name = request?.params?.name;
                    const args = request?.params?.arguments;
                    const log = await this.ctx.db.mcplog.insert({
                        timestamp: Date.now(),
                        level: 'info',
                        message: `Tool called: ${name}`,
                        tool: name,
                        metadata: { args },
                    });
                    try { await (this.ctx as any).emit('mcp/log', log); } catch {}
                } catch {}
                this.response.type = 'application/json';
                this.response.body = reply({ result });
                return;
            }
        } catch (e) {
            // 低层日志（错误）
            try { logger.error('[mcp/api] error', e); } catch {}
            this.response.type = 'application/json';
            this.response.body = reply({ error: { code: -32603, message: (e as Error).message } });
            return;
        }

        this.response.type = 'application/json';
        this.response.body = reply({ error: { code: -32601, message: 'Method not found' } });
    }
}


export async function apply(ctx: Context) {
    ctx.Route('mcp_api_root', '/mcp/api', MCPApiRootHandler);

}

