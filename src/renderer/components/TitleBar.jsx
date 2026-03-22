import styles from '../index.module.css'

export function TitleBar({ title, version, children }) {
  return (
    <header className={styles.windowTitlebar}>
      <div />
      <div className={styles.windowTitle}>
        <span>{title}</span>
        {version ? <span className={styles.windowTitleVersion}>v{version}</span> : null}
      </div>
      <div className={`${styles.windowTitlebarTools} ${styles.noDrag}`}>{children}</div>
    </header>
  )
}
