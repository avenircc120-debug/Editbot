type Tab = 'matchs' | 'facebook' | 'wallet' | 'coupons';

interface Props {
  active: Tab;
  onSelect: (t: Tab) => void;
}

export default function BottomNav({ active, onSelect }: Props) {
  return (
    <nav className="bottom-nav">
      <button className={`nav-btn${active === 'matchs' ? ' active' : ''}`} onClick={() => onSelect('matchs')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 2a14.5 14.5 0 0 0 0 20A14.5 14.5 0 0 0 12 2"/>
          <path d="M2 12h20"/>
        </svg>
        Matchs
      </button>
      <button className={`nav-btn${active === 'facebook' ? ' active' : ''}`} onClick={() => onSelect('facebook')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
        </svg>
        Facebook
      </button>
      <button className={`nav-btn${active === 'wallet' ? ' active' : ''}`} onClick={() => onSelect('wallet')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2"/>
          <path d="M16 12h.01"/>
          <path d="M2 10h20"/>
        </svg>
        Wallet
      </button>
      <button className={`nav-btn${active === 'coupons' ? ' active' : ''}`} onClick={() => onSelect('coupons')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          <line x1="9" y1="10" x2="15" y2="10"/>
          <line x1="12" y1="7" x2="12" y2="13"/>
        </svg>
        Coupons
      </button>
    </nav>
  );
}
