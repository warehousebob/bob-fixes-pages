// index.mjs — opt-bob-green (Gemini-powered /audit)
import express from "express";

const app = express();
app.use(express.json({ limit: "8mb" }));

// ---- Config ----
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // set in Cloud Run (env or Secret)
const GEM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ---- Helpers ----
const toInlineImage = (dataUrl) => {
  // dataUrl like "data:image/jpeg;base64,...."
  const m = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(dataUrl || "");
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
};

const CRO_SYSTEM = `
You are a senior CRO specialist. Analyze the supplied page HTML and screenshots.
Return JSON ONLY, matching this schema:

{
  "score": number,                     // 0..100
  "findings": [
    {
      "title": string,
      "category": "CTA"|"Trust"|"Offer"|"Messaging"|"Layout"|"Mobile"|"Form"|"Speed"|"AOV"|"Nav",
      "impact": "high"|"medium"|"low",
      "effort": "low"|"medium"|"high",
      "confidence": number,            // 0..1
      "selector_hint": string,         // comma-separated CSS guesses e.g. "header .cta, .btn-primary"
      "recommendation_html": string,   // optional snippet/wireframe
      "example_snippet": string,       // short rationale or copy change
      "how_to_test": string            // concise A/B suggestion + primary metric
    }
  ]
}

Rules:
- Produce 5–7 findings, prioritized by impact.
- If unsure, still output best-guess "selector_hint" (compose from class names visible in HTML).
- Avoid brand-specific CTAs like "See Plans" unless the page clearly has plans/pricing.
- No preamble, no backticks—JSON only.
`;

// ---- Endpoints ----

// simple health check
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Gemini-powered CRO analyzer
app.post("/audit", async (req, res) => {
  try {
    const {
      url = "",
      html = "",
      segments = [],              // array of { dataUrl: "data:image/...;base64,..." }
      screenshot_meta = null,     // { devicePixelRatio, viewportH, totalH }
      include_llm = true,
      want_min_findings = 7
    } = req.body || {};

    if (!url && !html) {
      return res.status(400).json({ ok: false, error: "missing_url_or_html" });
    }

    // Build Gemini request parts
    const parts = [];
    parts.push({ text: CRO_SYSTEM.trim() });
    parts.push({
      text: `URL: ${url}\nDevice DPR: ${screenshot_meta?.devicePixelRatio || 1}\nViewportH: ${screenshot_meta?.viewportH || 0}\nTotalH: ${screenshot_meta?.totalH || 0}`
    });

    // Keep prompt lean: cap HTML to ~120KB
    const MAX_HTML = 120_000;
    const compactHTML = String(html || "").slice(0, MAX_HTML);
    parts.push({ text: `HTML_START\n${compactHTML}\nHTML_END` });

    // Attach up to 8 image tiles
    (segments || []).slice(0, 8).forEach((seg) => {
      const img = toInlineImage(seg?.dataUrl);
      if (img) parts.push(img);
    });

    let modelJson = null;

    if (include_llm && GEMINI_API_KEY) {
      const body = { contents: [{ role: "user", parts }] };
      const resp = await fetch(`${GEM_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errTxt = await resp.text().catch(() => "");
        console.error("Gemini HTTP error", resp.status, errTxt);
      } else {
        const out = await resp.json().catch(() => ({}));
        const txt = out?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        // Extract JSON object from the text (robust to extra prose—though prompt forbids it)
        const firstBrace = txt.indexOf("{");
        const lastBrace = txt.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          const jsonStr = txt.slice(firstBrace, lastBrace + 1);
          try {
            modelJson = JSON.parse(jsonStr);
          } catch (e) {
            console.warn("Gemini JSON parse failed:", e?.message || e);
          }
        }
      }
    } else if (!GEMINI_API_KEY) {
      console.warn("GEMINI_API_KEY not set; using fallback heuristics.");
    }

    // Normalize result
    const normalize = (j) => {
      if (!j || typeof j !== "object") return null;
      const score = Math.max(0, Math.min(100, Number(j.score || 0)));
      let findings = Array.isArray(j.findings) ? j.findings : [];
      findings = findings.map((f) => ({
        title: f.title || "Recommendation",
        category: f.category || "Layout",
        impact: f.impact || "medium",
        effort: f.effort || "low",
        confidence: typeof f.confidence === "number" ? f.confidence : 0.6,
        selector_hint: f.selector_hint || "",
        recommendation_html: f.recommendation_html || "",
        example_snippet: f.example_snippet || "",
        how_to_test: f.how_to_test || "",
      }));
      return { score, findings };
    };

    let result = normalize(modelJson);

    // Fallback: minimal heuristics if Gemini returned nothing useful
    if (!result || (result.findings || []).length < 1) {
      const rawHtml = String(html || "");
      const text = rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const hasSticky = /position:\s*sticky|data-sticky|sticky-cta|sticky/i.test(rawHtml);
      const ctas =
        (rawHtml.match(
          /<(a|button)[^>]*>(?:[^<]*(call|buy|start|trial|checkout|add to cart|subscribe))[^<]*<\/\1>/gi
        ) || []).length;
      const trustHits =
        (text.match(/\b(guarantee|secure|trust|reviews?|testimonials?|refund|money back)\b/gi) || [])
          .length;
      const heroLen = text.split(/\s+/).slice(0, 25).join(" ").length;

      // crude score out of 100
      let score = 50 + Math.min(3, ctas) * 8 + Math.min(4, trustHits) * 4;
      if (!hasSticky) score -= 6;
      if (heroLen < 40) score -= 6;
      score = Math.max(20, Math.min(100, score));

      const fallback = {
        score,
        findings: [
          !hasSticky && {
            title: "Make the primary CTA sticky on mobile",
            category: "CTA",
            impact: "high",
            effort: "low",
            confidence: 0.7,
            selector_hint: "button, .btn, [role='button'], .cta, .cta-primary",
            recommendation_html: "",
            example_snippet: "Keep the primary CTA visible while scrolling.",
            how_to_test: "A/B test sticky vs non-sticky; track CTR to checkout.",
          },
          ctas < 2 && {
            title: "Add a secondary CTA under the hero",
            category: "CTA",
            impact: "medium",
            effort: "low",
            confidence: 0.6,
            selector_hint: "main, .hero, .subhero, .section-cta",
            recommendation_html: "",
            example_snippet: "Offer a lower-friction path for information seekers.",
            how_to_test: "Measure click-through and scroll depth.",
          },
          trustHits < 2 && {
            title: "Place trust signals within ~100px of CTAs",
            category: "Trust",
            impact: "medium",
            effort: "low",
            confidence: 0.6,
            selector_hint: ".trust, .badges, .reviews, .guarantee",
            recommendation_html:
              "<ul><li>30-day guarantee</li><li>Secure checkout</li><li>4,900+ reviews</li></ul>",
            example_snippet: "Surface proof near purchase CTAs.",
            how_to_test: "A/B trust badges vs control; track add-to-cart.",
          },
        ].filter(Boolean),
      };

      result = normalize(fallback);
    }

    // Ensure 5–7 items (pad with safe suggestions if model gave fewer)
    while ((result.findings || []).length < Math.max(5, want_min_findings || 5)) {
      result.findings.push({
        title: "Add a benefits checklist near the hero",
        category: "Messaging",
        impact: "medium",
        effort: "low",
        confidence: 0.6,
        selector_hint: ".hero, header, .above-the-fold",
        recommendation_html: "",
        example_snippet: "Quick bullets: outcome, timeframe, proof.",
        how_to_test: "A/B; monitor CTR and time-on-page.",
      });
    }
    if (result.findings.length > 7) result.findings = result.findings.slice(0, 7);

    res.json({ ok: true, model: MODEL, ts: Date.now(), url, score: result.score, findings: result.findings });
  } catch (err) {
    console.error("AUDIT_ERROR", err);
    res.status(500).json({ ok: false, error: "analysis_failed", detail: String(err?.message || err) });
  }
});

// ---- Cloud Run entry ----
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`[GREEN] listening on ${PORT}`));
