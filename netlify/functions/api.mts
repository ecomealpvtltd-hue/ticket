import type { Config, Context } from '@netlify/functions';
import { handleApi } from '../../src/server/app.js';

export default async (req: Request, context: Context) =>
  handleApi(req, {
    ip: context.ip,
    waitUntil: typeof (context as any).waitUntil === 'function' ? (p) => (context as any).waitUntil(p) : undefined,
  });

export const config: Config = { path: '/api/*' };
