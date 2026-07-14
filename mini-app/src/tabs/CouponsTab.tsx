import { useState, useEffect } from 'react';
import type { Coupon } from '@/api';
import { getCoupons, addCoupon, deleteCoupon } from '@/api';

interface AddModalProps {
  token: string;
  onClose: () => void;
  onDone: () => void;
}

function AddCouponModal({ token, onClose, onDone }: AddModalProps) {
  const [bookmaker, setBookmaker] = useState('');
  const [code, setCode]           = useState('');
  const [description, setDesc]    = useState('');
  const [price, setPrice]         = useState('');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState<string | null>(null);

  async function submit() {
    if (!bookmaker.trim() || !code.trim()) { setErr('Bookmaker et code requis'); return; }
    setBusy(true);
    setErr(null);
    try {
      await addCoupon(token, {
        bookmaker: bookmaker.trim(),
        code: code.trim().toUpperCase(),
        description: description.trim() || undefined,
        price: price ? Number(price) : undefined,
      });
      onDone();
      onClose();
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-header">
        <span className="modal-title">Nouveau coupon</span>
        <button className="btn-close" onClick={onClose}>×</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 24px' }}>
        {err && <div style={{ color: 'var(--red)', fontSize: 13, margin: '12px 0' }}>{err}</div>}

        <label className="form-label">Bookmaker *</label>
        <input
          className="form-input"
          type="text"
          placeholder="1xBet, 1win, Betway…"
          value={bookmaker}
          onChange={e => setBookmaker(e.target.value)}
        />

        <label className="form-label">Code promo *</label>
        <input
          className="form-input"
          type="text"
          placeholder="CODE123"
          value={code}
          onChange={e => setCode(e.target.value.toUpperCase())}
          style={{ fontFamily: 'monospace', letterSpacing: '0.04em', textTransform: 'uppercase' }}
        />

        <label className="form-label">Description (optionnel)</label>
        <textarea
          className="form-textarea"
          placeholder="Décris ton coupon, conditions, validité…"
          value={description}
          onChange={e => setDesc(e.target.value)}
        />

        <label className="form-label">Prix en FCFA (optionnel)</label>
        <input
          className="form-input"
          type="number"
          placeholder="Ex: 500"
          value={price}
          onChange={e => setPrice(e.target.value)}
          inputMode="numeric"
        />

        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Publication…' : 'Publier le coupon'}
        </button>
      </div>
    </div>
  );
}

function CouponCard({ coupon, onDelete }: { coupon: Coupon; onDelete: () => void }) {
  return (
    <div className="coupon-card">
      <button className="btn-delete-coupon" onClick={onDelete} title="Supprimer">🗑</button>
      <div className="coupon-bm">{coupon.bookmaker}</div>
      <div className="coupon-code">{coupon.code}</div>
      {coupon.description && <div className="coupon-desc">{coupon.description}</div>}
      {coupon.price != null && <div className="coupon-price">Prix : {coupon.price.toLocaleString('fr-FR')} FCFA</div>}
    </div>
  );
}

export default function CouponsTab({ token }: { token: string }) {
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setError(null);
    setLoading(true);
    try {
      const c = await getCoupons(token);
      setCoupons(c);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(coupon: Coupon) {
    if (!window.confirm(`Supprimer le coupon "${coupon.code}" ?`)) return;
    try {
      await deleteCoupon(token, coupon.id);
      setCoupons(prev => prev.filter(c => c.id !== coupon.id));
    } catch {
      // silent
    }
  }

  return (
    <>
      <button className="btn-add-full" onClick={() => setShowAdd(true)}>
        + Ajouter un coupon
      </button>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="btn-retry" onClick={load}>Réessayer</button>
        </div>
      )}

      {loading && (
        <>
          <div className="shimmer" style={{ height: 90 }} />
          <div className="shimmer" style={{ height: 90 }} />
        </>
      )}

      {!loading && coupons.length === 0 && !error && (
        <div className="empty-state">
          <div className="emoji">🎟️</div>
          <p>Aucun coupon. Ajoute des codes promotionnels !</p>
        </div>
      )}

      {!loading && coupons.map(c => (
        <CouponCard key={c.id} coupon={c} onDelete={() => handleDelete(c)} />
      ))}

      {showAdd && (
        <AddCouponModal token={token} onClose={() => setShowAdd(false)} onDone={load} />
      )}
    </>
  );
}
