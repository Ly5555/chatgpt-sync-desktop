import styles from '../index.module.css'

export function LobsterLogo({ className }) {
  return (
    <div className={className} aria-hidden="true">
      <svg viewBox="0 0 64 64" className={styles.lobsterSvg}>
        <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M24 18c-6-6-13-3-14 3 5 1 10-1 13-6 1 5-1 10-6 13" />
          <path d="M40 18c6-6 13-3 14 3-5 1-10-1-13-6-1 5 1 10 6 13" />
          <path d="M32 19c-5 0-9 4-9 9 0 3 1 5 3 7-4 2-7 6-7 10 0 6 6 11 13 11s13-5 13-11c0-4-3-8-7-10 2-2 3-4 3-7 0-5-4-9-9-9Z" />
          <path d="M26 38c2 2 4 3 6 3s4-1 6-3" />
          <path d="M28 12l-3-5" />
          <path d="M36 12l3-5" />
          <path d="M20 39l-7 4" />
          <path d="M21 45l-8 2" />
          <path d="M44 39l7 4" />
          <path d="M43 45l8 2" />
          <path d="M29 56l-3 5" />
          <path d="M35 56l3 5" />
          <circle cx="28" cy="27" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="36" cy="27" r="1.5" fill="currentColor" stroke="none" />
        </g>
      </svg>
    </div>
  )
}
