import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Site } from './site/Site';
import './theme.css';

// Two pages, no router dependency: the landing site at /, the dApp at /app. The app (and viem) loads only on /app.
const App = lazy(() => import('./app/App').then((m) => ({ default: m.App })));
const isApp = location.pathname.replace(/\/$/, '').endsWith('/app');
createRoot(document.getElementById('root')!).render(
  <StrictMode>{isApp ? <Suspense fallback={null}><App /></Suspense> : <Site />}</StrictMode>,
);
