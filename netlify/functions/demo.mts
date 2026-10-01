import type { Config } from '@netlify/functions';
import { handleDemo } from '../../src/server/app.js';

export default async (req: Request) => handleDemo(req);

export const config: Config = { path: ['/demo', '/demo/*'] };
