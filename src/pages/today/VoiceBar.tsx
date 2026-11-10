import { useEffect } from 'react'
import { recognitionAvailable, voice } from '../../lib/voice'
import { useVoice } from '../../lib/useVoice'

/** Microphone on/off for spoken commands, and what Max last heard. Voice and cue settings are in Config. */
export default function VoiceBar() {
  const v = useVoice()
  const wake = v.settings.wake || 'Max'
  // The browser only opens the microphone after the page has been clicked; pick listening back up on the first click.
  useEffect(() => { const f = () => voice.resume(); window.addEventListener('pointerdown', f, { once: true }); return () => window.removeEventListener('pointerdown', f) }, [])
  if (!recognitionAvailable()) return null
  return (
    <div className="voicebar">
      <span className="small muted hastip" data-pos="right" data-tip={`Spoken commands. Say "${wake}" then one word: go, stop, pain, tare, click (metronome), next (next weight and reps), plates (plates and chains), time (rest left), or a number for the reps of the next heavy set. Voice, cues and the wake word are set in Config → Voice.`}>Voice</span>
      <div className="metrorow">
        <button type="button" className={'switch' + (v.settings.listen ? ' on' : '')} aria-pressed={v.settings.listen} onClick={() => voice.setSettings({ listen: !v.settings.listen })}
          data-tip={v.settings.listen ? 'Stop listening' : 'Listen for commands'} data-pos="center">{v.listening ? '● Mic' : 'Mic'}</button>
        {v.heard && <span className="small muted heard">“{v.heard}”</span>}
      </div>
      {v.error && <span className="small err">{v.error}</span>}
    </div>
  )
}
