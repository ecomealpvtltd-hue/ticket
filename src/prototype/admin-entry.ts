import { installMockApi } from './mock.ts';
installMockApi();
await import('../client/admin/main.tsx');
