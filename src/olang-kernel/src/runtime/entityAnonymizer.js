// src/runtime/entityAnonymizer.js
const crypto = require('crypto');

/**
 * ENTITY ANONYMIZER — Kernel-level PII protection for domain entities
 * 
 * Replaces entity names (employees, projects, clients) with anonymous tokens
 * before sending to LLMs, then restores them in the response.
 * 
 * Usage:
 *   const anonymizer = new EntityAnonymizer({ auditLogger: kernel });
 *   const { anonymized, mapping } = anonymizer.anonymize(text, entities);
 *   const restored = anonymizer.deanonymize(llmResponse, mapping);
 */

class EntityAnonymizer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.auditLogger = options.auditLogger || null;
  }

  /**
   * Anonymize entities in text
   * @param {string} text - The text to anonymize
   * @param {Array} entities - Array of { type, id, name } objects
   * @param {Object} options - { logAudit, sessionId }
   * @returns {Object} { anonymized, mapping, redactionCount }
   */
  anonymize(text, entities = [], options = {}) {
    if (!this.enabled || !text || !Array.isArray(entities) || entities.length === 0) {
      return { anonymized: text, mapping: {}, redactionCount: 0 };
    }

    const { logAudit = true, sessionId = null } = options;
    const mapping = {};
    const redactions = [];
    let anonymized = text;

    // Sort entities by name length (longest first) to avoid partial matches
    // e.g., "Olatunji David Oladapo" should match before "Olatunji"
    const sortedEntities = [...entities].sort((a, b) => 
      (b.name?.length || 0) - (a.name?.length || 0)
    );

    sortedEntities.forEach((entity, index) => {
      if (!entity.name || !entity.type) return;

      // Generate deterministic token: TYPE_001
      const tokenIndex = String(index + 1).padStart(3, '0');
      const token = `${entity.type.toUpperCase()}_${tokenIndex}`;

      // Escape regex special characters in the entity name
      const escapedName = entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // Match with word boundaries to avoid partial replacements
      const regex = new RegExp(`\\b${escapedName}\\b`, 'gi');

      if (regex.test(anonymized)) {
        anonymized = anonymized.replace(regex, token);
        mapping[token] = entity.name;
        
        redactions.push({
          token,
          original: entity.name,
          entityType: entity.type,
          entityId: entity.id || null,
          timestamp: new Date().toISOString()
        });
      }
    });

    // ✅ KERNEL AUDIT LOG — Cryptographically record the anonymization
    if (logAudit && this.auditLogger && redactions.length > 0) {
      this.auditLogger._createAuditEntry('entity_anonymization', {
        sessionId,
        redactionCount: redactions.length,
        entityTypes: [...new Set(redactions.map(r => r.entityType))],
        // ✅ SECURITY: Do NOT log the original names in the audit trail
        // Only log the tokens and entity types for compliance proof
        redactions: redactions.map(r => ({
          token: r.token,
          entityType: r.entityType,
          entityIdHash: r.entityId ? this._hashId(r.entityId) : null
        }))
      });
    }

    return {
      anonymized,
      mapping,
      redactionCount: redactions.length,
      redactions // For debugging/audit (don't expose to frontend)
    };
  }

  /**
   * Deanonymize text by restoring original entity names
   * @param {string} text - Text with tokens (e.g., "EMPLOYEE_001 earns...")
   * @param {Object} mapping - { "EMPLOYEE_001": "Olatunji David Oladapo" }
   * @returns {string} Restored text
   */
  deanonymize(text, mapping = {}) {
    if (!text || !mapping || Object.keys(mapping).length === 0) {
      return text;
    }

    let restored = text;
    
    // Sort by token length (longest first) to avoid partial replacements
    const sortedTokens = Object.keys(mapping).sort((a, b) => b.length - a.length);
    
    sortedTokens.forEach(token => {
      const regex = new RegExp(token, 'g');
      restored = restored.replace(regex, mapping[token]);
    });

    return restored;
  }

  /**
   * Hash entity IDs for audit logging (prevents ID leakage in logs)
   */
  _hashId(id) {
    return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
  }
}

module.exports = EntityAnonymizer;