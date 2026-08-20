import { useState, type FormEvent } from 'react';
import { MicIcon, SendIcon } from './Icons';
import styles from './Composer.module.css';

interface ComposerProps {
  placeholder: string;
  onSend: (text: string) => void;
  /** Switch back to voice. Omit to hide the mic button. */
  onSpeak?: () => void;
  autoFocus?: boolean;
}

export function Composer({ placeholder, onSend, onSpeak, autoFocus }: ComposerProps) {
  const [text, setText] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    onSend(text);
    setText('');
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <input
        className={styles.input}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
      />
      {onSpeak && (
        <button
          type="button"
          className={`${styles.round} ${styles.mic}`}
          title="Speak instead"
          onClick={onSpeak}
        >
          <MicIcon />
        </button>
      )}
      <button type="submit" className={`${styles.round} ${styles.send}`} title="Send">
        <SendIcon />
      </button>
    </form>
  );
}
