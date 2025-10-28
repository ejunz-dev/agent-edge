import { Context, Service } from 'cordis';
import { config } from '../config';
import { Logger } from '../utils';

const logger = new Logger('fetcher');

export interface IBasicFetcher {
    contest: Record<string, any>
    cron(): Promise<void>
    contestInfo(): Promise<boolean>
}

class BasicFetcher extends Service implements IBasicFetcher {
    contest: any = { id: 'mcp-mode', name: 'MCP Server Mode' };
    logger = this.ctx.logger('fetcher');

    constructor(ctx: Context) {
        super(ctx, 'fetcher');
    }

    [Service.init]() {
        this.logger.info('Fetcher initialized in MCP mode');
    }

    async cron() {
        // No fetching needed in MCP mode
    }

    async contestInfo() {
        return false;
    }
}

export async function apply(ctx: Context) {
    ctx.plugin(BasicFetcher);
}
