import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Pet } from './Pet.js'
import { Panel } from './Panel.js'
import './styles/app.css'

// One bundle serves both windows; the hash picks which one this is.
const view = window.location.hash.replace('#', '') || 'panel'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{view === 'pet' ? <Pet /> : <Panel />}</StrictMode>
)
