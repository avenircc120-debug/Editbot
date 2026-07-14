-- =============================================
-- Migration 008 — Nettoyage tables obsolètes
-- Supprime toutes les tables, vues et fonctions
-- de l'ancien système (pronostics, MASAP, marchés,
-- sources hybrides). Ne touche pas aux tables actives.
-- =============================================

-- ─── Vues matérialisées ───────────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS meilleure_cote_par_match CASCADE;

-- ─── Vues ordinaires ─────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_matchs_avec_pronostics    CASCADE;
DROP VIEW IF EXISTS v_matchs_disponibles        CASCADE;
DROP VIEW IF EXISTS v_sheets_analyse_groq        CASCADE;
DROP VIEW IF EXISTS v_sheets_base_connaissance  CASCADE;
DROP VIEW IF EXISTS v_sheets_raw_web_data       CASCADE;

-- ─── Tables obsolètes ────────────────────────────────────────────────────────
DROP TABLE IF EXISTS pronostics_finaux           CASCADE;
DROP TABLE IF EXISTS pronostics_pre_calcules     CASCADE;
DROP TABLE IF EXISTS historique_performances     CASCADE;
DROP TABLE IF EXISTS marches_bookmakers          CASCADE;
DROP TABLE IF EXISTS analyse_confrontation       CASCADE;
DROP TABLE IF EXISTS whitelist_matchs            CASCADE;
DROP TABLE IF EXISTS marches_bruts               CASCADE;
DROP TABLE IF EXISTS matchs_historique           CASCADE;
DROP TABLE IF EXISTS user_competitions           CASCADE;

-- Tables anciennes non encore supprimées (si présentes)
DROP TABLE IF EXISTS analyse_groq                CASCADE;
DROP TABLE IF EXISTS analyse_ia_groq             CASCADE;
DROP TABLE IF EXISTS archive_stats               CASCADE;
DROP TABLE IF EXISTS base_connaissance           CASCADE;
DROP TABLE IF EXISTS historique_performances     CASCADE;
DROP TABLE IF EXISTS logs_predictions            CASCADE;
DROP TABLE IF EXISTS marches_bookmakers          CASCADE;
DROP TABLE IF EXISTS predictions_cache           CASCADE;
DROP TABLE IF EXISTS raw_web_data                CASCADE;
DROP TABLE IF EXISTS recherches_bot              CASCADE;
DROP TABLE IF EXISTS scraping_temp               CASCADE;

-- ─── Fonctions obsolètes ─────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS recherche_cote_marche(TEXT, TEXT, TEXT, NUMERIC) CASCADE;
DROP FUNCTION IF EXISTS rafraichir_meilleures_cotes()                     CASCADE;
DROP FUNCTION IF EXISTS purger_pronostics_finaux_expires()                CASCADE;
DROP FUNCTION IF EXISTS quota_consommer(TEXT)                             CASCADE;
