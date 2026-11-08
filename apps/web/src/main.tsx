import './i18n'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppTab } from './AppTab'
import '../../server/themes.css'
import './workbench.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppTab />
  </StrictMode>,
)
