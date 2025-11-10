import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import { config, saveConfig } from '../config';
import { Logger } from '../utils';

const logger = new Logger('handler/node-mcp-config');

class NodeMCPConfigHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const result = {
                ws: (config as any).ws || {
                    endpoint: '',
                    localEndpoint: '/mcp/ws',
                    enabled: true,
                },
            };
            
            this.response.type = 'application/json';
            this.response.body = result;
        } catch (e) {
            logger.error('Failed to get MCP config', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }

    async post(params) {
        try {
            const { ws } = this.request.body;
            
            if (ws !== undefined) {
                if (!(config as any).ws) {
                    (config as any).ws = {};
                }
                (config as any).ws = { ...(config as any).ws, ...ws };
                saveConfig();
                logger.info('Updated Node MCP config', ws);
            }
            
            this.response.type = 'application/json';
            this.response.body = { success: true, ws: (config as any).ws };
        } catch (e) {
            logger.error('Failed to update MCP config', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('node_mcp_config', '/api/node/mcp-config', NodeMCPConfigHandler);
}

