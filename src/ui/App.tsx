import { useEffect, useRef } from 'preact/hooks';
import { useApp, setChatWidth, fail } from '../store';
import { TopBar } from './TopBar';
import { Schedule } from './Schedule';
import { Chat } from './Chat';
import { SettingsDialog } from './Settings';
import { STATIC } from '../mode';

export function App() {
  const s = useApp();
  const dragging = useRef(false);

  // Splitter between the schedule and the chat pane.
  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) setChatWidth(window.innerWidth - e.clientX); };
    const up = () => { if (dragging.current) { dragging.current = false; document.body.classList.remove('dragging'); } };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  useEffect(() => {
    const onErr = (e: PromiseRejectionEvent) => fail(e.reason);
    window.addEventListener('unhandledrejection', onErr);
    return () => window.removeEventListener('unhandledrejection', onErr);
  }, []);

  return (
    <div class="app" style={{ '--cw': `${s.chatWidth}px` }}>
      <TopBar />
      <div class="center"><Schedule /></div>
      <div class="splitter" onMouseDown={(e) => { e.preventDefault(); dragging.current = true; document.body.classList.add('dragging'); }} />
      <div class="chatpane"><Chat /></div>
      {STATIC && <SettingsDialog />}
      {s.error && <div class="toast err">{s.error}</div>}
    </div>
  );
}
