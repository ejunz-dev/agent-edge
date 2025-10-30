import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import { createMCPDispatchers } from '../model/mcp';
import { Logger } from '../utils';

const logger = new Logger('handler/mcp');

const sdkDispatchers: Record<string, (ctx: Context, req: any) => Promise<any>> = createMCPDispatchers();

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

