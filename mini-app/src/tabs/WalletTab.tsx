import { useState, useEffect } from 'react';
import type { WalletData, Transaction } from '@/api';
import { getWallet, requestWalletOperation } from '@/api';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

const METHODES = ['Orange Money', 'Wave', 'MTN Mobile Money', 'Autre'];

interface SheetProps {
  type: 'depot' | 'retrait';
  onClose: () => void;
  onDone: () => void;
  token: string;
}

function OperationSheet({ type, onClose, onDone, token }: SheetProps) {
  const [amount, setAmount]   = useState('');
  const [methode, setMethode] = useState(METHODES[0]);
  const [note, setNote]       = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  async function submit() {
    const n = Number(amount);
    if (!n || n <= 0) { setErr('Montant invalide'); return; }
    setBusy(true);
    setErr(null);
    try {
      await requestWalletOperation(token, type, n, methode, note || undefined);
      onDone();
      onClose();
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-title">{type === 'depot' ? 'Dépôt' : 'Retrait'}</div>
        <div className="sheet-body">
          {err && <div style={{ color: 'var(--red)', fontSize: 13, marginBottom: 10 }}>{err}</div>}

          <label className="form-label">Montant en FCFA</label>
          <input
            className="form-input"
            type="number"
            placeholder="Ex: 5000"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            inputMode="numeric"
          />

          <label className="form-label">Méthode</label>
          <select className="form-select" value={methode} onChange={e => setMethode(e.target.value)}>
            {METHODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select>

          <label className="form-label">Note (optionnel)</label>
          <textarea
            className="form-textarea"
            placeholder="Ex: numéro de compte, informations supplémentaires…"
            value={note}
            onChange={e => setNote(e.target.value)}
          />

          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Envoi…' : 'Confirmer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TxRow({ tx }: { tx: Transaction }) {
  return (
    <div className="tx-card">
      <div className={`tx-icon ${tx.type}`}>
        {tx.type === 'depot' ? '⬆' : '⬇'}
      </div>
      <div className="tx-meta">
        <div className={`tx-amount ${tx.type}`}>
          {tx.type === 'depot' ? '+' : '-'}{tx.amount.toLocaleString('fr-FR')} FCFA
        </div>
        <div className="tx-method">{tx.methode ?? '—'}</div>
      </div>
      <div className="tx-right">
        <span className={`status-badge ${tx.status}`}>
          {tx.status === 'en_attente' ? 'En attente' : tx.status === 'validee' ? 'Validée' : 'Refusée'}
        </span>
        <div className="tx-date">{fmtDate(tx.created_at)}</div>
      </div>
    </div>
  );
}

export default function WalletTab({ token }: { token: string }) {
  const [wallet, setWallet]   = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [modal, setModal]     = useState<'depot' | 'retrait' | null>(null);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const w = await getWallet(token);
      setWallet(w);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <>
      {/* Balance card */}
      <div className="balance-card">
        <div className="balance-label">Solde disponible</div>
        <div className="balance-amount">
          {loading ? '…' : `${(wallet?.balance ?? 0).toLocaleString('fr-FR')} FCFA`}
        </div>
        <div className="balance-actions">
          <button className="btn-green-outline" onClick={() => setModal('depot')}>💳 Dépôt</button>
          <button className="btn-outline" onClick={() => setModal('retrait')}>📤 Retrait</button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-retry" onClick={load}>Réessayer</button>
        </div>
      )}

      {/* Transactions */}
      <div className="section-header" style={{ marginTop: 4 }}>
        Historique
        {wallet && <span className="badge">{wallet.transactions.length}</span>}
      </div>

      {loading && (
        <>
          <div className="shimmer" style={{ height: 58 }} />
          <div className="shimmer" style={{ height: 58 }} />
          <div className="shimmer" style={{ height: 58 }} />
        </>
      )}

      {!loading && (wallet?.transactions.length === 0 || !wallet) && !error && (
        <div className="empty-state">
          <div className="emoji">💰</div>
          <p>Aucune transaction pour le moment.</p>
        </div>
      )}

      {!loading && wallet?.transactions.map(tx => <TxRow key={tx.id} tx={tx} />)}

      {/* Operation sheet */}
      {modal && (
        <OperationSheet
          type={modal}
          token={token}
          onClose={() => setModal(null)}
          onDone={load}
        />
      )}
    </>
  );
}
