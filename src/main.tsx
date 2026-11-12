import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

// iPhone Safari ignores user-scalable=no; stop its pinch gestures directly.
document.addEventListener('gesturestart', e => e.preventDefault())
document.addEventListener('touchmove', e => { if ((e as TouchEvent).touches.length > 1) e.preventDefault() }, { passive: false })
