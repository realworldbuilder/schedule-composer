import { render } from 'preact';
import { App } from './ui/App';
import { STATIC } from './mode';
import './style.css';

render(<App />, document.getElementById('app')!);
if (STATIC) {
  import('./local/backend').then((m) => m.initLocal());
} else {
  Promise.all([import('./ws'), import('./store')]).then(([ws, store]) => { store.loadSnapshot().catch(() => {}); ws.connect(); });
}
