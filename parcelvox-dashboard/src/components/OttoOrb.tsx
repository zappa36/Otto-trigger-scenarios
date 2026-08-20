import styles from './OttoOrb.module.css';

interface OttoOrbProps {
  /** `chat` is the 26px bubble avatar, `pin` the 28px marker on the map. */
  variant: 'chat' | 'pin';
  title?: string;
}

export function OttoOrb({ variant, title = 'Otto' }: OttoOrbProps) {
  return (
    <span className={`${styles.orb} ${styles[variant]}`} title={title} aria-hidden>
      <span className={styles.blob} />
      <span className={styles.gloss} />
      <span className={styles.eyes}>
        <span className={styles.eye}>
          <i />
        </span>
        <span className={styles.eye}>
          <i />
        </span>
      </span>
    </span>
  );
}
