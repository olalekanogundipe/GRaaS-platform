# O-Lang Privacy-Preserving AI Workflows — One-Page Spec (v1.0)

**Date:** 14 October 2026
**Kernel version:** 1.4.1
**Status:** Baseline eval complete; pilot outreach in progress

---

## 1. Problem

Nigerian fintechs, healthtechs, and agritechs want to run LLMs on regulated customer data (KYC, loan applications, patient records). Three blockers prevent deployment:

1. **NDPA 2023 cross-border transfer rules** prohibit sending personal data to non-approved jurisdictions without a lawful basis, DPIA, and transfer instrument.
2. **Global PII tools (Presidio, AWS Comprehend) fail on African identifiers** — NIN, BVN, Ghana Card, Huduma Namba, and names/addresses in Yoruba, Hausa, Igbo, Pidgin, Swahili, Zulu, Xhosa, Twi, Amharic.
3. **Over-redaction destroys utility** — naive 11-digit regexes flag transaction references and amounts, breaking downstream analytics.

---

## 2. Solution

A **self-hosted, kernel-level governance layer** that enforces African-context PII redaction and entity anonymization *before* data ever reaches an LLM. It produces cryptographic audit evidence that compliance teams can attach to their DPIA.

### Architecture
┌─────────────────────────────────────────────────────────────┐
│ CUSTOMER ENVIRONMENT (VPC / On-Premise / In-Region Cloud) │
│ │
│ [1] Raw Input │
│ │ │
│ ▼ │
│ [2] O-Lang Kernel (self-hosted container) │
│ ├─ Pass 0: Entity Anonymizer (NER → reversible tokens)│
│ ├─ Pass 1: PII Redactor (regex → [LABEL_REDACTED]) │
│ ├─ Pass 2: Financial Intent Block (always throws) │
│ └─ Pass 3: PII Block Scan (if mode = 'block') │
│ │ │
│ ▼ │
│ [3] Egress Gate (network-enforced, fail-closed) │
│ ├─ Policy Mode evaluation │
│ └─ Timeout / crash → request dropped │
│ │ │
│ ▼ │
│ [4] LLM Endpoint (customer-chosen destination) │
│ │ │
│ ▼ │
│ [5] Cryptographic Audit Trail (HMAC, customer-held key) │
│ │ │
│ ▼ │
│ [6] Output to Customer Application │
└─────────────────────────────────────────────────────────────┘


---

## 3. What Leaves the Customer Environment

| Payload | Default | Notes |
|---------|---------|-------|
| Raw PII | ❌ Never | Redacted before egress |
| Telemetry | ❌ OFF | Opt-in only |
| Opt-in metrics | ✅ Signed aggregates | Entity counts, error rates. No PII, no quasi-identifiers |
| LLM call | ✅ Redacted payload only | Customer chooses destination |
| Audit trail | ✅ HMAC-signed | Customer-held key; no raw PII in log |

---

## 4. Policy Modes (Customer-Controlled per Workflow)

| Mode | Behaviour | Use case |
|------|-----------|----------|
| **Strict** | Only approved in-region endpoints. Network layer drops unapproved destinations. | Banks, health, tier-1 fintechs |
| **Approve (HITL)** | High-risk payloads or unapproved destinations → human reviewer queue. Reviewer sees only redacted payload + rule fired. Timeout = fail-closed (60s). | Mid-tier fintechs, pilot phase |
| **Allow & Log** | Low-risk data flows out. Audit trail records action. | Internal testing, non-PII data |

**Residency positioning:**
- **Full solution** = customer uses in-region/self-hosted LLM + Strict mode. Data never leaves approved jurisdiction.
- **Mitigation** = customer uses global LLM (e.g., Groq). Redaction reduces blast radius, but customer retains responsibility for their own DPIA and transfer mechanism. We do not claim residency is "solved" in this configuration.

---

## 5. Measured Performance — Baseline v1.0

Eval run: 75 cases (5 languages × 3 modes × 5 cases), seed 42, synthetic data only. Wilson 95% confidence intervals reported.

### Recall by Entity Type

| Entity | Recall | 95% CI | Notes |
|--------|--------|--------|-------|
| BVN | 72/72 (100.0%) | [94.9–100.0] | 11-digit, reserved range |
| NIN | 69/69 (100.0%) | [94.7–100.0] | 11-digit, reserved range |
| Email | 3/3 (100.0%) | [43.8–100.0] | Standard format |
| Phone (NG/KE/ZA/ET/GH/INTL) | 50/75 (66.7%) | [55.4–76.3] | Adversarial formatting gap |
| Address | 0/4 (0.0%) | [0.0–49.0] | Deferred to EntityAnonymizer NER |
| Name | 0/75 (0.0%) | [0.0–4.9] | Deferred to EntityAnonymizer NER |

### Recall by Mode

| Mode | Recall | 95% CI |
|------|--------|--------|
| Easy | 72/97 (74.2%) | [64.7–81.9] |
| Medium | 73/100 (73.0%) | [63.6–80.7] |
| Adversarial | 49/101 (48.5%) | [39.0–58.1] |

### Recall by Language

| Language | Recall | 95% CI |
|----------|--------|--------|
| English | 34/58 (58.6%) | [45.8–70.4] |
| Hausa | 40/60 (66.7%) | [54.1–77.3] |
| Igbo | 40/60 (66.7%) | [54.1–77.3] |
| Pidgin | 40/60 (66.7%) | [54.1–77.3] |
| Yoruba | 40/60 (66.7%) | [54.1–77.3] |

### Over-Redaction (Utility Preservation)

| Metric | Result | 95% CI |
|--------|--------|--------|
| Non-PII 11-digit references destroyed | 0/75 (0.0%) | [0.0–4.9] |

### Overall Recall

**194/298 (65.1%)** — [59.5–70.3]

### Interpretation & Known Gaps

- **NAME / ADDRESS recall = 0%** is *by design*: the regex redactor (`_redactPII`) handles structured identifiers only. Names and addresses are intentionally deferred to the heavier `EntityAnonymizer` NER pass to avoid hallucination. The eval harness currently measures the regex pass only; the NER pass is a separate eval (planned Week 2).
- **Adversarial phone recall < Easy** indicates an obfuscation gap: mixed spaces/dashes in `+234 803-1234567` defeat the current regex. Target for v1.1: >90% via pre-normalization.
- **Over-redaction = 0%** is the headline utility metric: the kernel correctly distinguishes real BVN/NIN from bare 11-digit transaction references.

---

## 6. What It Does NOT Do

- **Does not guarantee 100% recall.** No redactor is perfect. We publish measured recall intervals and residual-risk positions.
- **Does not replace the customer's DPIA.** If a customer routes redacted data to a global LLM, they remain responsible for their own lawful basis and transfer mechanisms under NDPA 2023 and the 2025 GAID.
- **Does not provide "legal compliance."** It provides *auditable evidence* to support the customer's own compliance posture.
- **Does not catch all PII in all languages.** Coverage is measured per language; gaps are published, not hidden.
- **Does not prevent prompt injection.** Financial intent blocking is a separate control layer; prompt injection defences are out of scope for this wedge.

---

## 7. Identifiers & Languages Covered

### PII Identifiers (Regex Pass)

| Region | Identifier | Format |
|--------|-----------|--------|
| 🇳🇬 Nigeria | NIN | 11 digits |
| 🇳🇬 Nigeria | BVN | 11 digits |
| 🇳🇬 Nigeria | Phone | +234 / 0 + 10 digits |
| 🇰🇪 Kenya | Phone | +254 / 07xx / 01xx |
| 🇰🇪 Kenya | Huduma / National ID | 7–8 digits |
| 🇿🇦 South Africa | Phone | +27 / 0xx |
| 🇿🇦 South Africa | National ID | 13 digits (YYMMDD...) |
| 🇪🇹 Ethiopia | Phone | +251 |
| 🇬🇭 Ghana | Phone | +233 |
| 🇬🇭 Ghana | Ghana Card | GHA-XXXXXXXXX-X |
| International | IBAN | EU + SWIFT |
| International | Email | Standard |
| Multi | Account numbers | English, Twi/Akan, Arabic, French, Swahili |

### Financial Intent Detection (Conjugation-Aware)

Yoruba, Hausa, Igbo, Swahili, Zulu, Xhosa, Twi (Ghana), Amharic, Somali, English, French, Arabic, Chinese.

### Entity Anonymizer (NER Pass — Planned Week 2 Eval)

Replaces named entities with reversible tokens (`PERSON_001`, `COMPANY_002`). Maintains a mapping for deanonymization at the boundary. Separate eval to be run.

---

## 8. Cryptographic Audit

Every significant kernel event produces a signed audit entry:

- **Hash chain:** `previousHash` linked list (genesis → entry 1 → entry 2 → ...)
- **Merkle root:** binary tree of all audit hashes
- **Dual-hash forensics:** `dataHash` (locked ground-truth) + `narrativeHash` (final response)
- **Signature:** Ed25519 or RSA-SHA256 signing of every audit entry
- **Integrity verification:** `verifyAuditLogIntegrity()` validates chain, hashes, and signatures
- **External agent verification:** `verifyStepSignature()` + `verifyHashLink()` for federated agents

**Important:** The kernel signs with the *agent's* private key. This proves *who* signed, not that the kernel ran honestly. For full attestation, customers should run the kernel in their own environment and/or add an independent egress check.

---

## 9. Deployment Topology

| Option | Description | Residency |
|--------|-------------|-----------|
| **Self-hosted (recommended)** | Docker container in customer's VPC or on-premise. Customer is data controller/processor. | ✅ Full solution |
| **Managed in-region** | Operated by us in an approved Nigerian / African cloud region. We act as processor. | ✅ Full solution (requires DPA) |
| **Hybrid** | Kernel self-hosted; LLM routed to global provider. | ⚠️ Mitigation only |

**Legal status:** To be confirmed by a Nigerian data protection lawyer based on actual data flows. Do not assume vendor status until reviewed.

---

## 10. Compliance Positioning

**We do not claim to "solve compliance."** We provide:

1. **Measured error rates** with confidence intervals.
2. **Cryptographic evidence** that redaction ran on a specific payload at a specific time.
3. **A clear residual-risk statement** for each language and entity type.
4. **A data-flow diagram** showing exactly what leaves the environment.
5. **Policy controls** that the customer's compliance officer owns.

This is the evidence a DPO needs to attach to their DPIA. It is not a substitute for the DPIA itself.

---

## 11. Regulatory References

- **NDPA 2023** (Nigeria Data Protection Act)
- **2025 GAID** (General Application and Implementation Directive)
- **NDPC** (Nigeria Data Protection Commission) — primary regulator
- **CBN** (Central Bank of Nigeria) — for fintechs
- **FCCPC** — for digital lending conduct
- **NAICOM** — for insurers

*Note: Earlier drafts referenced the NDPR (the prior regime). All references have been updated to NDPA 2023 / GAID 2025.*

---

## 12. 90-Day Roadmap (Public)

| Weeks | Focus | Exit Criterion |
|-------|-------|----------------|
| 1–2 | Finalize topology + threat model. Build redactor eval with baselines (Presidio, Presidio+custom, O-Lang). | Published recall by entity type and language, with intervals. |
| 3–6 | Build customer-side egress gate (minimal: network proxy + deterministic detectors, fail-closed). Add canary probes. Move Gate 3 to redacted data. | Gate blocks 100% of canary PII in test runs. |
| 4–8 | 15+ discovery conversations with Nigerian fintech / insurance DPOs and compliance leads. | 2+ external teams have reviewed the spec; know what would block a pilot. |
| 9–12 | Pilot with one design partner on a real workflow (synthetic or consented data). Publish privacy-utility numbers. | One of: partner commits to paid pilot, partner likes validator but not marketplace (drop marketplace), or pivot. |

### Deliberately NOT doing in 90 days

- Staking / slashing (until validator error rates are known and outside agents exist)
- Pitching a global decentralized economy
- Building more default agents (two is enough to demonstrate the validator)
- Publishing headline accuracy numbers we haven't measured

---

## 13. Contact

**Project:** O-Lang Governance / GRaaS Platform
**Repository:** [github.com/olalekanogundipe/GRaaS-platform](https://github.com/olalekanogundipe/GRaaS-platform)
**Eval artifacts:** `redactor-eval/redactor_eval_out/{cases.jsonl, results.jsonl, report.txt}`

---

*This document is a living spec. It will be updated as eval numbers change and as pilot feedback arrives. Last updated: 14 October 2026.*