// Runs before every Netlify build. Fails the deploy early with a plain-English message when a
// required setting is missing, instead of deploying something that breaks at runtime.
const ctx = process.env.CONTEXT ?? 'local';
const isProd = ctx === 'production';
const problems: string[] = [];
const warnings: string[] = [];
const has = (k: string) => !!process.env[k] && process.env[k] !== '';

if (!has('SESSION_SECRET') || (process.env.SESSION_SECRET ?? '').length < 32) problems.push('SESSION_SECRET: set a random string of at least 32 characters (a password generator works).');
if (!has('ENCRYPTION_KEY') || (process.env.ENCRYPTION_KEY ?? '').length < 32) problems.push('ENCRYPTION_KEY: set a different random string of at least 32 characters. Do not change it later.');
if (has('SESSION_SECRET') && process.env.SESSION_SECRET === process.env.ENCRYPTION_KEY) problems.push('SESSION_SECRET and ENCRYPTION_KEY must be different values.');
if (!has('PUBLIC_BASE_URL')) problems.push('PUBLIC_BASE_URL: set to the public address, e.g. https://support.ecomeal.in');
if (!has('DATABASE_URL') && !has('NETLIFY_DB_URL')) warnings.push('No DATABASE_URL found at build time. That is fine if Netlify Database is enabled (it provides NETLIFY_DB_URL to functions).');
if (!has('GOOGLE_CLIENT_ID') || !has('GOOGLE_CLIENT_SECRET')) warnings.push('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: admin sign-in and Google sync stay disabled until they are.');
if (!has('BOOTSTRAP_OWNER_EMAILS')) warnings.push('BOOTSTRAP_OWNER_EMAILS not set: nobody will be able to sign in to a newly created workspace.');
if (has('APP_ENV') && process.env.APP_ENV !== 'production' && isProd) warnings.push(`APP_ENV is "${process.env.APP_ENV}" on the production site.`);
if (!has('ANTHROPIC_API_KEY')) warnings.push('ANTHROPIC_API_KEY not set: AI triage is off (tickets work normally).');

for (const w of warnings) console.warn(`check-env: note: ${w}`);
if (problems.length) {
  console.error('\ncheck-env: the deploy is missing required settings (Netlify → Site configuration → Environment variables):');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-env: ok (context: ${ctx})`);
