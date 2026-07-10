-- Migration 005 — Nettoyage : suppression des anciennes tables/vues de
-- pronostics, prédictions et scraping mort. Voir README pour l'architecture.
DROP VIEW IF EXISTS
  v_matchs_avec_pronostics, v_matchs_disponibles, v_sheets_analyse_groq,
  v_sheets_base_connaissance, v_sheets_raw_web_data
CASCADE;

DROP TABLE IF EXISTS
  pronostics_finaux, pronostics_pre_calcules, analyse_confrontation,
  analyse_groq, analyse_ia_groq, archive_stats, historique_performances,
  logs_predictions, marches_bookmakers, marches_bruts, predictions_cache,
  raw_web_data, recherches_bot, scraping_temp, base_connaissance,
  matchs_historique
CASCADE;
