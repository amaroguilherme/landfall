import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// NASA Horizon Design System: tokens, base styles and self-hosted fonts (Inter, Public Sans,
// DM Mono). Bundled by Vite from node_modules; nothing is fetched from another origin.
import '@nasa-hds/core/css'
import './styles/tokens.css'
import './index.css'
import './styles/shell.css'
import App from './App.tsx'

document.documentElement.setAttribute('data-hds-palette', 'dark')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
