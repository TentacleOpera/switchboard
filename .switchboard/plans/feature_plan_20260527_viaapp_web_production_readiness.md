# Plan: viaapp-web Production Readiness — Index

## Goal

Take the viaapp-web prototype from mock data to a real, hosted product. This index breaks the work into 5 self-contained plans, each executable in a single session.

## Background

viaapp-web is a companion web product for app subscribers (Customer type), focused on rich analytics and insights dashboards. The prototype is visually complete with 6 screens on mock data. React Query is already installed. The backend is standard Express REST with JWT auth and CORS open.

## Phases

| Plan | Phase | Gate |
|---|---|---|
| [feature_plan_20260527_viaapp_web_phase0_insights_dashboard.md](feature_plan_20260527_viaapp_web_phase0_insights_dashboard.md) | Polish — full Insights screen, all mock data, no backend | Start here |
| [feature_plan_20260527_viaapp_web_phase1_foundation.md](feature_plan_20260527_viaapp_web_phase1_foundation.md) | Foundation — env config, API client, resource files | Required before all other phases |
| [feature_plan_20260527_viaapp_web_phase2_auth.md](feature_plan_20260527_viaapp_web_phase2_auth.md) | Auth — login screen, auth context, protected routes, token refresh | Requires Phase 1 |
| [feature_plan_20260527_viaapp_web_phase3_screen_migrations.md](feature_plan_20260527_viaapp_web_phase3_screen_migrations.md) | Screen Migrations — replace mockData with useQuery per screen | Requires Phase 2 |
| [feature_plan_20260527_viaapp_web_phase4_ux_polish.md](feature_plan_20260527_viaapp_web_phase4_ux_polish.md) | UX Polish — loading skeletons, error states, empty states, member switching | Requires Phase 2, alongside Phase 3 |
| [feature_plan_20260527_viaapp_web_phase5_deployment.md](feature_plan_20260527_viaapp_web_phase5_deployment.md) | Deployment — Dockerfile, Helm chart, GitLab CI/CD, GKE | Requires Phase 2 (can deploy before Phase 3 is complete) |
