-- Suivi de la dernière minute de jeu publiée sur Facebook pour un match,
-- indépendant de raw_status (qui, lui, reste rafraîchi à chaque cycle pour
-- l'affichage Mini App / portail). Sert à live-cron pour n'envoyer une mise
-- à jour Facebook du seul chronomètre (sans but ni changement de statut)
-- que tous les 5 minutes de jeu plutôt qu'à chaque cycle cron (1 min) —
-- évite d'épuiser le quota anti-spam Facebook #368 les jours à plusieurs
-- matchs simultanés.
ALTER TABLE matchs_index ADD COLUMN IF NOT EXISTS last_broadcast_minute integer;
