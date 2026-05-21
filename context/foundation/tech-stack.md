---
starter_id: 10x-astro-starter
package_manager: npm
project_name: bet-cup
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: false
  has_background_jobs: false
---

## Why this stack

Solo developer shipping a private prediction-pool web app in three weeks of after-hours work. Auth is the only technology-forcing feature in scope — admin-created accounts, login + password, change-password, login-redirect. Real-time updates, payments, AI/LLM features, background jobs, and external sports/fixtures integrations are explicit PRD non-goals. The 10x-astro-starter is the recommended default for the (web, js) cell and bundles exactly what BetCup needs out of the box: typed UI components, a relational database with auth ready to wire up, and an edge deploy target — clearing all four agent-friendly gates with first-class bootstrapper confidence so scaffolding should be smooth. Cloudflare Pages was picked as the deployment target (the starter's first default); CI is GitHub Actions with auto-deploy on merge to main, the starter's standard shape. PHP and Java/Spring were ruled out by stated avoids during shaping; with the JS/TS language family confirmed, the recommended-defaults map resolved cleanly to this starter without needing to walk the full custom interview.
