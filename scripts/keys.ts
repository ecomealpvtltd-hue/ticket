// Prints fresh random secrets for SESSION_SECRET and ENCRYPTION_KEY. Paste them into Netlify.
import { randomBytes } from 'node:crypto';
console.log(`SESSION_SECRET=${randomBytes(36).toString('base64url')}`);
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
