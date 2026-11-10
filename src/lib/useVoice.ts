import { useSyncExternalStore } from 'react'
import { voice } from './voice'

/** Live voice settings and listening state. */
export const useVoice = () => useSyncExternalStore(voice.subscribe, voice.get)
