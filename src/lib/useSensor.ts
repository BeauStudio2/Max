import { useSyncExternalStore } from 'react'
import { sensor } from './tindeq'

/** Live state of the shared Tindeq connection. */
export const useSensor = () => useSyncExternalStore(sensor.subscribe, sensor.get)
