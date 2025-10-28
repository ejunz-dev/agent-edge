import { Context } from 'cordis';
import {
    collectDefaultMetrics, Counter, Gauge, Metric, Registry,
} from 'prom-client';

declare module 'cordis' {
    interface Context {
        metrics: Registry;
    }
    interface Events {
        'mcp/tool/call': (server: string, tool: string) => void;
    }
}

export function createMetricsRegistry(ctx: Context) {
    const registry = new Registry();

    function createMetric<Q extends string, T extends (new (a: any) => Metric<Q>)>(
        C: T, name: string, help: string, extra?: T extends new (a: infer R) => any ? Partial<R> : never,
    ): T extends (new (a) => Gauge<Q>) ? Gauge<Q> : T extends (new (a) => Counter<Q>) ? Counter<Q> : Metric<Q> {
        const metric = new C({ name, help, ...(extra || {}) });
        registry.registerMetric(metric);
        return metric as any;
    }

    // MCP 服务器状态
    createMetric(Gauge, 'mcp_server_status', 'MCP server status', {
        labelNames: ['status'],
        async collect() {
            const servers = await ctx.db.mcpserver.find({});
            const online = servers.filter((s) => s.status === 'online').length;
            const offline = servers.filter((s) => s.status === 'offline').length;
            this.set({ status: 'online' }, online);
            this.set({ status: 'offline' }, offline);
        },
    });

    // MCP 工具数量
    createMetric(Gauge, 'mcp_tool_count', 'MCP tool count', {
        labelNames: ['server'],
        async collect() {
            const servers = await ctx.db.mcpserver.find({});
            for (const server of servers) {
                const tools = await ctx.db.mcptool.find({ server: server.name });
                this.set({ server: server.name }, tools.length);
            }
        },
    });

    // MCP 工具调用计数器
    const mcpToolCallCounter = createMetric(Counter, 'mcp_tool_calls', 'MCP tool calls', {
        labelNames: ['server', 'tool'],
    });

    ctx.on('mcp/tool/call', (server, tool) => {
        mcpToolCallCounter.inc({ server, tool });
    });

    collectDefaultMetrics({ register: registry });

    ctx.provide('metrics', registry);
    return registry;
}
