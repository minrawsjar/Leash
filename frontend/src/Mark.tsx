/** The Leash mark: a handle loop, a slack lead and a snap clip. */
export const Mark = ({ size = 28 }: { size?: number }) => (
  <svg className="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <rect x="2" y="2" width="60" height="60" rx="18" fill="var(--mint)" />
    <g fill="none" stroke="var(--ink)" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.5 29C12.5 25 11 12.5 19.5 11.5S30 20 23.5 29" strokeWidth="4.8" />
      <path d="M22.5 29.5C23 41 31 44 40 44" strokeWidth="4.8" />
      <path d="M40 44h4.5" strokeWidth="7" />
      <path d="M45 44h2.5a5 5 0 0 1 0 10H45" strokeWidth="3.6" />
    </g>
  </svg>
);
