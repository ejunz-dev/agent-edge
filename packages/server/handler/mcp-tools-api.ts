import { Handler } from '@ejunz/framework';
import { Context } from 'cordis';
import { createMCPDispatchers, getMCPTools } from '../model/mcp';
import { nodeTools } from './node';

type MCPToolDoc = {
    _id: string;
    name: string;
    description: string;
    server: string;
    callCount: number;
    lastCalled?: number;
    createdAt?: number;
    metadata?: Record<string, any>;
};

function buildDocId(tool: any): string {
    if (tool?.metadata?.docId) return tool.metadata.docId;
    if (tool?.metadata?.nodeId) return `node:${tool.metadata.nodeId}:${tool.name}`;
    return `server:local:${tool.name}`;
}

class MCPToolsHandler extends Handler<Context> {
    allowCors = true;

    async get() {
        try {
            const listMode = this.request.query?.list;
            const aggregated = getMCPTools() || [];
            const db = (this.ctx as any).db?.mcptool || null;
            let docs: MCPToolDoc[] = [];
            if (db) {
                try {
                    docs = await db.find({}) as MCPToolDoc[];
                } catch (e) {
                    this.ctx.logger('handler/mcp-tools').warn?.('读取 MCP 工具数据库失败: %s', (e as Error).message);
                }
            }
            const docMap = new Map<string, MCPToolDoc>(docs.map((doc) => [doc._id, doc]));
            const combined: MCPToolDoc[] = [];

            for (const tool of aggregated) {
                const docId = buildDocId(tool);
                const doc = docMap.get(docId);
                const metadata = {
                    ...(tool.metadata || {}),
                    ...(doc?.metadata || {}),
                };
                combined.push({
                    _id: docId,
                    name: tool.name,
                    description: doc?.description ?? tool.description,
                    server: metadata.nodeId || 'local',
                    callCount: doc?.callCount ?? 0,
                    lastCalled: doc?.lastCalled,
                    createdAt: doc?.createdAt,
                    metadata,
                });
            }

            for (const doc of docs) {
                if (combined.some((item) => item._id === doc._id)) continue;
                combined.push({
                    _id: doc._id,
                    name: doc.name,
                    description: doc.description,
                    server: doc.server,
                    callCount: doc.callCount,
                    lastCalled: doc.lastCalled,
                    createdAt: doc.createdAt,
                    metadata: {
                        ...(doc.metadata || {}),
                        status: (doc.metadata && doc.metadata.status) || 'offline',
                    },
                });
            }

            combined.sort((a, b) => {
                if (a.server !== b.server) return a.server.localeCompare(b.server);
                return a.name.localeCompare(b.name);
            });

            this.response.type = 'application/json';
            if (listMode) {
                this.response.body = { total: combined.length, tools: combined };
            } else {
                this.response.body = { tools: combined };
            }
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }

    async post() {
        const body = this.request.body || {};
        const operation = body.operation;

        if (operation === 'call') {
            const toolName = body.tool || body.name;
            const args = body.arguments || {};
            if (!toolName) {
                this.response.status = 400;
                this.response.body = { error: '缺少 tool 参数' };
                return;
            }
            try {
                const dispatchers = createMCPDispatchers();
                const result = await dispatchers['tools/call'](this.ctx, { params: { name: toolName, arguments: args } });
                this.response.type = 'application/json';
                this.response.body = { success: true, result };
                return;
            } catch (e) {
                this.response.status = 500;
                this.response.body = { error: (e as Error).message };
                return;
            }
        }

        if (operation === 'update') {
            const docIdInput = body._id;
            const toolName = body.tool || body.name;
            const description = body.description;
            if (!docIdInput && !toolName) {
                this.response.status = 400;
                this.response.body = { error: '缺少 _id 或 tool 参数' };
                return;
            }
            const db = (this.ctx as any).db?.mcptool;
            if (!db) {
                this.response.status = 500;
                this.response.body = { error: '数据库未初始化' };
                return;
            }

            const aggregated = getMCPTools() || [];
            const matchedTool = toolName ? aggregated.find((tool) => tool.name === toolName) : undefined;
            let docId = docIdInput || (matchedTool ? buildDocId(matchedTool) : null);
            if (!docId) {
                this.response.status = 404;
                this.response.body = { error: '未找到对应的工具' };
                return;
            }

            let existing = await db.findOne({ _id: docId });
            const now = Date.now();
            if (!existing && matchedTool) {
                existing = {
                    _id: docId,
                    name: matchedTool.name,
                    server: matchedTool.metadata?.nodeId || 'local',
                    description: matchedTool.description,
                    callCount: 0,
                    createdAt: now,
                    metadata: matchedTool.metadata || {},
                } as MCPToolDoc;
            }
            if (!existing) {
                existing = {
                    _id: docId,
                    name: toolName,
                    server: 'local',
                    description: description || '',
                    callCount: 0,
                    createdAt: now,
                    metadata: {},
                } as MCPToolDoc;
            }

            const updatedDescription = description ?? existing.description;
            const metadata = {
                ...(matchedTool?.metadata || {}),
                ...(existing.metadata || {}),
                updatedAt: now,
                defaultDescription: (matchedTool?.metadata?.defaultDescription)
                    || (existing.metadata && existing.metadata.defaultDescription)
                    || matchedTool?.description
                    || existing.description,
            };

            await db.update(
                { _id: docId },
                {
                    $set: {
                        _id: docId,
                        name: existing.name || toolName,
                        server: existing.server || metadata.nodeId || 'local',
                        description: updatedDescription,
                        callCount: existing.callCount ?? 0,
                        lastCalled: existing.lastCalled,
                        createdAt: existing.createdAt ?? now,
                        metadata,
                    },
                },
                { upsert: true },
            );

            if (metadata.nodeId) {
                const tools = nodeTools.get(metadata.nodeId);
                if (tools) {
                    const updatedTools = tools.map((tool) => {
                        if (tool.name !== existing!.name) return tool;
                        return {
                            ...tool,
                            description: updatedDescription,
                            metadata: { ...(tool.metadata || {}), ...metadata },
                        };
                    });
                    nodeTools.set(metadata.nodeId, updatedTools);
                    try {
                        (this.ctx as any).emit?.('node/tools-updated', metadata.nodeId, updatedTools);
                    } catch {}
                }
            }

            this.response.type = 'application/json';
            this.response.body = { success: true, _id: docId };
            return;
        }

        this.response.status = 400;
        this.response.body = { error: '不支持的操作' };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('mcp_tools_api', '/mcp/tools', MCPToolsHandler);
}

