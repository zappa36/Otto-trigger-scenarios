import type { ReactNode } from 'react';
import type { OttoAnswer } from '../data/chat';
import { OperatorIcon } from './Icons';
import { OttoOrb } from './OttoOrb';
import { RichText } from './RichText';
import styles from './Chat.module.css';

export type ChatSurface = 'panel' | 'page';

/**
 * Tags the subtree with its surface so the bubble styles can differ, without
 * introducing a box of its own — the bubbles stay direct flex items of the
 * thread.
 */
function Surface({ surface, children }: { surface: ChatSurface; children: ReactNode }) {
  return (
    <div className={surface === 'panel' ? styles.panel : styles.page} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}

interface OperatorBubbleProps {
  surface: ChatSurface;
  text: string;
}

export function OperatorBubble({ surface, text }: OperatorBubbleProps) {
  return (
    <Surface surface={surface}>
      {surface === 'panel' ? (
        <div className={`${styles.turn} ${styles.operatorTurn}`}>
          <div className={styles.operatorBubble}>{text}</div>
          <span className={styles.avatar} title="Depot operator">
            <OperatorIcon />
          </span>
        </div>
      ) : (
        <div className={styles.operatorBubble}>{text}</div>
      )}
    </Surface>
  );
}

interface OttoBubbleProps {
  surface: ChatSurface;
  answer: OttoAnswer;
  onAction?: (action: string) => void;
}

export function OttoBubble({ surface, answer, onAction }: OttoBubbleProps) {
  const body = (
    <div className={styles.ottoBubble}>
      <p className={styles.lead}>
        <RichText text={answer.lead} />
      </p>

      {answer.bullets && (
        <div className={styles.bullets}>
          {answer.bullets.map((bullet, i) => (
            <div key={i} className={styles.bullet}>
              <span className={`${styles.bulletDot} ${toneClass(bullet.tone)}`} />
              <span>
                <RichText text={bullet.text} />
              </span>
            </div>
          ))}
        </div>
      )}

      {answer.rows && (
        <div className={styles.rows}>
          {answer.rows.map((row, i) => (
            <div key={i} className={styles.rowItem}>
              <span className={`${styles.rowDot} ${toneClass(row.tone)}`} />
              <span>
                <RichText text={row.label} />
              </span>
              <span
                className={`${styles.rowMeta} ${row.metaTone === 'warn' ? styles.rowMetaWarn : ''}`}
              >
                {row.meta}
              </span>
            </div>
          ))}
        </div>
      )}

      {answer.tail && (
        <p className={styles.tail}>
          <RichText text={answer.tail} />
        </p>
      )}

      {answer.sources && (
        <div className={styles.sources}>
          {answer.sources.map((source) => (
            <span key={source} className={styles.source}>
              {source}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Surface surface={surface}>
      {surface === 'panel' ? (
        <div className={`${styles.turn} ${styles.ottoTurn}`}>
          <OttoOrb variant="chat" />
          {body}
        </div>
      ) : (
        body
      )}
      {answer.actions?.length ? (
        <div className={styles.actions}>
          {answer.actions.map((action) => (
            <button
              key={action}
              type="button"
              className={styles.action}
              onClick={() => onAction?.(action)}
            >
              {action}
            </button>
          ))}
        </div>
      ) : null}
    </Surface>
  );
}

/** Otto composing an answer. */
export function OttoThinking({ surface }: { surface: ChatSurface }) {
  const dots = (
    <div className={styles.ottoBubble}>
      <span className={styles.thinking} role="status" aria-label="Otto is answering">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
  return (
    <Surface surface={surface}>
      {surface === 'panel' ? (
        <div className={`${styles.turn} ${styles.ottoTurn}`}>
          <OttoOrb variant="chat" />
          {dots}
        </div>
      ) : (
        dots
      )}
    </Surface>
  );
}

function toneClass(tone: 'honey' | 'green') {
  return tone === 'honey' ? styles.toneHoney : styles.toneGreen;
}
