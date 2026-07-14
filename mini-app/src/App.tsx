import { useState, useEffect } from 'react';
import { authenticate } from '@/api';
import MatchsTab from '@/tabs/MatchsTab';
import WalletTab from '@/tabs/WalletTab';
import CouponsTab from '@/tabs/CouponsTab';
import BottomNav from '@/components/BottomNav';
import './index.css';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready: () => void;
        expand: () => void;
        close: () => void;
      };
    };
  }
}

type Tab = 'matchs' | 'wallet' | 'coupons';

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('matchs');

  useEffect(() => {
    window.Telegram?.WebApp?.expand();

    const initData = window.Telegram?.WebApp?.initData ?? '';

    // Hors contexte Telegram : afficher un message d'instruction
    if (!initData) {
      setLoading(false);
      window.Telegram?.WebApp?.ready();
      return;
    }

    const saved = localStorage.getItem('editbot_token');
    if (saved) {
      setToken(saved);
      setLoading(false);
      window.Telegram?.WebApp?.ready();
      return;
    }

    authenticate(initData)
      .then(({ token: t }) => {
        localStorage.setItem('editbot_token', t);
        setToken(t);
        window.Telegram?.WebApp?.ready();
      })
      .catch((err: Error) => {
        setAuthError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  function retry() {
    localStorage.removeItem('editbot_token');
    setAuthError(null);
    setLoading(true);
    const initData = window.Telegram?.WebApp?.initData ?? '';
    authenticate(initData)
      .then(({ token: t }) => {
        localStorage.setItem('editbot_token', t);
        setToken(t);
      })
      .catch((err: Error) => setAuthError(err.message))
      .finally(() => setLoading(false));
  }

  if (loading) {
    return (
      <div className="spinner-screen">
        <div className="spinner" />
        <span className="spinner-label">Connexion…</span>
      </div>
    );
  }

  if (authError) {
    return (
      <div className="spinner-screen">
        <div style={{ textAlign: 'center', padding: '0 24px' }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <p style={{ color: 'var(--text)', marginBottom: 8, fontWeight: 600 }}>Erreur d'authentification</p>
          <p style={{ color: 'var(--muted)', marginBottom: 20, fontSize: 13 }}>{authError}</p>
          <button className="btn-primary" style={{ marginTop: 0 }} onClick={retry}>Réessayer</button>
        </div>
      </div>
    );
  }

  // Hors Telegram : message d'instruction
  if (!token && !authError) {
    return (
      <div className="spinner-screen">
        <div style={{ textAlign: 'center', padding: '0 28px' }}>
          <div style={{ fontSize: 48, marginBottom: 14 }}>⚽</div>
          <p style={{ color: 'var(--text)', fontWeight: 700, fontSize: 18, marginBottom: 8 }}>Editbot</p>
          <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
            Ouvre cette application depuis Telegram pour diffuser les scores en direct sur tes Pages Facebook.
          </p>
        </div>
      </div>
    );
  }

  if (!token) return null;

  return (
    <div className="app">
      <div className="tab-content">
        {tab === 'matchs'  && <MatchsTab  token={token} />}
        {tab === 'wallet'  && <WalletTab  token={token} />}
        {tab === 'coupons' && <CouponsTab token={token} />}
      </div>
      <BottomNav active={tab} onSelect={setTab} />
    </div>
  );
}
