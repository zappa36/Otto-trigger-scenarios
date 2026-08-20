import { CloseIcon, KeyboardIcon } from './Icons';
import styles from './VoiceCapture.module.css';

interface VoiceCaptureProps {
  transcript: string;
  clock: string;
  /** Stop and send what Otto has heard. */
  onStop: () => void;
  onTypeInstead: () => void;
  onCancel: () => void;
}

export function VoiceCapture({
  transcript,
  clock,
  onStop,
  onTypeInstead,
  onCancel,
}: VoiceCaptureProps) {
  return (
    <div>
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.bars} aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ animationDelay: `${i * 0.14}s` }} />
            ))}
          </span>
          <span className={styles.status}>Listening…</span>
          <span className={styles.clock}>{clock}</span>
        </div>
        <p className={styles.transcript} aria-live="polite">
          {transcript}
          <span className={styles.caret} aria-hidden />
        </p>
      </div>

      <div className={styles.controls}>
        <button type="button" className={styles.small} title="Type instead" onClick={onTypeInstead}>
          <KeyboardIcon />
        </button>
        <button type="button" className={styles.stop} title="Stop and send" onClick={onStop}>
          <span className={styles.pulse} aria-hidden />
          <span className={styles.stopGlyph} aria-hidden />
        </button>
        <button type="button" className={styles.small} title="Cancel" onClick={onCancel}>
          <CloseIcon />
        </button>
      </div>

      <p className={styles.hint}>Tap ■ to stop — the answer comes from the knowledge base</p>
    </div>
  );
}
