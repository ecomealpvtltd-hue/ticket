import type { Config } from '@netlify/functions';
import { handleEmbed } from '../../src/server/app.js';

export default async (req: Request) => handleEmbed(req);

export const config: Config = { path: '/embed/*' };
