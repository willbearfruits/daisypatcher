import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/layout/ErrorBoundary'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

// The boundary sits OUTSIDE App: a render error anywhere — including in
// the theme provider — lands on a screen that can still save the patch.
// The theme's CSS vars live on :root and survive the tree below unmounting.
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
