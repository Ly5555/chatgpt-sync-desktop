import styles from '../index.module.css'

function cx(...values) {
  return values.filter(Boolean).join(' ')
}

export function VersionCard({ title, required, installed, ok }) {
  return (
    <div className={cx(styles.versionCard, ok ? styles.versionCardOk : styles.versionCardWarn)}>
      <div className={styles.versionTop}>
        <div className={styles.versionTitle}>{title}</div>
        <div className={cx(styles.versionState, ok ? styles.versionStateOk : styles.versionStateWarn)}>{ok ? '已达标' : '需处理'}</div>
      </div>
      <div className={styles.versionLines}>
        <div className={styles.versionLine}>
          <span>需要</span>
          <strong>{required || '--'}</strong>
        </div>
        <div className={styles.versionLine}>
          <span>已安装</span>
          <strong>{installed || '--'}</strong>
        </div>
      </div>
    </div>
  )
}
