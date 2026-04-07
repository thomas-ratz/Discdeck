import { createRoot } from 'react-dom/client';
import App from './App.js';

// NOTE: StrictMode is intentionally disabled. Its dev-mode effect
// double-invoke interacts badly with the VideoPlayer's MediaSource
// lifecycle (re-attaching a MediaSource to the same <video> element
// silently detaches the first one, leaving its SourceBuffer orphaned).
// The production build runs without StrictMode regardless, so we lose
// no production safety by dropping it here.
const container = document.getElementById('root');
if (!container) throw new Error('#root not found');
createRoot(container).render(<App />);
