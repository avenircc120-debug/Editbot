-- Réglage "diffusion automatique" par Page Facebook, indépendant du choix de
-- page fait au cas par cas en diffusion manuelle (broadcast_selections.fb_page_ids).
-- Permet à l'utilisateur de restreindre le mode automatique à une seule Page
-- (ex: pour réduire le volume de publications et le risque de blocage
-- anti-spam Facebook #368 quand plusieurs pages sont connectées).
ALTER TABLE facebook_connections ADD COLUMN IF NOT EXISTS auto_broadcast_enabled boolean NOT NULL DEFAULT true;
