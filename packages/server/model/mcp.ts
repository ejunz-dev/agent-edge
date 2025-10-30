import { Context } from 'cordis';
import { callTool, listTools } from '../mcp-tools';

export function getMCPTools() {
    return listTools().map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
    }));
}

export function createMCPDispatchers() {
    const dispatchers: Record<string, (ctx: Context, req: any) => Promise<any>> = {
        'tools/list': async () => ({ tools: getMCPTools() }),
        'tools/call': async (ctx, request) => {
            const { name, arguments: args } = request.params || {};
            const result = await callTool(ctx, { name, arguments: args || {} });
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        },
        'resources/list': async () => ({ resources: [] }),
        'resources/read': async () => { throw new Error('资源功能未启用'); },
        'notifications/initialized': async () => ({}),
    };
    return dispatchers;
}


