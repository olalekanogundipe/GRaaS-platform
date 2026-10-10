// gateway/src/validator.js
// The Hallucination Detection Engine - catches bad AI outputs before they reach the user

export class HallucinationValidator {
  constructor() {
    this.schemas = new Map();
    this.consensusHistory = [];
  }

  // â”€â”€ Register a schema for a capability â”€â”€
  registerSchema(capability, schema) {
    this.schemas.set(capability, schema);
    console.log(`[VALIDATOR] Registered schema for: ${capability}`);
  }

  // â”€â”€ Main validation entry point â”€â”€
  async validate({ capability, input, output, agentId, confidence, evidence, consensusMode = false }) {
    const results = {
      capability,
      agentId,
      timestamp: new Date().toISOString(),
      checks: [],
      passed: true,
      hallucinationScore: 0  // 0 = perfect, 100 = definitely hallucinating
    };

    // Gate 1: Schema Validation
    const schemaCheck = this._validateSchema(capability, output);
    results.checks.push(schemaCheck);
    if (!schemaCheck.passed) results.hallucinationScore += 40;

    // Gate 2: Confidence Threshold
    const confidenceCheck = this._validateConfidence(confidence);
    results.checks.push(confidenceCheck);
    if (!confidenceCheck.passed) results.hallucinationScore += 30;

    // Gate 3: Grounding Verification
    const groundingCheck = this._validateGrounding(input, evidence);
    results.checks.push(groundingCheck);
    if (!groundingCheck.passed) results.hallucinationScore += 20;

    // Gate 4: Cross-Agent Consensus (if enabled)
    if (consensusMode) {
      const consensusCheck = await this._validateConsensus(capability, input, output, agentId);
      results.checks.push(consensusCheck);
      if (!consensusCheck.passed) results.hallucinationScore += 30;
    }

    results.passed = results.hallucinationScore < 50;
    results.verdict = results.passed ? "VERIFIED" : "SUSPECT_HALLUCINATION";

    console.log(`[VALIDATOR] ${capability} by ${agentId}: ${results.verdict} (score: ${results.hallucinationScore}/100)`);
    return results;
  }

  // â”€â”€ Gate 1: Schema Validation â”€â”€
  _validateSchema(capability, output) {
    const schema = this.schemas.get(capability);
    if (!schema) {
      return { gate: "schema", passed: true, detail: "No schema registered (skipped)" };
    }

    const errors = [];

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (output[field] === undefined || output[field] === null) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check types
    if (schema.types) {
      for (const [field, expectedType] of Object.entries(schema.types)) {
        if (output[field] === undefined) continue;
        const actualType = typeof output[field];
        if (actualType !== expectedType) {
          errors.push(`Field '${field}' expected ${expectedType}, got ${actualType}`);
        }
      }
    }

    // Check numeric ranges
    if (schema.ranges) {
      for (const [field, range] of Object.entries(schema.ranges)) {
        if (output[field] === undefined) continue;
        if (range.min !== undefined && output[field] < range.min) {
          errors.push(`Field '${field}' below minimum ${range.min}`);
        }
        if (range.max !== undefined && output[field] > range.max) {
          errors.push(`Field '${field}' above maximum ${range.max}`);
        }
      }
    }

    return {
      gate: "schema",
      passed: errors.length === 0,
      errors,
      detail: errors.length === 0 ? "Output matches schema" : errors.join("; ")
    };
  }

  // â”€â”€ Gate 2: Confidence Threshold â”€â”€
  _validateConfidence(confidence) {
    const MIN_CONFIDENCE = 0.70;  // Agent must be at least 70% confident

    if (confidence === undefined || confidence === null) {
      return {
        gate: "confidence",
        passed: false,
        detail: "Agent did not declare confidence level"
      };
    }

    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      return {
        gate: "confidence",
        passed: false,
        detail: `Invalid confidence value: ${confidence} (must be 0-1)`
      };
    }

    return {
      gate: "confidence",
      passed: confidence >= MIN_CONFIDENCE,
      confidence,
      threshold: MIN_CONFIDENCE,
      detail: confidence >= MIN_CONFIDENCE
        ? `Confidence ${(confidence * 100).toFixed(0)}% meets threshold`
        : `Confidence ${(confidence * 100).toFixed(0)}% below threshold ${MIN_CONFIDENCE * 100}%`
    };
  }

  // â”€â”€ Gate 3: Grounding Verification â”€â”€
  _validateGrounding(input, evidence) {
    if (!evidence || !Array.isArray(evidence) || evidence.length === 0) {
      return {
        gate: "grounding",
        passed: false,
        detail: "Agent did not provide grounding evidence"
      };
    }

    const errors = [];
    const inputKeys = new Set(this._extractAllKeys(input));

    for (const item of evidence) {
      // Each evidence item must reference a real field from the input
      if (!item.field) {
        errors.push("Evidence item missing 'field' reference");
        continue;
      }
      if (!inputKeys.has(item.field)) {
        errors.push(`Evidence references unknown field: '${item.field}' (not in input)`);
      }
      if (!item.reasoning || typeof item.reasoning !== 'string') {
        errors.push(`Evidence for '${item.field}' missing reasoning`);
      }
    }

    return {
      gate: "grounding",
      passed: errors.length === 0,
      evidenceCount: evidence.length,
      errors,
      detail: errors.length === 0
        ? `${evidence.length} evidence items properly grounded in input`
        : errors.join("; ")
    };
  }

  // â”€â”€ Gate 4: Cross-Agent Consensus â”€â”€
  async _validateConsensus(capability, input, primaryOutput, primaryAgentId) {
    // This would call multiple agents in production
    // For now, we simulate by checking against historical results
    const historical = this.consensusHistory
      .filter(h => h.capability === capability && h.agentId !== primaryAgentId)
      .slice(-5);  // Last 5 results from other agents

    if (historical.length === 0) {
      return {
        gate: "consensus",
        passed: true,
        detail: "No historical data for consensus (first run)"
      };
    }

    // Compare key fields
    const disagreements = [];
    for (const hist of historical) {
      if (hist.output.isFraud !== undefined && primaryOutput.isFraud !== undefined) {
        if (hist.output.isFraud !== primaryOutput.isFraud) {
          disagreements.push({
            agent: hist.agentId,
            theirAnswer: hist.output.isFraud,
            ourAnswer: primaryOutput.isFraud
          });
        }
      }
    }

    const agreementRate = 1 - (disagreements.length / historical.length);

    return {
      gate: "consensus",
      passed: agreementRate >= 0.67,  // At least 67% agreement
      agreementRate: (agreementRate * 100).toFixed(0) + "%",
      disagreements,
      detail: agreementRate >= 0.67
        ? `${(agreementRate * 100).toFixed(0)}% agreement with other agents`
        : `Only ${(agreementRate * 100).toFixed(0)}% agreement - possible hallucination`
    };
  }

  // â”€â”€ Record a result for future consensus checks â”€â”€
  recordResult(capability, agentId, output) {
    this.consensusHistory.push({
      capability,
      agentId,
      output,
      timestamp: new Date().toISOString()
    });
    // Keep only last 100 results per capability
    if (this.consensusHistory.length > 500) {
      this.consensusHistory = this.consensusHistory.slice(-500);
    }
  }

  // â”€â”€ Helper: Extract all keys from nested object â”€â”€
  _extractAllKeys(obj, prefix = "") {
    const keys = [];
    for (const [k, v] of Object.entries(obj || {})) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      keys.push(fullKey);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        keys.push(...this._extractAllKeys(v, fullKey));
      }
    }
    return keys;
  }
}