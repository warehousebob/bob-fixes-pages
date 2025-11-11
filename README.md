# Bob Fixes Pages 

Real-time UX/CRO audits on **Cloud Run**. Returns JSON “Fix Cards” used by the Chrome side panel.

## Quick Start
```bash
npm ci
npm start   # or: PORT=8080 node index.mjs
# Health: GET http://localhost:8080/health  -> { "ok": true, "ts": 1234567890 }
API
POST /audit

json
Copy code
{
  "url": "https://example.com",
  "html": "<!doctype html>... (optional)",
  "mode": "flash"
}
200 → JSON array of Fix Cards

json
Copy code
[
  {
    "id": "fxk_001",
    "category": "CTA|Trust|Layout|Accessibility|Performance|SEO|Clarity",
    "issue": "Plain-English problem",
    "impact": "H|M|L",
    "evidence": { "selectors": ["#hero h1"], "snippets": ["<h1>…</h1>"] },
    "suggested_change": "What to change and why.",
    "code_diff": "<minimal HTML/CSS patch or unified diff>",
    "test": "How to validate (metric, success).",
    "effort": 1,
    "tags": ["above-the-fold","copy","mobile"]
  }
]
Env
PORT (auto on Cloud Run)

GOOGLE_CLOUD_PROJECT (auto on GCP)

VERTEX_LOCATION (optional, e.g., us-west2)

Deploy (manual)
bash
Copy code
gcloud config set project tech-support-bob-477014
gcloud builds submit --tag us-west2-docker.pkg.dev/$PROJECT_ID/bob/opt-bob-green:latest
gcloud run deploy opt-bob-green \
  --image us-west2-docker.pkg.dev/$PROJECT_ID/bob/opt-bob-green:latest \
  --region us-west2 --allow-unauthenticated
CI/CD (Cloud Build)
Add cloudbuild.yaml (see below) and create a GitHub trigger on main.

Architecture (short)
Chrome Extension → bob-gateway (API) → opt-bob-green (fast audits, Gemini 2.5 Flash).
Deep audits: opt-bob-pro (Gemini 2.5 Pro).
Capture: bob-capture.

Google AI (Vertex AI)
Gemini 2.5 Flash — real-time Fix Cards

Gemini 2.5 Pro — deep remediation (on-demand)

text-embedding-004 — clustering & dedupe

License: MIT

bash
Copy code

### (Optional) Add `cloudbuild.yaml` at repo root
```yaml
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build","-t","us-west2-docker.pkg.dev/$PROJECT_ID/bob/opt-bob-green:$(date +%Y%m%d-%H%M%S)","."]
  - name: gcr.io/cloud-builders/docker
    args: ["push","us-west2-docker.pkg.dev/$PROJECT_ID/bob/opt-bob-green:$(date +%Y%m%d-%H%M%S)"]
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      ["run","deploy","opt-bob-green",
       "--image","us-west2-docker.pkg.dev/$PROJECT_ID/bob/opt-bob-green:$(date +%Y%m%d-%H%M%S)",
       "--region","us-west2","--allow-unauthenticated"]
images:
  - "us-west2-docker.pkg.dev/$PROJECT_ID/bob/opt-bob-green:$(date +%Y%m%d-%H%M%S)"
