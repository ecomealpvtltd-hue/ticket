import { installMockApi, resetPrototype } from './mock.ts';
installMockApi();

// Load the real widget exactly as a customer site would: one script tag.
const s = document.createElement('script');
s.src = new URL('widget.js', location.href).href;
s.setAttribute('data-key', 'pk_live_demo7Kq2Xw9Lm4Rt8Vn3');
s.async = true;
document.body.appendChild(s);

const views = { site: document.getElementById('view-site')!, dash: document.getElementById('view-dash')! };
const frame = document.getElementById('dash-frame') as HTMLIFrameElement;
const tabs = document.querySelectorAll<HTMLButtonElement>('[data-view]');
const launcher = () => document.querySelector('support-widget-root') as HTMLElement | null;

function show(view: 'site' | 'dash') {
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.view === view));
  views.site.hidden = view !== 'site';
  views.dash.hidden = view !== 'dash';
  const l = launcher();
  if (view === 'dash') {
    (window as any).SupportWidget?.close();
    if (l) l.style.setProperty('display', 'none', 'important');
    frame.src = new URL('admin.html', location.href).href; // fresh data every time
  } else if (l) {
    l.style.setProperty('display', 'block', 'important');
  }
}
for (const t of tabs) t.addEventListener('click', () => show(t.dataset.view as 'site' | 'dash'));
document.getElementById('open-support')?.addEventListener('click', () => (window as any).SupportWidget?.open());

const reset = document.getElementById('reset') as HTMLButtonElement;
const confirmBox = document.getElementById('reset-confirm')!;
reset.addEventListener('click', () => { confirmBox.hidden = false; });
document.getElementById('reset-no')!.addEventListener('click', () => { confirmBox.hidden = true; });
document.getElementById('reset-yes')!.addEventListener('click', () => { resetPrototype(); location.reload(); });

show('site');
