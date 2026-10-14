import { render } from 'preact';
import { App } from './ui/App';
import { connect } from './ws';
import { loadSnapshot } from './store';
import './style.css';

render(<App />, document.getElementById('app')!);
loadSnapshot().catch(() => {});
connect();
