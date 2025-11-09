import { Context } from 'cordis';
import { Handler } from '@ejunz/framework';
import { config, saveConfig } from '../config';
import { listTools } from '../mcp-tools/provider-index';
import { Logger } from '../utils';

const logger = new Logger('handler/provider-tools-config');

class ProviderToolsConfigHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const tools = listTools();
            const toolsConfig = config.tools || {};
            
            const result = {
                tools: tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    enabled: toolsConfig[tool.name]?.enabled !== false,
                    config: toolsConfig[tool.name] || {},
                })),
            };
            
            this.response.type = 'application/json';
            this.response.body = result;
        } catch (e) {
            logger.error('Failed to get tools config', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }

    async post(params) {
        try {
            const { tool, enabled, description } = this.request.body;
            
            if (!tool) {
                this.response.status = 400;
                this.response.body = { error: 'Tool name is required' };
                return;
            }

            // 更新配置
            if (!config.tools) {
                (config as any).tools = {};
            }
            
            if (!config.tools[tool]) {
                config.tools[tool] = {} as any;
            }
            
            if (enabled !== undefined) {
                config.tools[tool].enabled = enabled;
            }
            
            if (description !== undefined) {
                config.tools[tool].description = description;
            }
            
            saveConfig();
            
            logger.info(`Updated tool config: ${tool}`, { enabled, description });
            
            this.response.type = 'application/json';
            this.response.body = { success: true, tool: config.tools[tool] };
        } catch (e) {
            logger.error('Failed to update tool config', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

class ProviderConfigHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const result = {
                ws: config.ws || {},
                tools: config.tools || {},
            };
            
            this.response.type = 'application/json';
            this.response.body = result;
        } catch (e) {
            logger.error('Failed to get config', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }

    async post(params) {
        try {
            const { ws, tools } = this.request.body;
            
            if (ws !== undefined) {
                (config as any).ws = { ...config.ws, ...ws };
            }
            
            if (tools !== undefined) {
                (config as any).tools = { ...config.tools, ...tools };
            }
            
            saveConfig();
            
            logger.info('Updated provider config');
            
            this.response.type = 'application/json';
            this.response.body = { success: true, config };
        } catch (e) {
            logger.error('Failed to update config', e);
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('provider_tools_config', '/api/tools', ProviderToolsConfigHandler);
    ctx.Route('provider_config', '/api/config', ProviderConfigHandler);
}

