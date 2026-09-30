import { installMockApi, prototypeBoot } from './mock.ts';
installMockApi();
const boot = document.createElement('script');
boot.type = 'application/json';
boot.id = 'sp-boot';
boot.textContent = JSON.stringify(prototypeBoot());
document.head.appendChild(boot);
if (new URLSearchParams(location.search).get('preview') === '1') document.documentElement.classList.add('is-preview');
await import('../client/embed/main.tsx');
