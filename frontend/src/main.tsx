import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Site } from './site/Site';
import { App } from './app/App';
import './theme.css';

// Two pages, no router dependency: the landing site at /, the dApp at /app.
const isApp = location.pathname.replace(/\/$/, '').endsWith('/app');
createRoot(document.getElementById('root')!).render(<StrictMode>{isApp ? <App /> : <Site />}</StrictMode>);
