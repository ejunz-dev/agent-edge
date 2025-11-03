import { Context } from 'cordis';
import { Logger } from '@ejunz/utils';
import { callTool, listTools } from '../mcp-tools';
import { getAllNodeTools, connectedNodes } from '../handler/node';

const logger = new Logger('server-mcp');

export function getMCPTools() {
    // 合并 Server 工具和 Node 工具
    const serverTools = listTools().map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters || t.inputSchema || { type: 'object', properties: {} },
    }));
    const nodeTools = getAllNodeTools();
    return [...serverTools, ...nodeTools];
}

// 查找工具属于哪个 Node（如果存在）
function findToolNode(toolName: string): string | null {
    const { nodeTools } = require('../handler/node');
    for (const [nodeId, tools] of nodeTools.entries()) {
        if (tools.some((t: any) => t.name === toolName)) {
            return nodeId;
        }
    }
    return null;
}

export function createMCPDispatchers() {
    const dispatchers: Record<string, (ctx: Context, req: any) => Promise<any>> = {
        'tools/list': async () => ({ tools: getMCPTools() }),
        'tools/call': async (ctx, request) => {
            const { name, arguments: args } = request.params || {};
            const startTime = Date.now();
            
            // 记录工具调用开始
            logger.info('[MCP工具调用] %s 参数: %o', name, args);
            
            // 检查是否是 Node 工具
            const nodeId = findToolNode(name);
            if (nodeId) {
                // 通过 HTTP API 调用 Node 工具
                const node = connectedNodes.get(nodeId);
                if (!node) {
                    logger.error('[MCP工具调用] Node %s 未连接', nodeId);
                    throw new Error(`Node ${nodeId} 未连接`);
                }
                
                // 获取 Node 的地址
                const nodeHost = (node as any).nodeHost || 'localhost';
                const nodePort = (node as any).nodePort || 5284;
                const nodeUrl = `http://${nodeHost}:${nodePort}`;
                
                logger.info('[MCP工具调用] 转发到 Node %s (%s:%d)', nodeId, nodeHost, nodePort);
                
                const superagent = require('superagent');
                
                try {
                    // 统一通过工具执行 API 调用 Node 工具（这样可以获取完整的状态信息）
                    const toolResp = await superagent
                        .post(`${nodeUrl}/zigbee2mqtt/tool/execute`)
                        .send({ toolName: name, arguments: args })
                        .timeout(10000);
                    
                    if (toolResp.body?.error) {
                        throw new Error(toolResp.body.error);
                    }
                    
                    const result = toolResp.body?.result || toolResp.body;
                    const duration = Date.now() - startTime;
                    const resultPreview = typeof result === 'object' 
                        ? JSON.stringify(result).substring(0, 200) 
                        : String(result).substring(0, 200);
                    logger.success('[MCP工具调用] %s 成功 (耗时: %dms) 结果: %s', name, duration, resultPreview);
                    
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify(result)
                        }]
                    };
                } catch (error: any) {
                    const duration = Date.now() - startTime;
                    logger.error('[MCP工具调用] %s 失败 (耗时: %dms) 错误: %s', name, duration, error.message || String(error));
                    throw error;
                }
            } else {
                // Server 本地工具
                const result = await callTool(ctx, { name, arguments: args || {} });
                return { content: [{ type: 'text', text: JSON.stringify(result) }] };
            }
        },
        'resources/list': async () => ({ resources: [] }),
        'resources/read': async () => { throw new Error('资源功能未启用'); },
        'notifications/initialized': async () => ({}),
    };
    return dispatchers;
}


