const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // âœ… CRYPTOGRAPHIC AUDIT LOGS
const { verifyStepSignature, verifyHashLink } = require('./cryptoVerifier');

// âœ… O-Lang Kernel Version (Safety Logic & Governance Rules)
const KERNEL_VERSION = '1.4.1'; // ðŸ” Bumped: PII redaction engine added

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// âœ… NEW v1.3.0 â€” SEPARATED PATTERN SETS
//
// WHY: Previously _validateInputs and _validateLLMOutput both duplicated one
// giant flat list. PII redaction must ONLY replace PII tokens (phone numbers,
// BVNs, account numbers) â€” it must NOT replace financial intent phrases like
// "fi owo raná¹£áº¹" with "[TRANSFER_REDACTED]" in legitimate LLM prompts.
//
// Backward compatibility: all old patterns are preserved exactly. They are now
// organised into two methods:
//   _getPIIPatterns()              â†’ used by new _redactPII()
//   _getFinancialIntentPatterns()  â†’ used by _validateInputs / _validateLLMOutput
//
// BACKWARD COMPAT: _validateInputs still throws by default (MODE = 'block').
// Set OLANG_PII_MODE=redact in env to switch to non-throwing redaction mode.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// âœ… NEW: Entity Anonymizer Class
class EntityAnonymizer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.auditLogger = options.auditLogger || null;
  }

  anonymize(text, entities = [], options = {}) {
    if (!this.enabled || !text || typeof text !== 'string' || !Array.isArray(entities) || entities.length === 0) {
      return { anonymized: text, mapping: {}, redactionCount: 0 };
    }

    const { logAudit = true, sessionId = null } = options;
    const mapping = {};
    const redactions = [];
    let anonymized = text;

    // Sort by name length (longest first) to avoid partial matches
    const sortedEntities = [...entities].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));

    sortedEntities.forEach((entity, index) => {
      if (!entity.name || !entity.type) return;

      const tokenIndex = String(index + 1).padStart(3, '0');
      const token = `${entity.type.toUpperCase()}_${tokenIndex}`;
      const escapedName = entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    if (logAudit && this.auditLogger && redactions.length > 0) {
      this.auditLogger._createAuditEntry('entity_anonymization', {
        sessionId,
        redactionCount: redactions.length,
        entityTypes: [...new Set(redactions.map(r => r.entityType))],
        redactions: redactions.map(r => ({
          token: r.token,
          entityType: r.entityType,
          entityIdHash: r.entityId ? this._hashId(r.entityId) : null
        })),
        severity: 'info'
      });
    }

    return { anonymized, mapping, redactionCount: redactions.length };
  }

  deanonymize(text, mapping = {}) {
    if (!text || typeof text !== 'string' || !mapping || Object.keys(mapping).length === 0) {
      return text;
    }
    let restored = text;
    const sortedTokens = Object.keys(mapping).sort((a, b) => b.length - a.length);
    sortedTokens.forEach(token => {
      const regex = new RegExp(token, 'g');
      restored = restored.replace(regex, mapping[token]);
    });
    return restored;
  }

  _hashId(id) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
  }
}



class RuntimeAPI {
constructor({ verbose = false, redisClient = null } = {}) {
  //  console.log('âœ… KERNEL FIX VERIFIED - Unwrapping active');
  this.context = {};
  this.resources = {};
  this.agentMap = {};
  this.events = {};
  this.workflowSteps = [];
  this.allowedResolvers = new Set();
  this.verbose = verbose;
  this.redisClient = redisClient; // âœ… NEW: Redis client for Prompt/Escalation state
 this.__warnings = [];
  
  // ðŸ›¡ï¸ VERCEL FIX: Route logs to /tmp in production to avoid read-only crash
  const isVercel = process.env.VERCEL === '1';
  const logsDir = isVercel ? '/tmp/logs' : path.resolve('./logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  
  this.disallowedLogFile = path.join(logsDir, 'disallowed_resolvers.json');
  this.disallowedAttempts = [];

  // âœ… NEW: Database client setup
  this.dbClient = null;
  this._initDbClient();

  // âœ… NEW: Cryptographically verifiable audit logs
  this.auditLog = [];
  this.previousHash = 'GENESIS';
  let rawKey = process.env.OLANG_AUDIT_PRIVATE_KEY;
    if (rawKey && !rawKey.includes('BEGIN PRIVATE KEY') && !rawKey.includes('BEGIN RSA PRIVATE KEY')) {
      try { this.auditLogPrivateKey = fs.readFileSync(rawKey, 'utf8'); } 
      catch (e) { console.warn('[O-Lang] Could not read audit key file:', rawKey); this.auditLogPrivateKey = null; }
    } else {
      this.auditLogPrivateKey = rawKey;
    }
  this.auditLogFile = path.join(logsDir, 'audit_log.json');
  this.enableAuditLog = process.env.OLANG_AUDIT_LOG === 'true';

  // âœ… NEW v1.3.0 â€” PII operating mode
  // 'block'          â†’ original behaviour: throw on PII (default, backward compat)
  // 'redact'         â†’ new behaviour: replace PII tokens, continue execution
  // 'redact-and-log' â†’ redact + emit audit entry per redaction event
  this.piiMode = process.env.OLANG_PII_MODE || 'block';

   // âœ… NEW: Initialize Entity Anonymizer
  this.entityAnonymizer = new EntityAnonymizer({
    enabled: process.env.OLANG_ENTITY_ANONYMIZATION !== 'false', // Default: ON
    auditLogger: this
  });

  if (this.enableAuditLog && this.verbose) {
    console.log('ðŸ” Cryptographically verifiable audit logging enabled');
  }

  if (this.enableAuditLog && this.verbose) {
    console.log('ðŸ” Cryptographically verifiable audit logging enabled');
  }

  if (this.verbose && this.piiMode !== 'block') {
    console.log(`ðŸ›¡ï¸  PII mode: ${this.piiMode}`);
  }
  
  if (this.redisClient && this.verbose) {
    console.log('ðŸ”´ Redis client attached for state management');
  }
}

  // ================================
  // âœ… NEW v1.3.0 â€” PII-ONLY PATTERN SET
  //
  // These patterns match concrete identifiers that can be replaced with a
  // [TYPE_REDACTED] token without destroying the semantic meaning of a sentence.
  // They cover every language listed on the O-Lang site.
  // ================================

  _getPIIPatterns() {
    return [

      // â”€â”€ Phone Numbers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      // Nigeria (MTN, Airtel, Glo, 9mobile)
      {
        pattern: /\b(?:\+?234\s*[-.]?|0)(?:70|80|81|90|91)\d{8}\b/g,
        capability: 'pii_phone',
        lang: 'ng',
        label: 'NG_PHONE'
      },
      // Kenya (+254 / 07xx / 01xx)
      {
        pattern: /\b(?:\+?254\s*[-.]?|0)(?:7[0-9]|1[01])\d{7}\b/g,
        capability: 'pii_phone',
        lang: 'ke',
        label: 'KE_PHONE'
      },
      // South Africa (+27 / 0xx)
      {
        pattern: /\b(?:\+?27\s*[-.]?|0)[6-8]\d{8}\b/g,
        capability: 'pii_phone',
        lang: 'za',
        label: 'ZA_PHONE'
      },
      // Ethiopia (+251)
      {
        pattern: /\b(?:\+?251\s*[-.]?|0)[79]\d{8}\b/g,
        capability: 'pii_phone',
        lang: 'et',
        label: 'ET_PHONE'
      },
      // ðŸ‡¬ðŸ‡­ Ghana (+233) - MTN (24/54), Telecel (20/50), AT (26/56), Glo (23)
      {
        pattern: /\b(?:\+?233\s*[-.]?|0)(?:2[0346]|5[046])\d{7}\b/g,
        capability: 'pii_phone',
        lang: 'gh',
        label: 'GH_PHONE'
      },
      // Generic international E.164
      {
        pattern: /\+(?!234|254|27\b|251|233)[1-9]\d{1,2}[-.\s]?\d{3,5}[-.\s]?\d{4,9}\b/g,
        capability: 'pii_phone',
        lang: 'intl',
        label: 'INTL_PHONE'
      },

      // â”€â”€ National Identity Numbers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      // Nigeria BVN (11 digits)
      {
        pattern: /\b(?:bvn|bank\s+verification\s+number)\b.{0,20}\d{11}/ig,
        capability: 'pii_national_id',
        lang: 'ng',
        label: 'NG_BVN'
      },
      // Nigeria NIN (11 digits)
      {
        pattern: /\b(?:nin|national\s+identification\s+number)\b.{0,20}\d{11}/ig,
        capability: 'pii_national_id',
        lang: 'ng',
        label: 'NG_NIN'
      },
      // ðŸ‡¬ðŸ‡­ Ghana Card (National ID) - Format: GHA-XXXXXXXXX-X
      {
        pattern: /\bGHA-\d{9}-\d\b/ig,
        capability: 'pii_national_id',
        lang: 'gh',
        label: 'GH_CARD'
      },
      // South Africa ID (13 digits YYMMDD + gender + race + check)
      {
        pattern: /\b[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{4}[01][0-9]{2}\b/g,
        capability: 'pii_national_id',
        lang: 'za',
        label: 'ZA_ID'
      },
      // Kenya Huduma / National ID (7-8 digits)
      {
        pattern: /\b(?:national\s+id|id\s+number|huduma\s+namba)\b.{0,10}\d{7,8}\b/ig,
        capability: 'pii_national_id',
        lang: 'ke',
        label: 'KE_ID'
      },

      // â”€â”€ Bank Account Numbers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      // Generic account reference (works across all listed languages)
      // Added Twi/Akan terms: 'sika' (money), 'konte' (account)
      {
        pattern: /(?:account|acct|a\/c|akaunti|asusu|hesabu|namba|#|compte|cuenta|konto|konte|sika\s+number|Ø­Ø³Ø§Ø¨|Ø­Ø³Ø§Ø¨\s+Ø±Ù‚Ù…|Ø­Ø³Ø§Ø¨ÙŠ|akaunti\s+ya|nambari\s+ya\s+akaunti)\s*[:\-â€”â€“]?\s*(\d{6,18})\b/ig,
        capability: 'pii_account',
        lang: 'multi',
        label: 'ACCOUNT_NUMBER'
      },
      // IBAN (EU + Africa SWIFT members)
      {
        pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,30}\b/g,
        capability: 'pii_account',
        lang: 'intl',
        label: 'IBAN'
      },

      // â”€â”€ Email Addresses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      {
        pattern: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
        capability: 'pii_email',
        lang: 'multi',
        label: 'EMAIL'
      },

      // â”€â”€ Deceptive completion claims (cross-language) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // These belong in PII set because they mask fraudulent state
      {
        pattern: /\b(successful(?:ly)?|confirmed|approved|completed|processed|verified|imethibitishwa|imefanikiwa|amthibitishwa|ti\s+da|ti\s+á¹£e|gá»¥nyere|kimefanyika|yamekamilika)\b/ig,
        capability: 'pii_deceptive_claim',
        lang: 'multi',
        label: 'DECEPTIVE_CLAIM'
      }
    ];
  }
  // ================================
  // âœ… NEW v1.3.0 â€” FINANCIAL INTENT PATTERN SET (unchanged from v1.2.x)
  //
  // These patterns detect *intent* to perform a financial action. They are
  // NOT suitable for token-level redaction because replacing "fi owo raná¹£áº¹"
  // with "[TRANSFER_REDACTED]" would destroy the sentence. They are used by
  // _validateInputs (block mode) and _validateLLMOutput (always blocks).
  // ================================

  _getFinancialIntentPatterns() {
    return [

      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // ðŸ‡³ðŸ‡¬ NIGERIAN LANGUAGES (Fixed Unicode Boundaries)
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      // YORUBA: Removed trailing \b after 'á¹£áº¹' to fix Unicode matching
      { pattern: /fi\s+(?:owo|áº¹Ì€wá»Ì€|ewo|ku|fun|s'á»ká»á»)/i, capability: 'transfer', lang: 'yo' },
      { pattern: /raná¹£áº¹\s+(?:owo|pesa|kuÉ—i|ego)/i, capability: 'transfer', lang: 'yo' },
      { pattern: /fi\s+\w+\s+\w+\s+raná¹£áº¹/i, capability: 'transfer', lang: 'yo' }, // Catches "Fi 5000 naira raná¹£áº¹"
      { pattern: /san\s+(?:owo|áº¹Ì€wá»Ì€|ewo|fun|wo)/i, capability: 'payment', lang: 'yo' },
      { pattern: /gba\s+owo/i, capability: 'withdrawal', lang: 'yo' },
      { pattern: /\bti\s+(?:fi|san|gba|da|lo)/i, capability: 'unauthorized_action', lang: 'yo' },
      { pattern: /\b(?:Å„|Ç¹|n)\s+(?:fi|san|gba)/i, capability: 'unauthorized_action', lang: 'yo' },
      { pattern: /\b(mo\s+ti\s+(?:fi|san|gba))/i, capability: 'unauthorized_action', lang: 'yo' },

      // HAUSA: âœ… FIXED - Aggressive Substring Match (No Boundaries)
      { pattern: /aika.{0,30}ku(?:É—|d)i/iu, capability: 'transfer', lang: 'ha' },
      { pattern: /ciyar\s*(?:da)?/i, capability: 'transfer', lang: 'ha' },
      { pattern: /shiga\s+ku(?:É—|d)i/iu, capability: 'transfer', lang: 'ha' },
      { pattern: /turo\s+.*\s+aika/i, capability: 'transfer', lang: 'ha' },
      { pattern: /biya\s*(?:da)?/i, capability: 'payment', lang: 'ha' },
      { pattern: /sahaw[ae]\s+ku(?:É—|d)i/iu, capability: 'withdrawal', lang: 'ha' },
      { pattern: /(?:ya|ta|su)\s+(?:ciyar|biya|sahawa|sake)/i, capability: 'unauthorized_action', lang: 'ha' },
      { pattern: /(?:za\s+a|za\s+ta)\s+(?:ciyar|biya)/i, capability: 'unauthorized_action', lang: 'ha' },
      { pattern: /ina\s+(?:ciyar|biya|sahawa)/i, capability: 'unauthorized_action', lang: 'ha' },

      // IGBO: Removed trailing \b after 'igo'
      { pattern: /zipu\s+(?:ego|moni|isi|na)/i, capability: 'transfer', lang: 'ig' },
      { pattern: /buru\s+(?:ego|moni|isi)/i, capability: 'transfer', lang: 'ig' },
      { pattern: /zi\s+.*\s+zipu/i, capability: 'transfer', lang: 'ig' },
      { pattern: /tinye\s+(?:ego|moni|isi)/i, capability: 'deposit', lang: 'ig' },
      { pattern: /(?:ziri|bururu|tinyere|gbara)/i, capability: 'unauthorized_action', lang: 'ig' },
      { pattern: /m\s+(?:ziri|buru|zipuru|tinyere)/i, capability: 'unauthorized_action', lang: 'ig' },

      // SWAHILI: âœ… FIXED - Catch Conjugated Forms (ni-li-pe, a-li-pe)
      { pattern: /tuma\s+(?:pesa|fedha)/i, capability: 'transfer', lang: 'sw' },
      { pattern: /pelek[ae]?\s+(?:pesa|fedha)/i, capability: 'transfer', lang: 'sw' },
      { pattern: /wasilisha/i, capability: 'transfer', lang: 'sw' },
      { pattern: /\b\w*lip[ae]\w*/i, capability: 'payment', lang: 'sw' },
      { pattern: /maliza\s+malipo/i, capability: 'payment', lang: 'sw' },
      { pattern: /ongez[ae]?\s*(?:kiasi|pesa|fedha)/i, capability: 'deposit', lang: 'sw' },
      { pattern: /wek[ae]?\s+(?:katika|ndani)\s+(?:akaunti|hisa)/i, capability: 'deposit', lang: 'sw' },
      { pattern: /nime(?:tuma|lipa|ongeza|weka|peleka)/i, capability: 'unauthorized_action', lang: 'sw' },
      { pattern: /(?:ni|u|a|tu|m|wa|ki|vi|zi|i)\s*me\s*(?:ongeza|weka|tuma|peleka|lipa|wasilisha)/i, capability: 'unauthorized_action', lang: 'sw' },

      // OTHER AFRICAN:
      // Amharic: Match roots anywhere
      { pattern: /\u120b\u12ad/u, capability: 'transfer', lang: 'am' },
      { pattern: /\u1308\u1263/u, capability: 'deposit', lang: 'am' },
      { pattern: /\u12ad\u134c\u120d/u, capability: 'payment', lang: 'am' },
      { pattern: /[\u1200-\u137F]{0,4}(?:\u1270\u120b\u120b\u1348|\u120b\u12ad|\u12ad\u134c\u120d|\u1338\u121d\u122d|\u12c8\u1323|\u1308\u1263)[\u1200-\u137F]{0,2}/u, capability: 'financial_action', lang: 'am' },

      // Somali
      { pattern: /dir\s+(?:lacag|maal|qarsoon)/i, capability: 'transfer', lang: 'so' },
      { pattern: /bixi|bixis\s*o/i, capability: 'payment', lang: 'so' },

      // Zulu: âœ… FIXED - Handle Subject Concords (u-thumela, ngi-hlawule)
      { pattern: /thumel/i, capability: 'transfer', lang: 'zu' }, // Matches root inside uthumela, ngithumela
      { pattern: /thumel.*imali/i, capability: 'transfer', lang: 'zu' },
      { pattern: /hlawul/i, capability: 'payment', lang: 'zu' },  // Matches root inside hlawula, ngihlawule
      { pattern: /hlawul.*imali/i, capability: 'payment', lang: 'zu' },

      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // ðŸ‡¿ðŸ‡¦ XHOSA âœ… NEW v1.3.0
      //
      // Xhosa shares Nguni root structure with Zulu. Subject concords differ
      // (ndi- / u- / ba-) but financial roots are near-identical.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      { pattern: /thumela?\b/i, capability: 'transfer', lang: 'xh' },               // thumela (send)
      { pattern: /thumela?\s+imali/i, capability: 'transfer', lang: 'xh' },         // send money
      { pattern: /hlawul/i, capability: 'payment', lang: 'xh' },                    // pay (shared Nguni root)
      { pattern: /beka\s+(?:imali|ingeniso)/i, capability: 'deposit', lang: 'xh' }, // deposit
      { pattern: /rhola\s+imali/i, capability: 'withdrawal', lang: 'xh' },          // withdraw money
      { pattern: /ndi(?:thumele|hlawule|beke|rhola)/i, capability: 'unauthorized_action', lang: 'xh' }, // 1st person perfect
      { pattern: /u(?:thumele|hlawule|beke|rhola)/i, capability: 'unauthorized_action', lang: 'xh' },   // 3rd person perfect

            // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // ðŸ‡¬ðŸ‡­ GHANA: TWI (AKAN) âœ… NEW v1.3.0-alpha
      //
      // Twi is the most widely spoken language in Ghana.
      // Financial roots: 'soma' (send), 'tua' (pay), 'fa' (take/use), 'kÉ”' (go)
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      
      // Transfer/Send Money
      { pattern: /soma\s+(?:sika|money)/i, capability: 'transfer', lang: 'tw' }, // Send money
      { pattern: /de\s+sika\s+ma/i, capability: 'transfer', lang: 'tw' },        // Give money
      { pattern: /fa\s+sika\s+(?:kÉ”|yi)/i, capability: 'transfer', lang: 'tw' }, // Take money away
      
      // Payment
      { pattern: /tua\s+(?:ka|sika)/i, capability: 'payment', lang: 'tw' },      // Pay debt/money
      { pattern: /san\s+ka\s+sika/i, capability: 'payment', lang: 'tw' },        // Pay back money
      
      // Withdrawal
      { pattern: /yi\s+sika\s+fi/i, capability: 'withdrawal', lang: 'tw' },      // Remove money from...
      { pattern: /twa\s+sika\s+fi\s+(?:bank|account)/i, capability: 'withdrawal', lang: 'tw' }, // Cut/withdraw money
      
      // Deposit
      { pattern: /de\s+sika\s+to/i, capability: 'deposit', lang: 'tw' },         // Put money in
      { pattern: /hyeh\s+sika\s+mu/i, capability: 'deposit', lang: 'tw' },       // Insert money into
      
      // Unauthorized Action (First Person Perfective - "I have sent/paid")
      { pattern: /ma(?:te|ye)\s+(?:soma|tua|yi|de)/i, capability: 'unauthorized_action', lang: 'tw' }, 
      { pattern: /me(?:soma|tua|yi|de)/i, capability: 'unauthorized_action', lang: 'tw' }, // I send/pay/take

      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // ðŸŒ GLOBAL LANGUAGES
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// âœ… FIXED: require a nearby financial noun so "sending my data" / "paying attention" don't match
      {
        pattern: /\b(transfer(?:red|ring)?|send(?:t|ing)?|wire(?:d)?|pay(?:ed|ing)?|withdraw(?:n)?|deposit(?:ed|ing)?)\b(?=[^.!?]{0,25}\b(money|cash|funds?|payment|naira|dollars?|ngn|usd|account|balance|wallet|invoice|salary|amount|bill)\b)/i,
        capability: 'financial_action',
        lang: 'en'
      },
      { pattern: /\bI\s+(?:can|will|am able to|have|'ve|did|already)\s+(?:transfer|send|pay|withdraw|deposit|wire)\b/i, capability: 'unauthorized_action', lang: 'en' },
      { pattern: /\b(?:have|has|had)\s+(?:transferred|sent|paid|withdrawn|deposited|wire[d])\b/i, capability: 'unauthorized_action', lang: 'en' },
      { pattern: /\b(?:was|were|been)\s+(?:added|credited|transferred|sent|paid)\b/i, capability: 'unauthorized_action', lang: 'en' },
      { pattern: /\b(virer|transfÃ©rer|envoyer|payer|retirer|dÃ©poser|dÃ©biter|crÃ©diter)\b/i, capability: 'financial_action', lang: 'fr' },
      { pattern: /\b(?:j'?ai|tu as|il a|elle a|nous avons|vous avez|ils ont|elles ont)\s+(?:virÃ©|transfÃ©rÃ©|envoyÃ©|payÃ©|retirÃ©|dÃ©posÃ©)\b/i, capability: 'unauthorized_action', lang: 'fr' },
      { pattern: /[\u0600-\u06FF]{0,3}(?:Ø­ÙˆÙ‘Ù„|Ø£Ø±Ø³Ù„|Ø§Ø¯ÙØ¹|Ø§ÙˆØ¯Ø¹|Ø³Ø­Ø¨)[\u0600-\u06FF]{0,3}/u, capability: 'financial_action', lang: 'ar' },
      { pattern: /[\u0600-\u06FF]{0,3}(?:Ø£Ù†Ø§|ØªÙ…|Ù„Ù‚Ø¯)\s*(?:Ø­ÙˆÙ‘Ù„Øª|Ø£Ø±Ø³Ù„Øª|Ø¯ÙØ¹Øª|Ø§ÙˆØ¯Ø¹Øª)[\u0600-\u06FF]{0,3}/u, capability: 'unauthorized_action', lang: 'ar' },
      { pattern: /[\u4e00-\u9fff]{0,2}(?:è½¬è´¦|æ”¯ä»˜|å­˜æ¬¾|å–æ¬¾)[\u4e00-\u9fff]{0,2}(?:äº†)[\u4e00-\u9fff]{0,2}/u, capability: 'financial_action', lang: 'zh' },
      { pattern: /[\u4e00-\u9fff]{0,2}(?:è½¬è´¦|è½¬å¸|æ”¯ä»˜|ä»˜æ¬¾|ææ¬¾|å–æ¬¾|å­˜æ¬¾|å­˜å…¥|æ±‡æ¬¾|å­˜)[\u4e00-\u9fff]{0,2}/u, capability: 'financial_action', lang: 'zh' },
      { pattern: /[\u4e00-\u9fff]{0,2}(?:æˆ‘|å·²|å·²ç»)\s*(?:è½¬è´¦|æ”¯ä»˜|ææ¬¾|å­˜æ¬¾)[\u4e00-\u9fff]{0,2}/u, capability: 'unauthorized_action', lang: 'zh' },

      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // ðŸ›¡ï¸ PII & EVASION (kept here for LLM output scanning â€” not for redaction)
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      { pattern: /\b(?:\+?234\s*|0)(?:70|80|81|90|91)\d{8}\b/, capability: 'pii_exposure', lang: 'multi' },
      { pattern: /\b(?:bvn|bank\s+verification\s+number)\b.{0,20}\d{11}/i, capability: 'pii_exposure', lang: 'multi' },
      { pattern: /(?:account|acct|a\/c|akaunti|asusu|hesabu|namba|#)\s*[:\-â€”â€“]?\s*(\d{6,})/i, capability: 'pii_exposure', lang: 'multi' },
      // âœ… FIXED: "approved/completed/confirmed" only counts as a deceptive claim when paired with
      // a first-person/transaction-completion frame â€” not when merely reporting contract text
      // (e.g. "the contract states invoice X was approved")
      {
        pattern: /\b(?:i\s+(?:have|'ve)|has\s+been|was|has)\s+(successful(?:ly)?|confirmed|approved|completed|processed|verified)\b/i,
        capability: 'deceptive_claim',
        lang: 'multi'
      },
    ];
  }

  // ================================
  // âœ… NEW v1.3.0 â€” PII REDACTION ENGINE
  //
  // Replaces PII tokens in a string with [LABEL_REDACTED] placeholders.
  // Returns the cleaned string + a structured redaction manifest for audit.
  //
  // This is intentionally separate from _validateInputs so callers can
  // choose to redact without halting (OLANG_PII_MODE=redact).
  // ================================

  _redactPII(text) {
    if (!text || typeof text !== 'string') {
      return { redacted: text, redactions: [], wasModified: false };
    }

    let redacted = text;
    const redactions = [];

    for (const { pattern, capability, lang, label } of this._getPIIPatterns()) {
      // All PII patterns must use /g flag for replaceAll behaviour
      const globalPattern = pattern.global
        ? pattern
        : new RegExp(pattern.source, pattern.flags + 'g');

      redacted = redacted.replace(globalPattern, (match) => {
        redactions.push({
          original: match,
          replacement: `[${label}_REDACTED]`,
          capability,
          lang,
          offset: redacted.indexOf(match) // approximate; accurate before mutations
        });
        return `[${label}_REDACTED]`;
      });
    }

    return {
      redacted,
      redactions,
      wasModified: redactions.length > 0
    };
  }

  // ================================
  // âœ… NEW v1.3.0 â€” PUBLIC REDACTION API
  //
  // Allows workflow authors and external callers to redact a string directly.
  // Backward compat: the old _validateInputs path is unchanged.
  //
  //   const { redacted, redactions } = runtime.redact(text);
  // ================================

  redact(text) {
    return this._redactPII(text);
  }

  // ================================
  // âœ… NEW: Initialize database client
  // ================================
  _initDbClient() {
    const dbType = process.env.OLANG_DB_TYPE; // 'postgres', 'mysql', 'mongodb', 'sqlite'
    if (!dbType) return; // DB persistence disabled
    try {
      switch (dbType.toLowerCase()) {
        case 'postgres':
        case 'postgresql':
          const { Pool } = require('pg');
          this.dbClient = {
            type: 'postgres',
            client: new Pool({
              host: process.env.DB_HOST || 'localhost',
              port: parseInt(process.env.DB_PORT) || 5432,
              user: process.env.DB_USER,
              password: process.env.DB_PASSWORD,
              database: process.env.DB_NAME
            })
          };
          break;
        case 'mysql':
          const mysql = require('mysql2/promise');
          this.dbClient = {
            type: 'mysql',
            client: mysql.createPool({
              host: process.env.DB_HOST || 'localhost',
              port: parseInt(process.env.DB_PORT) || 3306,
              user: process.env.DB_USER,
              password: process.env.DB_PASSWORD,
              database: process.env.DB_NAME
            })
          };
          break;
        case 'mongodb':
          const { MongoClient } = require('mongodb');
          const uri = process.env.MONGO_URI || `mongodb://${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 27017}`;
          this.dbClient = {
            type: 'mongodb',
            client: new MongoClient(uri)
          };
          break;
        case 'sqlite':
          const Database = require('better-sqlite3');
          const dbPath = process.env.SQLITE_PATH || './olang.db';
          const dbDir = path.dirname(path.resolve(dbPath));
          if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
          this.dbClient = {
            type: 'sqlite',
            client: new Database(dbPath)
          };
          break;
        default:
          throw new Error(`Unsupported database type: ${dbType}`);
      }
      if (this.verbose) {
        console.log(`ðŸ—„ï¸  Database client initialized: ${dbType}`);
      }
    } catch (e) {
      this.addWarning(`Failed to initialize DB client: ${e.message}`);
      this.dbClient = null;
    }
  }

  // ================================
  // âœ… CRYPTOGRAPHIC AUDIT LOG METHODS
  // ================================

  /**
   * Create a hash of data using SHA-256
   */
  _hash(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

   /**
   * âœ… NEW: Recursively sort object keys to ensure deterministic hashing 
   * regardless of property insertion order.
   */
  _stableSerialize(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(item => this._stableSerialize(item));
    const sortedKeys = Object.keys(obj).sort();
    const sortedObj = {};
    for (const key of sortedKeys) {
      sortedObj[key] = this._stableSerialize(obj[key]);
    }
    return sortedObj;
  }


  /**
   * Sign data with private key (if available)
   */
  _sign(data) {
    if (!this.auditLogPrivateKey) return null;
    try {
      const keyType = crypto.createPrivateKey(this.auditLogPrivateKey).asymmetricKeyType;
      if (keyType === 'ed25519') {
        return crypto.sign(null, Buffer.from(data), this.auditLogPrivateKey).toString('base64');
      }
      const sign = crypto.createSign('SHA256');
      sign.update(data);
      sign.end();
      return sign.sign(this.auditLogPrivateKey, 'base64');
    } catch (e) {
      this.addWarning(`Audit log signing failed: ${e.message}`);
      if (process.env.OLANG_AUDIT_REQUIRE_SIGNATURES === 'true') throw e;
      return null;
    }
  }

  /**
   * Create a cryptographically verifiable audit log entry
   */
  _createAuditEntry(event, details, context = {}) {
    const timestamp = new Date().toISOString();
    const entryData = {
      timestamp,
      event,
      details,
      workflow: this.context.workflow_name,
      contextSnapshot: this._captureContextSnapshot(context),
      previousHash: this.previousHash,
      sequenceNumber: this.auditLog.length + 1
    };

    // Create hash of this entry
    const entryHash = this._hash(entryData);

    // Sign the entry if private key available
    const signature = this._sign(entryHash);

    let entryPublicKey = null;
let entrySignature = signature;

if (this.auditLogPrivateKey) {
  try {
    const privKeyObj = crypto.createPrivateKey(this.auditLogPrivateKey);
    const pubKeyObj = crypto.createPublicKey(privKeyObj);
    
    if (privKeyObj.asymmetricKeyType === 'ed25519') {
      entrySignature = crypto.sign(null, Buffer.from(entryHash), privKeyObj).toString('base64');
    } else {
      const sign = crypto.createSign('SHA256');
      sign.update(entryHash);
      sign.end();
      entrySignature = sign.sign(privKeyObj).toString('base64');
    }
    
    entryPublicKey = pubKeyObj.export({ type: 'spki', format: 'pem' }).trim();
  } catch (e) {
    console.warn('[O-Lang] Failed to sign audit entry:', e.message);
  }
}

    const entry = {
      ...entryData,
      hash: entryHash,
      signature: entrySignature,
      publicKey: entryPublicKey
    };

    // Update chain
    this.previousHash = entryHash;
    this.auditLog.push(entry);

    // Persist to file if enabled
    if (this.enableAuditLog) {
      this._persistAuditLog();
    }

    return entry;
  }

  /**
   * Capture relevant context snapshot for audit
   */
  _captureContextSnapshot(keys = []) {
    const snapshot = {};
    const keysToCapture = keys.length > 0 ? keys : [
      'workflow_name',
      'current_step',
      'agent_id'
    ];

    for (const key of keysToCapture) {
      if (this.context[key] !== undefined) {
        snapshot[key] = this.context[key];
      }
    }

    return snapshot;
  }

  /**
   * Persist audit log to file
   */
  _persistAuditLog() {
    try {
      fs.writeFileSync(
        this.auditLogFile,
        JSON.stringify(this.auditLog, null, 2),
        'utf8'
      );

      // Also persist to DB if configured
      if (this.dbClient && process.env.OLANG_AUDIT_DB_PERSIST === 'true') {
        this._persistAuditLogToDB();
      }
    } catch (e) {
      this.addWarning(`Failed to persist audit log: ${e.message}`);
    }
  }

  /**
   * Persist audit log to database
   */
  async _persistAuditLogToDB() {
    try {
      const latestEntry = this.auditLog[this.auditLog.length - 1];
      if (!latestEntry) return;

      switch (this.dbClient.type) {
        case 'postgres':
          await this.dbClient.client.query(
            `INSERT INTO audit_log (hash, previous_hash, event, details, timestamp, workflow_name, signature, sequence_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              latestEntry.hash,
              latestEntry.previousHash,
              latestEntry.event,
              JSON.stringify(latestEntry.details),
              latestEntry.timestamp,
              latestEntry.workflow,
              latestEntry.signature,
              latestEntry.sequenceNumber
            ]
          );
          break;

        case 'mysql':
          await this.dbClient.client.execute(
            `INSERT INTO audit_log (hash, previous_hash, event, details, timestamp, workflow_name, signature, sequence_number)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              latestEntry.hash,
              latestEntry.previousHash,
              latestEntry.event,
              JSON.stringify(latestEntry.details),
              latestEntry.timestamp,
              latestEntry.workflow,
              latestEntry.signature,
              latestEntry.sequenceNumber
            ]
          );
          break;

        case 'mongodb':
          const db = this.dbClient.client.db(process.env.DB_NAME || 'olang');
          await db.collection('audit_log').insertOne({
            hash: latestEntry.hash,
            previous_hash: latestEntry.previousHash,
            event: latestEntry.event,
            details: latestEntry.details,
            timestamp: new Date(latestEntry.timestamp),
            workflow_name: latestEntry.workflow,
            signature: latestEntry.signature,
            sequence_number: latestEntry.sequenceNumber
          });
          break;

        case 'sqlite':
          const stmt = this.dbClient.client.prepare(
            `INSERT INTO audit_log (hash, previous_hash, event, details, timestamp, workflow_name, signature, sequence_number)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          stmt.run(
            latestEntry.hash,
            latestEntry.previousHash,
            latestEntry.event,
            JSON.stringify(latestEntry.details),
            latestEntry.timestamp,
            latestEntry.workflow,
            latestEntry.signature,
            latestEntry.sequenceNumber
          );
          break;
      }
    } catch (e) {
      this.addWarning(`Failed to persist audit log to DB: ${e.message}`);
    }
  }

  /**
   * Verify the integrity of the audit log chain
   */
  verifyAuditLogIntegrity(auditLog = null) {
    const log = auditLog || this.auditLog;
    if (log.length === 0) {
      return { valid: true, message: 'Audit log is empty' };
    }

    // Verify genesis block
    if (log[0].previousHash !== 'GENESIS') {
      return { valid: false, error: 'Invalid genesis block', failedAtIndex: 0 };
    }

    // Verify chain integrity
    let previousHash = 'GENESIS';
    for (let i = 0; i < log.length; i++) {
      const entry = log[i];

      // Check previous hash linkage
      if (entry.previousHash !== previousHash) {
        return {
          valid: false,
          error: `Hash chain broken at entry ${i}`,
          failedAtIndex: i,
          expected: previousHash,
          actual: entry.previousHash
        };
      }

      // Verify entry hash
      const entryData = {
        timestamp: entry.timestamp,
        event: entry.event,
        details: entry.details,
        workflow: entry.workflow,
        contextSnapshot: entry.contextSnapshot,
        previousHash: entry.previousHash,
        sequenceNumber: entry.sequenceNumber
      };

      const calculatedHash = this._hash(entryData);
      if (calculatedHash !== entry.hash) {
        return {
          valid: false,
          error: `Entry hash mismatch at index ${i}`,
          failedAtIndex: i,
          expected: calculatedHash,
          actual: entry.hash
        };
      }

      // Verify signature if present
      if (process.env.OLANG_AUDIT_REQUIRE_SIGNATURES === 'true' && !(entry.signature && entry.publicKey)) {
          return { valid: false, error: "Missing signature at entry " + i, failedAtIndex: i };
        }
        
      if (entry.signature && entry.publicKey) {
  try {
    let isValid;
    const pubKeyObj = crypto.createPublicKey(entry.publicKey);
    
    if (pubKeyObj.asymmetricKeyType === 'ed25519') {
      isValid = crypto.verify(null, Buffer.from(entry.hash), entry.publicKey, Buffer.from(entry.signature, 'base64'));
    } else {
      const verify = crypto.createVerify('SHA256');
      verify.update(entry.hash);
      verify.end();
      isValid = verify.verify(entry.publicKey, entry.signature, 'base64');
    }
    
    if (!isValid) {
      return {
        valid: false,
        error: `Signature verification failed at entry ${i}`,
        failedAtIndex: i
      };
    }
  } catch (e) {
    return {
      valid: false,
      error: `Signature verification error at entry ${i}: ${e.message}`,
      failedAtIndex: i
    };
  }
}
      previousHash = entry.hash;
    }

    return {
      valid: true,
      message: `Audit log verified successfully (${log.length} entries)`,
      totalEntries: log.length,
      lastHash: previousHash
    };
  }

  /**
   * Get audit log excerpt with proof
   */
  getAuditExcerpt(startIndex, endIndex) {
    const excerpt = this.auditLog.slice(startIndex, endIndex + 1);
    const proof = {
      excerpt,
      previousHash: startIndex > 0 ? this.auditLog[startIndex - 1].hash : 'GENESIS',
      nextHash: endIndex < this.auditLog.length - 1 ? this.auditLog[endIndex + 1].hash : null,
      totalEntries: this.auditLog.length
    };

    return proof;
  }

  /**
   * Export audit log with verification data
   */
  exportAuditLog() {
    const verification = this.verifyAuditLogIntegrity();
    return {
      auditLog: this.auditLog,
      verification,
      exportedAt: new Date().toISOString(),
      totalEntries: this.auditLog.length,
      merkleRoot: this._calculateMerkleRoot()
    };
  }

  /**
   * Calculate Merkle root of audit log
   */
  _calculateMerkleRoot() {
    if (this.auditLog.length === 0) return null;

    let hashes = this.auditLog.map(entry => entry.hash);

    while (hashes.length > 1) {
      const newLevel = [];
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = i + 1 < hashes.length ? hashes[i + 1] : left;
        newLevel.push(this._hash(left + right));
      }
      hashes = newLevel;
    }

    return hashes[0];
  }

  /**
   * Get audit summary
   */
  getAuditSummary() {
    const verification = this.verifyAuditLogIntegrity();
    return {
      totalEntries: this.auditLog.length,
      integrity: verification,
      events: this.auditLog.map(e => e.event),
      merkleRoot: this._calculateMerkleRoot()
    };
  }

  // ================================
  // âœ… GOVERNANCE METADATA HELPERS
  // ================================

  /**
   * Generate immutable hash of governance profile
   * Includes: allowed resolvers, constraints, policy flags
   */
  _generateGovernanceProfileHash(workflow) {
    const profile = {
      version: '1.0',
      allowedResolvers: Array.from(this.allowedResolvers).sort(),
      maxGenerations: workflow.maxGenerations,
      strictInputs: process.env.OLANG_STRICT_INPUTS === 'true',
      semanticValidation: true,
      hallucinationPrevention: true,
      resolverPolicy: 'allowlist-only',
      timestamp: new Date().toISOString()
    };

    return crypto.createHash('sha256')
      .update(JSON.stringify(profile))
      .digest('hex');
  }

  /**
   * Get runtime metadata for external verification
   */
  getRuntimeMetadata() {
    return {
      runtime: 'O-Lang Kernel',
      version: KERNEL_VERSION,
      features: {
        semanticValidation: true,
        hallucinationPrevention: true,
        cryptographicAudit: true,
        multiDatabaseSupport: true,
        piiRedaction: true,    // âœ… NEW v1.3.0
        piiMode: this.piiMode, // âœ… NEW v1.3.0
        xhosaSupport: true     // âœ… NEW v1.3.0
      },
      environment: {
        auditEnabled: this.enableAuditLog,
        dbType: this.dbClient?.type || 'none',
        strictMode: process.env.OLANG_STRICT_INPUTS === 'true',
        piiMode: this.piiMode  // âœ… NEW v1.3.0
      }
    };
  }

  // -----------------------------
  // âœ… SEMANTIC ENFORCEMENT HELPER
  // -----------------------------
_requireSemantic(symbol, stepType) {
  // âœ… FIX: Use getNested to support dot notation like "intent.intent"
  const value = this.getNested(this.context, symbol);
  if (value === undefined) {
    const error = {
      type: 'semantic_violation',
      symbol: symbol,
      expected: 'defined value',
      used_by: stepType,
      phase: 'execution'
    };
    this.emit('semantic_violation', error);
    if (this.verbose) {
      console.error(`[O-Lang SEMANTIC] Missing required symbol "${symbol}" for ${stepType}`);
    }
    return false;
  }
  return true;
}

  // -----------------------------
  // Parser/runtime warnings
  // -----------------------------
  addWarning(message) {
    const entry = { message, timestamp: new Date().toISOString() };
    this.__warnings.push(entry);
    if (this.verbose) console.warn(`[O-Lang WARNING] ${message}`);
  }

  getWarnings() {
    return this.__warnings;
  }

  // -----------------------------
  // Event handling
  // -----------------------------
  on(eventName, cb) {
    if (!this.events[eventName]) this.events[eventName] = [];
    this.events[eventName].push(cb);
  }

  emit(eventName, payload) {
    if (this.events[eventName]) {
      this.events[eventName].forEach(cb => cb(payload));
    }
  }

  // -----------------------------
  // Disallowed resolver handling
  // -----------------------------
  logDisallowedResolver(resolverName, stepAction) {
    const entry = { resolver: resolverName, step: stepAction, timestamp: new Date().toISOString() };
    fs.appendFileSync(this.disallowedLogFile, JSON.stringify(entry) + '\n', 'utf8');
    this.disallowedAttempts.push(entry);

    // âœ… AUDIT LOG: Security violation with governance context
    this._createAuditEntry('security_violation', {
      type: 'disallowed_resolver',
      resolver: resolverName,
      step: stepAction,
      severity: 'high',
      kernel_version: KERNEL_VERSION,
      governance_profile_hash: this._generateGovernanceProfileHash({
        allowedResolvers: Array.from(this.allowedResolvers),
        maxGenerations: null
      })
    });

    if (this.verbose) {
      console.warn(`[O-Lang] Disallowed resolver blocked: ${resolverName} | step: ${stepAction}`);
    }
  }

  printDisallowedSummary() {
    if (!this.disallowedAttempts.length) return;
    console.log('\n[O-Lang] âš ï¸ Disallowed resolver summary:');
    console.log(`Total blocked attempts: ${this.disallowedAttempts.length}`);
    const displayCount = Math.min(5, this.disallowedAttempts.length);
    this.disallowedAttempts.slice(0, displayCount).forEach((e, i) => {
      console.log(`${i + 1}. Resolver: ${e.resolver}, Step: ${e.step}, Time: ${e.timestamp}`);
    });
    if (this.disallowedAttempts.length > displayCount) {
      console.log(`...and ${this.disallowedAttempts.length - displayCount} more entries logged in ${this.disallowedLogFile}`);
    }
  }

  // -----------------------------
  // âœ… ADDITION 1 â€” External Resolver Detection
  // -----------------------------
  _isExternalResolver(resolver) {
    return Boolean(
      resolver &&
      resolver.manifest &&
      typeof resolver.manifest === 'object' &&
      typeof resolver.manifest.protocol === 'string' &&
      resolver.manifest.protocol.startsWith('http')
    );
  }

    // -----------------------------
  // âœ… UPDATED â€” External Resolver Invocation with Cryptographic Verification
  // -----------------------------
  async _callExternalResolver(resolver, action, context) {
    const manifest = resolver.manifest;
    const endpoint = manifest.endpoint;
    const timeoutMs = manifest.timeout_ms || 30000;
    const trustedPubkey = manifest.trustedPubkey; // ðŸ›¡ï¸ NEW: Trusted public key for verification

    const payload = {
      action,
      context,
      resolver: resolver.resolverName,
      workflow: context.workflow_name,
      prevHash: this.previousHash, // ðŸ›¡ï¸ NEW: Pass current chain head for linking
      timestamp: new Date().toISOString()
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${endpoint}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const json = await res.json();

      if (json?.error) {
        throw new Error(json.error.message || 'External resolver error');
      }

      // ðŸ›¡ï¸ NEW: Cryptographic Verification of Agent Response
      if (json.stepRecord && trustedPubkey) {
        console.log(`[O-Lang] ðŸ” Verifying cryptographic signature from external agent...`);
        
        // 1. Verify the Ed25519 signature
        verifyStepSignature(json.stepRecord, trustedPubkey);
        
        // 2. Verify the hash chain linkage
        verifyHashLink(this.previousHash, json.stepRecord);
        
        // 3. Log the verified step
        this._createAuditEntry('external_agent_verified', {
          agentId: json.stepRecord.agentId,
          step: json.stepRecord.step,
          hash: json.stepRecord.hash,
          severity: 'info'
        });
        
        // 4. Update the chain head
        this.previousHash = json.stepRecord.hash;
        
        console.log(`[O-Lang] âœ… External agent signature verified successfully`);
        
        return json.stepRecord.output || json.result;
      }

      // Fallback: No cryptographic verification (legacy behavior)
      if (!trustedPubkey) {
        this.addWarning(`External resolver "${resolver.resolverName}" has no trustedPubkey. Skipping cryptographic verification.`);
      }

      return json.result;

    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`External resolver timeout after ${timeoutMs}ms`);
      }
      
      // ðŸ›¡ï¸ NEW: Log governance violations
      if (err.message.includes('Governance Violation')) {
        this._createAuditEntry('governance_violation', {
          type: 'external_agent_verification_failed',
          resolver: resolver.resolverName,
          error: err.message,
          severity: 'critical'
        });
      }
      
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  
  // -----------------------------
  // Utilities
  // -----------------------------
  getNested(obj, path) {
    if (!path) return undefined;
    return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  }

  /**
   * evaluateCondition(cond, ctx)
   * 
   * Governance Features:
   *   1. Quote-Aware Parsing: Prevents splitting on "or"/"and" inside quoted strings.
   *   2. Strict Equality: Uses === to prevent type-coercion safety bypasses.
   *   3. Comprehensive Operators: Supports gte, lte, contains, not equals.
   *   4. Auditability: Warns on unrecognised syntax to prevent silent failures.
   */
  evaluateCondition(condition, context) {
    if (!condition) return false;
    condition = condition.trim();

    const self = this;

    // â”€â”€ Helper: split on logical operators OUTSIDE quotes AND parentheses â”€â”€
    function splitOutsideQuotesAndParens(str, operatorRegex) {
      const parts = [];
      let current = '';
      let inQuote = false;
      let quoteChar = '';
      let parenDepth = 0;

      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        const prev = str[i - 1];

        // Toggle quote state
        if ((ch === '"' || ch === "'") && prev !== '\\') {
          if (!inQuote) {
            inQuote = true;
            quoteChar = ch;
          } else if (ch === quoteChar) {
            inQuote = false;
            quoteChar = '';
          }
          current += ch;
          continue;
        }

        if (inQuote) {
          current += ch;
          continue;
        }

        // Track parenthesis depth
        if (ch === '(') {
          parenDepth++;
          current += ch;
        } else if (ch === ')') {
          parenDepth--;
          current += ch;
        } else if (parenDepth === 0 && ch === ' ') {
          // At depth 0, check for operator match
          const remaining = str.slice(i + 1).trimStart();
          const m = remaining.match(operatorRegex);
          if (m && m.index === 0) {
            parts.push(current.trim());
            current = '';
            i += m[0].length; // skip the operator + trailing space
            continue;
          } else {
            current += ch;
          }
        } else {
          current += ch;
        }
      }

      if (current.trim()) parts.push(current.trim());
      return parts.filter(Boolean);
    }

    // â”€â”€ Helper: strip outer matching parens â”€â”€
    function stripOuterParens(str) {
      str = str.trim();
      while (str.startsWith('(') && str.endsWith(')')) {
        let depth = 0;
        let matched = true;
        for (let i = 0; i < str.length - 1; i++) {
          if (str[i] === '(') depth++;
          else if (str[i] === ')') depth--;
          if (depth === 0 && i < str.length - 1) {
            matched = false;
            break;
          }
        }
        if (matched && depth === 1) {
          str = str.slice(1, -1).trim();
        } else {
          break;
        }
      }
      return str;
    }

    // â”€â”€ Recursive evaluator â”€â”€
    function evaluateSingle(cond, ctx) {
      cond = stripOuterParens(cond);

      // 1. Top-level AND
      const andParts = splitOutsideQuotesAndParens(cond, /^(and)\b/i);
      if (andParts.length > 1) {
        return andParts.every(part => evaluateSingle(part, ctx));
      }

      // 2. Top-level OR
      const orParts = splitOutsideQuotesAndParens(cond, /^(or)\b/i);
      if (orParts.length > 1) {
        return orParts.some(part => evaluateSingle(part, ctx));
      }

      // 3. Base case: single comparison
      const cleanCond = cond.trim();

      // equals
      let m = cleanCond.match(/^\{(.+?)\}\s+equals\s+"(.*)"$/);
      if (m) {
        const val = self.getNested(ctx, m[1].trim());
        return String(val ?? '') === m[2];
      }

      // not equals
      m = cleanCond.match(/^\{(.+?)\}\s+not\s+equals\s+"(.*)"$/);
      if (m) {
        const val = self.getNested(ctx, m[1].trim());
        return String(val ?? '') !== m[2];
      }

      // contains
      m = cleanCond.match(/^\{(.+?)\}\s+contains\s+"(.*)"$/);
      if (m) {
        const val = self.getNested(ctx, m[1].trim());
        return String(val ?? '').includes(m[2]);
      }

      // not contains
      m = cleanCond.match(/^\{(.+?)\}\s+not\s+contains\s+"(.*)"$/);
      if (m) {
        const val = self.getNested(ctx, m[1].trim());
        return !String(val ?? '').includes(m[2]);
      }

      // exists
      m = cleanCond.match(/^\{(.+?)\}\s+exists$/);
      if (m) {
        const val = self.getNested(ctx, m[1].trim());
        return val !== undefined && val !== null && val !== '';
      }

      // numeric comparisons
      m = cleanCond.match(/^\{(.+?)\}\s+greater\s+than\s+(\d+\.?\d*)$/);
      if (m) return parseFloat(self.getNested(ctx, m[1].trim())) > parseFloat(m[2]);

      m = cleanCond.match(/^\{(.+?)\}\s+less\s+than\s+(\d+\.?\d*)$/);
      if (m) return parseFloat(self.getNested(ctx, m[1].trim())) < parseFloat(m[2]);

      m = cleanCond.match(/^\{(.+?)\}\s+greater\s+than\s+or\s+equal\s+(\d+\.?\d*)$/);
      if (m) return parseFloat(self.getNested(ctx, m[1].trim())) >= parseFloat(m[2]);

      m = cleanCond.match(/^\{(.+?)\}\s+less\s+than\s+or\s+equal\s+(\d+\.?\d*)$/);
      if (m) return parseFloat(self.getNested(ctx, m[1].trim())) <= parseFloat(m[2]);

      // Truthy fallback with warning
      const fallbackKey = cleanCond.replace(/^\{|\}$/g, '').trim();
      const fallbackValue = self.getNested(ctx, fallbackKey);
      self.addWarning(
        `evaluateCondition: unrecognised condition syntax "${cleanCond}" â€” ` +
        `falling back to truthy check on "${fallbackKey}" ` +
        `(value: ${JSON.stringify(fallbackValue)}). ` +
        `If this is unintentional, check your condition syntax.`
      );
      return Boolean(fallbackValue);
    }

    return evaluateSingle(condition, context);
  }

  mathFunctions = {
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    multiply: (a, b) => a * b,
    divide: (a, b) => a / b,
    equals: (a, b) => a === b,
    greater: (a, b) => a > b,
    less: (a, b) => a < b,
    sum: arr => arr.reduce((acc, val) => acc + val, 0),
    avg: arr => arr.reduce((acc, val) => acc + val, 0) / arr.length,
    min: arr => Math.min(...arr),
    max: arr => Math.max(...arr),
    increment: a => a + 1,
    decrement: a => a - 1,
    round: a => Math.round(a),
    floor: a => Math.floor(a),
    ceil: a => Math.ceil(a),
    abs: a => Math.abs(a)
  };

  evaluateMath(expr) {
  const SafeMath = require('../safe-math');
  
  if (typeof expr !== 'string') return expr;
  
  const trimmed = expr.trim();
  
  // â”€â”€ PASS 1: Handle quoted string literals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    let inner = trimmed.slice(1, -1);
    inner = inner.replace(/\{([^\}]+)\}/g, (_, path) => {
      const value = this.getNested(this.context, path.trim());
      return value !== undefined ? String(value) : `{${path}}`;
    });
    return inner;
  }

  // âœ… FIX: Guard against empty expressions before they reach arithmetic checks.
  // Root cause: workflow parsers may strip quotes from `Calculate ""` before
  // this method ever sees them, so `trimmed` arrives as '' rather than '""'.
  // Pass 1 above only catches quoted literals, so a bare '' falls through to
  // Pass 2, where SafeMath.isArithmetic('') can return true (permissive
  // regexes often allow zero-length matches), causing SafeMath.evaluate('')
  // to produce a numeric 0 instead of an empty string. That stray 0 then gets
  // interpolated into composed responses (e.g. "0A key aspect of...").
  if (trimmed === '') {
    if (this.verbose) {
      console.log(`[CALCULATE] Empty expression â†’ returning ''`);
    }
    return '';
  }

  // â”€â”€ PASS 2: Check if raw expression is arithmetic (no variables) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (SafeMath.isArithmetic(trimmed)) {
    const result = SafeMath.evaluate(trimmed);
    if (result.success) {
      const rounded = Math.round(result.result * 10000) / 10000;
      if (this.verbose) {
        console.log(`[CALCULATE] Arithmetic: "${trimmed}" â†’ ${rounded}`);
      }
      return rounded;
    } else {
      this.addWarning(`[CALCULATE] Math failed: ${result.error}. Falling back.`);
    }
  }
  
  // â”€â”€ PASS 3: Interpolate variables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let interpolated = trimmed.replace(/\{([^\}]+)\}/g, (_, p) => {
    const v = this.getNested(this.context, p.trim());
    if (v === undefined) return '0';
    if (typeof v === 'string') {
      if (!isNaN(v) && v.trim() !== '') return v;
      return `"${v.replace(/"/g, '\\"')}"`;
    }
    return v;
  });
  
  // â”€â”€ PASS 4: Check if interpolated result is arithmetic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (SafeMath.isArithmetic(interpolated)) {
    const result = SafeMath.evaluate(interpolated);
    if (result.success) {
      const rounded = Math.round(result.result * 10000) / 10000;
      if (this.verbose) {
        console.log(`[CALCULATE] Arithmetic (post-interpolation): "${interpolated}" â†’ ${rounded}`);
      }
      return rounded;
    } else {
      this.addWarning(`[CALCULATE] Post-interpolation math failed: ${result.error}`);
    }
  }
  
  // â”€â”€ PASS 5: Check if it contains mathFunctions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const funcNames = Object.keys(this.mathFunctions);
  const hasMathFunction = funcNames.some(fn => 
    new RegExp(`\\b${fn}\\s*\\(`, 'i').test(interpolated)
  );
  
  if (hasMathFunction) {
    const safeFunc = {};
    funcNames.forEach(fn => safeFunc[fn] = this.mathFunctions[fn]);
    
    try {
      const f = new Function(...funcNames, `return ${interpolated};`);
      return f(...funcNames.map(fn => safeFunc[fn]));
    } catch (e) {
      this.addWarning(`Failed to evaluate math expression "${interpolated}": ${e.message}`);
      return 0;
    }
  }
  
  // â”€â”€ PASS 6: Not arithmetic, not a function call â€” return as string â”€â”€â”€â”€â”€â”€â”€
  let result = interpolated;
  
  // Remove quotes that were added for Function constructor compatibility
  // Pattern: "value" â†’ value (strips surrounding quotes from interpolated strings)
  result = result.replace(/"([^"]*)"/g, '$1');
  
  return result;
}

  findLastSummaryStep() {
    for (let i = this.workflowSteps.length - 1; i >= 0; i--) {
      const step = this.workflowSteps[i];
      if (step.type === 'action' && step.actionRaw?.startsWith('Ask ') && step.saveAs) return step;
    }
    return null;
  }

  // -----------------------------
  // âœ… SAFE INTERPOLATION HELPER (CRITICAL FOR HALLUCINATION PREVENTION)
  // -----------------------------
  _safeInterpolate(template, context, contextType = 'action') {
    return template.replace(/\{([^\}]+)\}/g, (_, path) => {
      const value = this.getNested(context, path.trim());
      if (value === undefined) {
        return `{${path}}`; // Preserve placeholder for downstream validation
      }
      // ðŸ”’ SAFETY GUARD: Block object/array interpolation into string contexts
      if (value !== null && typeof value === 'object') {
        const type = Array.isArray(value) ? 'array' : 'object';
        const keys = Object.keys(value).length > 0
          ? Object.keys(value).join(', ')
          : '(empty)';
        throw new Error(
          `[O-Lang SAFETY] Cannot interpolate ${type} "{${path}}" into ${contextType}.\n` +
          `  â†’ Contains fields: ${keys}\n` +
          `  â†’ Use dot notation: "{${path}.field}" (e.g., {account_info.balance})\n` +
          `\nðŸ›‘ Halting to prevent data corruption â†’ LLM hallucination.`
        );
      }
      return String(value);
    });
  }

  // ================================
  // âœ… UPDATED v1.3.0 â€” KERNEL-LEVEL INPUT VALIDATION (Pre-Flight Safety)
  //
  // BACKWARD COMPAT:
  //   OLANG_PII_MODE=block  (default) â†’ original behaviour, throws on any match
  //   OLANG_PII_MODE=redact           â†’ replaces PII tokens, continues
  //   OLANG_PII_MODE=redact-and-log   â†’ redact + audit entry per redaction event
  //
  // Financial intent patterns always throw regardless of PII mode.
  // ================================
  _validateInputs(inputs) {
    // Only scan specific input fields that contain user text
    // NOTE: 'document_text' intentionally excluded â€” legal documents legitimately
    // contain financial terms and must not be blocked at the input layer.
    const fieldsToScan = ['user_message', 'user_question', 'text', 'prompt'];

    const redactMode = this.piiMode === 'redact' || this.piiMode === 'redact-and-log';
    const allRedactions = {};

    // âœ… PASS 0: ENTITY ANONYMIZATION (Run BEFORE PII redaction)
    // Expects `inputs.entities` to be an array like: 
    // [{ type: 'employee', name: 'OLATUNJI DAVID OLADAPO', id: '123' }]
    if (this.entityAnonymizer && this.entityAnonymizer.enabled && Array.isArray(inputs.entities)) {
      for (const field of fieldsToScan) {
        if (inputs[field] && typeof inputs[field] === 'string') {
          const { anonymized, mapping, redactionCount } = this.entityAnonymizer.anonymize(
            inputs[field],
            inputs.entities,
            { 
              logAudit: true, 
              sessionId: inputs.session_id || this.context.session_id 
            }
          );

          if (redactionCount > 0) {
            inputs[field] = anonymized; // Mutate in place â€” caller sees clean value
            inputs._entityMapping = mapping; // Store mapping to deanonymize LLM response later

            if (this.verbose) {
              console.log(
                `ðŸ›¡ï¸ [O-Lang Entity] Anonymized ${redactionCount} entity(ies) in "${field}": ` +
                Object.keys(mapping).join(', ')
              );
            }
          }
        }
      }
    }


    // â”€â”€ PASS 1: PII redaction (when mode allows) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (redactMode) {
      for (const field of fieldsToScan) {
        const text = inputs[field];
        if (!text || typeof text !== 'string') continue;

        const { redacted, redactions, wasModified } = this._redactPII(text);

        if (wasModified) {
          inputs[field] = redacted; // mutate in place â€” caller sees clean value
          allRedactions[field] = redactions;

          if (this.piiMode === 'redact-and-log') {
            this._createAuditEntry('pii_redacted', {
              field,
              redaction_count: redactions.length,
              redactions: redactions.map(r => ({
                label: r.replacement,
                capability: r.capability,
                lang: r.lang
                // NOTE: original value intentionally excluded from audit log
                // to avoid persisting the very PII we just redacted
              })),
              severity: 'info'
            });
          }

          if (this.verbose) {
            console.log(
              `ðŸ›¡ï¸  [O-Lang PII] Redacted ${redactions.length} item(s) in "${field}": ` +
              redactions.map(r => r.replacement).join(', ')
            );
          }
        }
      }
    }

    // â”€â”€ PASS 2: Financial intent scan (always blocks, mode-independent) â”€â”€â”€
    for (const field of fieldsToScan) {
      const text = inputs[field]; // may already be PII-redacted from pass 1
      if (!text || typeof text !== 'string') continue;

      // ðŸ”’ CONJUGATION-AWARE + EVASION-RESISTANT PAN-AFRICAN INTENT DETECTION (INPUT)
      for (const { pattern, capability, lang } of this._getFinancialIntentPatterns()) {
        if (pattern.test(text)) {
          const match = text.match(pattern);
          const isAfrican = ['yo', 'ig', 'ha', 'sw', 'zu', 'xh', 'am', 'om', 'ff', 'so', 'sn','tw'].includes(lang);
          const isFinancial = ['transfer', 'payment', 'withdrawal', 'deposit', 'financial_action'].includes(capability);

          // âœ… DECOUPLED: Check legal context via standardized signals (not UI fields)
          const intent = this.context.__verified_intent || {};
          const signals = intent.context_signals || {};

          const isLegalContext =
            // Signal 1: Explicit scope declaration
            intent.scope === 'legal_analysis_only' ||

            // Signal 2: Standardized context signals (server-mapped, UI-agnostic)
            signals.isLegalDocument === true ||
            signals.documentCategory === 'contract' ||
            signals.documentCategory === 'nda' ||
            signals.documentCategory === 'agreement' ||
            signals.documentCategory === 'legal' ||

            // Signal 3: Semantic fallback (works even if signals missing)
            (typeof text === 'string' && /clause|term|agreement|contract|obligation|penalty|damages|breach|party|shall|herein/i.test(text));

          // âœ… NEW: Check contextual allowlist if in legal context
          if (isLegalContext && this.context.__verified_intent?.contextual_allowlist) {
            const allowlist = this.context.__verified_intent.contextual_allowlist;
            const triggerWord = match ? match[0].toLowerCase() : '';

            const allowed = allowlist.some(rule => {
              // Check if this pattern's capability matches the rule's trigger
              const triggerMatch =
                triggerWord.includes(rule.trigger.toLowerCase()) ||
                capability.toLowerCase().includes(rule.trigger.toLowerCase()); // â† Handle capability-level triggers

              if (triggerMatch) {
                // Check if required legal keywords are present
                return rule.requires.some(keyword =>
                  text.toLowerCase().includes(keyword.toLowerCase())
                );
              }
              return false;
            });

            if (allowed) {
              // âœ… AUDIT LOG: Contextual allowlist bypass
              this._createAuditEntry('safety_bypass', {
                type: 'contextual_allowlist',
                trigger: triggerWord,
                legal_context: true,
                matched_keywords: this.context.__verified_intent.contextual_allowlist
                  .find(r => triggerWord.includes(r.trigger.toLowerCase()))?.requires || [],
                severity: 'info'
              });
              continue; // Skip blocking this match
            }
          }

          // âœ… AUDIT LOG: Input Safety Violation (only if not bypassed)
          this._createAuditEntry('input_safety_violation', {
            type: 'blocked_input',
            field: field,
            detected_phrase: match ? match[0].trim() : 'unknown pattern',
            capability: capability,
            language: lang,
            african_language_detected: isAfrican,
            financial_expression_found: isFinancial,
            legal_context_detected: false,
            severity: 'high'
          });

          throw new Error(
            `[O-Lang SAFETY] Blocked Input in "${lang}":\n` +
            `  â†’ Detected: "${match ? match[0].trim() : 'Pattern Match'}"\n` +
            `  â†’ Capability: ${capability}\n` +
            `  â†’ Field: ${field}\n` +
            `  â†’ African Language Detected: ${isAfrican}\n` +
            `  â†’ Financial Expression: ${isFinancial}\n` +
            `\nðŸ›‘ Workflow halted before execution.`
          );
        }
      }
    }

    // â”€â”€ PASS 3: PII block scan (only in block mode â€” original behaviour) â”€â”€
    if (!redactMode) {
      for (const field of fieldsToScan) {
        const text = inputs[field];
        if (!text || typeof text !== 'string') continue;

        for (const { pattern, capability, lang, label } of this._getPIIPatterns()) {
          if (pattern.test(text)) {
            const match = text.match(pattern);
            const isAfrican = ['yo', 'ig', 'ha', 'sw', 'zu', 'xh', 'am', 'om', 'ff', 'so', 'sn','tw'].includes(lang);

            this._createAuditEntry('input_safety_violation', {
              type: 'blocked_input',
              field: field,
              detected_phrase: match ? match[0].trim() : 'unknown pattern',
              capability: capability,
              language: lang,
              african_language_detected: isAfrican,
              financial_expression_found: false,
              pii_type: label,
              severity: 'high'
            });

            throw new Error(
              `[O-Lang SAFETY] Blocked PII in field "${field}" (${lang}):\n` +
              `  â†’ Type: ${label}\n` +
              `  â†’ Capability: ${capability}\n` +
              `\nðŸ›‘ Workflow halted before execution. Set OLANG_PII_MODE=redact to auto-redact instead.`
            );
          }
        }
      }
    }

    return {
      passed: true,
      redactions: Object.keys(allRedactions).length > 0 ? allRedactions : null
    };
  }

  // ================================
  // âœ… UPDATED v1.3.0 â€” KERNEL-LEVEL LLM HALLUCINATION PREVENTION
  // (CONJUGATION-AWARE + EVASION-RESISTANT)
  //
  // Now uses _getFinancialIntentPatterns() instead of inline duplicate.
  // Xhosa patterns included automatically via the shared set.
  // All __verified_intent logic unchanged for backward compat.
  // ================================
  _validateLLMOutput(output, actionContext) {
    if (!output || typeof output !== 'string') return { passed: true };

    // â”€â”€ __verified_intent takes priority â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const intent = this.context.__verified_intent;
    if (intent) {
      if (intent.prohibited_actions && Array.isArray(intent.prohibited_actions)) {
        const lower = output.toLowerCase();
        for (const action of intent.prohibited_actions) {
          if (lower.includes(action.toLowerCase())) {
            return {
              passed: false,
              reason: `Output violates prohibited action "${action}" defined in __verified_intent`,
              detected: action,
              language: 'multi'
            };
          }
        }
      }

      if (intent.prohibited_topics && Array.isArray(intent.prohibited_topics)) {
        for (const topic of intent.prohibited_topics) {
          const isRegex = typeof topic === 'object' && topic.pattern;
          let matched = false;
          let detected = '';

          if (isRegex) {
            try {
              const re = new RegExp(topic.pattern, topic.flags || 'i');
              const match = output.match(re);
              matched = !!match;
              detected = match ? match[0] : topic.pattern;
            } catch (e) {
              this.addWarning(`Invalid prohibited_topic regex: "${topic.pattern}" â€” ${e.message}`);
              continue;
            }
          } else {
            matched = output.toLowerCase().includes(topic.toLowerCase());
            detected = topic;
          }

          if (matched) {
            return {
              passed: false,
              reason: `Output violates prohibited topic "${isRegex ? topic.pattern : topic}" defined in __verified_intent`,
              detected,
              language: 'multi'
            };
          }
        }
      }

      // __verified_intent present and passed â€” skip hardcoded patterns
      return { passed: true };
    }

    // â”€â”€ No __verified_intent â€” fall through to shared pattern set â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // ðŸ”‘ Extract allowed capabilities from workflow allowlist
    const allowedCapabilities = Array.from(this.allowedResolvers)
      .filter(name => !name.startsWith('llm-') && name !== 'builtInMathResolver')
      .map(name => name.replace('@o-lang/', '').replace(/-resolver$/, ''));

    // ðŸ”’ SCAN OUTPUT FOR FORBIDDEN INTENTS (shared set â€” includes Xhosa)
    for (const { pattern, capability, lang } of this._getFinancialIntentPatterns()) {
      if (pattern.test(output)) {
        const hasCapability = allowedCapabilities.some(c =>
          c.includes(capability) ||
          c.includes('transfer') ||
          c.includes('payment') ||
          c.includes('financial') ||
          c.includes('deposit') ||
          c.includes('withdraw')
        );

        if (!hasCapability) {
          const match = output.match(pattern);

          // âœ… Explicitly flag African & Financial context for Audit Logs
          const isAfrican = ['yo', 'ig', 'ha', 'sw', 'zu', 'xh', 'am', 'om', 'ff', 'so', 'sn','tw'].includes(lang);
          const isFinancial = ['transfer', 'payment', 'withdrawal', 'deposit', 'financial_action'].includes(capability);

          return {
            passed: false,
            reason: `Hallucinated "${capability}" capability in ${lang}...`,
            detected: match ? match[0].trim() : 'unknown pattern',
            language: lang,
            african_language_detected: isAfrican,
            financial_expression_found: isFinancial,
            capability_attempted: capability
          };
        }
      }
    }
    return { passed: true };
  }

  // -----------------------------
  // âœ… CRITICAL FIX: Resolver output unwrapping helper
  // -----------------------------
  _unwrapResolverResult(result) {
    if (result && typeof result === 'object') {
      if (result.output !== undefined) return result.output;
      if (result.response !== undefined) return result.response; // âœ… ADD THIS
      if (result.text !== undefined) return result.text;
      if (result.content !== undefined) return result.content;
    }
    return result;
  }

   // âœ… NEW: Deanonymize LLM responses before returning to user
  // -----------------------------
  _deanonymizeResponse(result, context) {
    if (!result || !context._entityMapping) return result;
    
    const mapping = context._entityMapping;

    // Handle direct string returns
    if (typeof result === 'string') {
      return this.entityAnonymizer.deanonymize(result, mapping);
    }
    
    // Handle object returns with common text fields
    if (result.response && typeof result.response === 'string') {
      result.response = this.entityAnonymizer.deanonymize(result.response, mapping);
    }
    if (result.text && typeof result.text === 'string') {
      result.text = this.entityAnonymizer.deanonymize(result.text, mapping);
    }
    if (result.reply && typeof result.reply === 'string') {
      result.reply = this.entityAnonymizer.deanonymize(result.reply, mapping);
    }
    
    return result;
  }

  // -----------------------------
  // Step execution (WHERE RESOLVERS ARE INVOKED)
  // -----------------------------
  async executeStep(step, agentResolver) {
    const stepType = step.type;

    // âœ… Enforce per-step constraints (basic validation)
    if (step.constraints && Object.keys(step.constraints).length > 0) {
      for (const [key, value] of Object.entries(step.constraints)) {
        if (['max_time_sec', 'cost_limit', 'allowed_resolvers'].includes(key)) {
          this.addWarning(`Per-step constraint "${key}=${value}" is parsed but not yet enforced`);
        } else {
          this.addWarning(`Unknown per-step constraint: ${key}=${value}`);
        }
      }
    }

    // âœ… ADDITION 3 â€” Resolver Policy Enforcement (External + Local)
    const enforceResolverPolicy = (resolver, step) => {
      const resolverName = resolver?.resolverName || resolver?.name;
      if (!resolverName) {
        throw new Error('[O-Lang] Resolver missing resolverName');
      }
      if (!this.allowedResolvers.has(resolverName)) {
        this.logDisallowedResolver(resolverName, step.actionRaw || step.type);
        throw new Error(
          `[O-Lang] Resolver "${resolverName}" blocked by workflow policy`
        );
      }
      if (this._isExternalResolver(resolver)) {
        if (!resolver.manifest.endpoint) {
          throw new Error(
            `[O-Lang] External resolver "${resolverName}" missing endpoint`
          );
        }
      }
    };

    // âœ… CORRECTED: Strict safety WITH dynamic diagnostics
    const runResolvers = async (action) => {
      const mathPattern =
        /^(Add|Subtract|Multiply|Divide|Sum|Avg|Min|Max|Round|Floor|Ceil|Abs)\b/i;
      if (
        step.actionRaw &&
        mathPattern.test(step.actionRaw) &&
        !this.allowedResolvers.has('builtInMathResolver')
      ) {
        this.allowedResolvers.add('builtInMathResolver');
      }

      let resolversToRun = [];
      if (agentResolver && Array.isArray(agentResolver._chain)) {
        resolversToRun = agentResolver._chain;
      } else if (Array.isArray(agentResolver)) {
        resolversToRun = agentResolver;
      } else if (agentResolver) {
        resolversToRun = [agentResolver];
      }

      const resolverAttempts = [];
      for (let idx = 0; idx < resolversToRun.length; idx++) {
        const resolver = resolversToRun[idx];
        const resolverName = resolver?.resolverName || resolver?.name || `resolver-${idx}`;
        enforceResolverPolicy(resolver, step);

        try {
          let result;
          if (this._isExternalResolver(resolver)) {
            result = await this._callExternalResolver(
              resolver,
              action,
              this.context
            );
          } else {
            result = await this._callLocalResolver(resolver, action, this.context);
          }

          if (result !== undefined && result !== null) {
            this.context[`__resolver_${idx}`] = result;
            return this._unwrapResolverResult(result);
          }

          resolverAttempts.push({
            name: resolverName,
            status: 'skipped',
            reason: 'Action not recognized'
          });
        } catch (e) {
      if (e && e.governance) throw e; // GRaaS: fail-closed on governance violations
      const diagnostics = {
            error: e.message || String(e),
            requiredEnvVars: e.requiredEnvVars || [],
            missingInputs: e.missingInputs || [],
            documentationUrl: resolver?.documentationUrl ||
              (resolver?.manifest?.documentationUrl) || null
          };
          resolverAttempts.push({
            name: resolverName,
            status: 'failed',
            diagnostics
          });
          this.addWarning(`Resolver "${resolverName}" failed for action "${action}": ${diagnostics.error}`);
        }
      }

       // âœ… ENHANCED: Extract step location context for debugging
      const stepLabel = step.label || `unnamed_${step.type}_step`;
      const branchContext = step._parentLabel ? ` [Inside ${step._parentLabel} â†’ ${step._branch} branch]` : '';
      
      let errorMessage = `[O-Lang SAFETY] No resolver handled action: "${action}"\n`;
      errorMessage += `  â†’ Location: ${stepLabel}${branchContext}\n`;
      errorMessage += `  â†’ Workflow: ${this.context.workflow_name || 'unknown'}\n`;
      errorMessage += `Attempted resolvers:\n`;
      
      resolverAttempts.forEach((attempt, i) => {
        const namePad = attempt.name.padEnd(30);
        if (attempt.status === 'skipped') {
          errorMessage += `  ${i + 1}. ${namePad} â†’ SKIPPED (action not recognized)\n`;
        } else {
          errorMessage += `  ${i + 1}. ${namePad} â†’ FAILED\n`;
          errorMessage += `     Error: ${attempt.diagnostics.error}\n`;
          if (attempt.diagnostics.requiredEnvVars?.length) {
            errorMessage += `     Required env vars: ${attempt.diagnostics.requiredEnvVars.join(', ')}\n`;
          }
          if (attempt.diagnostics.documentationUrl) {
            errorMessage += `     Docs: ${attempt.diagnostics.documentationUrl}\n`;
          }
        }
      });

      const failed = resolverAttempts.filter(a => a.status === 'failed');
      const allSkipped = failed.length === 0;
      errorMessage += `\nðŸ’¡ How to fix:\n`;
      if (allSkipped) {
        errorMessage += `  â€¢ Verify the action matches a resolver's capabilities:\n`;
        errorMessage += `    â†’ Check resolver documentation for supported actions\n`;
        errorMessage += `    â†’ Ensure correct resolver package is installed\n`;
        errorMessage += `    â†’ Run with --verbose to see resolver matching details\n`;
      } else {
        errorMessage += `  â€¢ Address resolver errors shown above:\n`;
        errorMessage += `    â†’ Set required environment variables (if listed)\n`;
        errorMessage += `    â†’ Verify inputs exist in workflow context\n`;
        errorMessage += `    â†’ Check resolver documentation for requirements\n`;
        const envVarPattern = /environment variable|env\.|process\.env|missing.*path/i;
        if (failed.some(f => envVarPattern.test(f.diagnostics.error))) {
          errorMessage += `    â†’ Example (PowerShell): $env:VARIABLE="value"\n`;
          errorMessage += `    â†’ Example (Linux/macOS): export VARIABLE="value"\n`;
        }
        const dbPattern = /database|db\.|sqlite|postgres|mysql|mongodb/i;
        if (failed.some(f => dbPattern.test(f.diagnostics.error))) {
          errorMessage += `    â†’ Ensure database file/connection exists and path is correct\n`;
        }
        const authPattern = /auth|api key|token|credential/i;
        if (failed.some(f => authPattern.test(f.diagnostics.error))) {
          errorMessage += `    â†’ Verify API keys/tokens are set in environment variables\n`;
        }
      }

      errorMessage += `\nâ€¢ Resolver documentation:\n`;
      let hasDocs = false;
      resolverAttempts.forEach(attempt => {
        if (attempt.diagnostics?.documentationUrl) {
          errorMessage += `    â†’ ${attempt.name}: ${attempt.diagnostics.documentationUrl}\n`;
          hasDocs = true;
        }
      });
      if (!hasDocs) {
        errorMessage += `    â†’ Visit https://www.npmjs.com/search?q=%40o-lang     for resolver packages\n`;
      }
      errorMessage += `\nðŸ›‘ Workflow halted to prevent unsafe data propagation to LLMs.`;
      
      // âœ… ENHANCED: Log the failure with full context before throwing
      this._createAuditEntry('resolver_execution_failed', {
        step_label: stepLabel,
        branch_context: step._parentLabel ? `${step._parentLabel} (${step._branch})` : null,
        action: action,
        attempted_resolvers: resolverAttempts.map(a => a.name),
        severity: 'high'
      });

      throw new Error(errorMessage);
    };

    switch (stepType) {
      case 'calculate': {
        // âœ… Interpolate variables in the expression before evaluation
        let expr = step.expression || step.actionRaw;
        if (typeof expr === 'string' && expr.includes('{')) {
          expr = this._safeInterpolate(expr, this.context, 'calculate step');
        }
        const result = this.evaluateMath(expr);
        if (step.saveAs) this.context[step.saveAs] = result;
        break;
      }

      
    
            case 'action': {
        let action = this._safeInterpolate(step.actionRaw, this.context, 'action step');

        if (action.startsWith('Ask ')) action = 'Action ' + action.slice(4);
        else if (action.startsWith('Use ')) action = 'Action ' + action.slice(4);

        if (!action.startsWith('Action ')) {
          throw new Error(`[O-Lang SAFETY] Non-canonical action received: "${action}"\n  â†’ Expected format: Action <resolver> <args>`);
        }

        const mathCall = action.match(/^(add|subtract|multiply|divide|sum|avg|min|max|round|floor|ceil|abs)\((.*)\)$/i);
        if (mathCall) {
          const fn = mathCall[1].toLowerCase();
          const args = mathCall[2].split(',').map(s => {
            s = s.trim();
            return !isNaN(s) ? parseFloat(s) : this.getNested(this.context, s.replace(/^\{|\}$/g, ''));
          });
          if (this.mathFunctions[fn]) {
            if (step.saveAs) this.context[step.saveAs] = this.mathFunctions[fn](...args);
            break;
          }
        }

        const rawResult = await runResolvers(action);
        const unwrapped = this._unwrapResolverResult(rawResult);

        // âœ… DYNAMIC: Exhaustive check for any LLM provider
        const isLLMAction = /groq|openai|anthropic|claude|gpt|gemini|google|llama|meta|mistral|mixtral|cohere|huggingface|hugging-face|together|perplexity|fireworks|bedrock|azure|ollama|replicate|deepseek|qwen|falcon|phi|gemma|stablelm|yi|dbrx|command|llm/i.test(action);

        // âœ… DYNAMIC: Handles any resolver output format (string, {response}, {text}, {content}, etc.)
        const llmText = unwrapped?.response || unwrapped?.text || unwrapped?.content || unwrapped?.answer || (typeof unwrapped === 'string' ? unwrapped : null);

        if (isLLMAction && typeof llmText === 'string') {
          const safetyCheck = this._validateLLMOutput(llmText, action);
          if (!safetyCheck.passed) {
            throw new Error(
              `[O-Lang SAFETY] LLM hallucinated unauthorized capability:\n` +
              `  â†’ Detected: "${safetyCheck.detected}"\n` +
              `  â†’ Reason: ${safetyCheck.reason}\n` +
              `  â†’ Workflow allowlist: ${Array.from(this.allowedResolvers).join(', ')}\n` +
              `\nðŸ›‘ Halting to prevent deceptive user experience.`
            );
          }
        }

        // âœ… GOVERNANCE FIX: Prevent LLMs from overwriting ground-truth state
        if (step.saveAs) {
          const existingValue = this.context[step.saveAs];
          
          // 1. HARD BLOCK: Prevent overwriting locked ground-truth variables
          if (existingValue && existingValue.__locked === true) {
            throw new Error(
              `[O-Lang SAFETY] Attempted to overwrite locked ground-truth variable "${step.saveAs}".\n` +
              `  â†’ Ground truth can only be set by trusted resolvers, not LLMs.\n` +
              `  â†’ Use a new variable name (e.g., "llm_response") for LLM output.`
            );
          }

          // 2. SOFT ENFORCEMENT: Guide users to safe namespaces without breaking valid legacy workflows
          if (isLLMAction && !step.saveAs.startsWith('llm_') && !step.saveAs.startsWith('response') && !step.saveAs.startsWith('generated_')) {
            this.addWarning(
              `[O-Lang BEST PRACTICE] LLM steps should ideally save to 'llm_*', 'response', or 'generated_*' variables.\n` +
              `  â†’ You used: "${step.saveAs}". This is allowed, but using a distinct namespace prevents accidental ground-truth collisions.`
            );
          }

          // 3. Save the new value
          this.context[step.saveAs] = unwrapped;

          // 4. LOCK: If this step was NOT an LLM call, lock it as immutable ground truth
          if (!isLLMAction && typeof unwrapped === 'object' && unwrapped !== null) {
            Object.defineProperty(this.context[step.saveAs], '__locked', {
              value: true,
              writable: false,
              enumerable: false, // Hidden from JSON.stringify and iteration
              configurable: false
            });
          }
        }
        break;
      }


 case 'use': {
        const tool = this._safeInterpolate(step.tool, this.context, 'tool name');
        const rawResult = await runResolvers(`Use ${tool}`);
        const unwrapped = this._unwrapResolverResult(rawResult);
        
        if (step.saveAs) {
          const existingValue = this.context[step.saveAs];
          if (existingValue && existingValue.__locked === true) {
            throw new Error(
              `[O-Lang SAFETY] Attempted to overwrite locked ground-truth variable "${step.saveAs}".\n` +
              `  â†’ Ground truth can only be set by trusted resolvers, not tools/LLMs.`
            );
          }

          this.context[step.saveAs] = unwrapped;

          // Lock trusted tool outputs as ground truth
          if (typeof unwrapped === 'object' && unwrapped !== null) {
            Object.defineProperty(this.context[step.saveAs], '__locked', {
              value: true,
              writable: false,
              enumerable: false,
              configurable: false
            });
          }
        }
        break;
      }


 case 'ask': {
        const target = this._safeInterpolate(step.target, this.context, 'LLM prompt');
        if (/{[^}]+}/.test(target)) {
          throw new Error(`[O-Lang] Unresolved variables in prompt: "${target}"`);
        }
        const rawResult = await runResolvers(`Action ${target}`);
        const unwrapped = this._unwrapResolverResult(rawResult);

        // âœ… DYNAMIC: Comprehensive text extraction to ensure safety check NEVER bypasses
        const llmText = unwrapped?.response || unwrapped?.text || unwrapped?.content || unwrapped?.output || (typeof unwrapped === 'string' ? unwrapped : null);

        if (typeof llmText === 'string') {
          const safetyCheck = this._validateLLMOutput(llmText, target);
          if (!safetyCheck.passed) {
            throw new Error(
              `[O-Lang SAFETY] LLM hallucinated unauthorized capability:\n` +
              `  â†’ Detected: "${safetyCheck.detected}"\n` +
              `  â†’ Reason: ${safetyCheck.reason}\n` +
              `  â†’ Workflow allowlist: ${Array.from(this.allowedResolvers).join(', ')}\n` +
              `\nðŸ›‘ Halting to prevent deceptive user experience.`
            );
          }
        }

        // âœ… GOVERNANCE FIX: Apply ground-truth protection to 'ask' steps
        if (step.saveAs) {
          const existingValue = this.context[step.saveAs];
          
          if (existingValue && existingValue.__locked === true) {
            throw new Error(
              `[O-Lang SAFETY] Attempted to overwrite locked ground-truth variable "${step.saveAs}".\n` +
              `  â†’ Ground truth can only be set by trusted resolvers, not LLMs.`
            );
          }

          // SOFT ENFORCEMENT: Guide users to safe namespaces without breaking valid legacy workflows
          if (!step.saveAs.startsWith('llm_') && !step.saveAs.startsWith('response') && !step.saveAs.startsWith('generated_')) {
            this.addWarning(
              `[O-Lang BEST PRACTICE] LLM 'ask' steps should ideally save to 'llm_*', 'response', or 'generated_*' variables.\n` +
              `  â†’ You used: "${step.saveAs}". This is allowed, but using a distinct namespace prevents accidental ground-truth collisions.`
            );
          }

          this.context[step.saveAs] = unwrapped;
        }
        break;
      }
      
// âœ… NEW: Prompt (Human-in-the-Loop)
case 'prompt': {
  const promptSessionId = `prompt_${crypto.randomUUID()}`;

  console.log('[PROMPT DEBUG] redisClient:', this.redisClient ? 'âœ… SET' : 'âŒ NULL');

  const question = this._safeInterpolate(step.question, this.context, 'prompt question');

  // Extract authorization requirements from step
  const requiredRole     = step.requiredRole || step.role || null;
  const requiredStaffId  = step.requiredStaffId || step.staff || null;
  const governanceReason = step.reason || 'human_approval_required';

  // âœ… Interpolate {variables} in role and staffId fields
  const resolvedRole    = requiredRole    ? this._safeInterpolate(requiredRole,    this.context, 'prompt role')     : null;
  const resolvedStaffId = requiredStaffId ? this._safeInterpolate(requiredStaffId, this.context, 'prompt staff id') : null;

  const workflowState = {
    workflowName:     this.context.__workflow_key || this.context.workflow_name,
    currentStepIndex: this.currentStepIndex || 0,
    context:          { ...this.context },
    promptQuestion:   question,
    createdAt:        Date.now(),
    timeout:          step.timeout || 300000,
    requiredRole:     resolvedRole,
    requiredStaffId:  resolvedStaffId,
    governanceReason,
    policyApplied:    step.policy || null
  };

  console.log('[PROMPT DEBUG] workflowName:', workflowState.workflowName);
  console.log('[PROMPT DEBUG] currentStepIndex:', workflowState.currentStepIndex);
  console.log('[PROMPT DEBUG] timeout (ms):', workflowState.timeout);
  console.log('[PROMPT DEBUG] setex TTL (s):', Math.ceil(workflowState.timeout / 1000));
  console.log('[PROMPT DEBUG] key:', `workflow_state:${promptSessionId}`);
  console.log('[PROMPT DEBUG] resolvedRole:', resolvedRole);
  console.log('[PROMPT DEBUG] resolvedStaffId:', resolvedStaffId);

  if (this.redisClient) {
    try {
      const setResult = await this.redisClient.setex(
        `workflow_state:${promptSessionId}`,
        Math.ceil(workflowState.timeout / 1000),
        JSON.stringify(workflowState)
      );
      console.log('[PROMPT DEBUG] setex result:', setResult);

      const verify = await this.redisClient.get(`workflow_state:${promptSessionId}`);
      console.log('[PROMPT DEBUG] verify read back:', verify ? 'âœ… FOUND in Redis' : 'âŒ NOT FOUND after write');
    } catch (redisErr) {
      console.error('[PROMPT DEBUG] Redis error:', redisErr.message);
    }
  } else {
    console.error('[PROMPT DEBUG] âŒ redisClient is NULL â€” session will NOT be saved');
  }

  const saveKey = step.saveAs || 'prompt_session_id';
  this.context[saveKey] = promptSessionId;

  this._createAuditEntry('prompt_issued', {
    session_id:        promptSessionId,
    question:          question,
    timeout:           workflowState.timeout,
    required_role:     resolvedRole,
    required_staff_id: resolvedStaffId,
    governance_reason: governanceReason,
    severity:          'info'
  });

  const pauseError = new Error('WORKFLOW_PAUSED');
  pauseError.code             = 'PROMPT_REQUIRED';
  pauseError.sessionId        = promptSessionId;
  pauseError.question         = question;
  pauseError.requiredRole     = resolvedRole;
  pauseError.governanceReason = governanceReason;
  pauseError.stepIndex        = this.currentStepIndex || 0;
  throw pauseError;
  }      
  
  case 'evolve': {
        const { targetResolver, feedback } = step;
        if (this.verbose) {
          console.log(`ðŸ”„ Evolve step: ${targetResolver} with feedback: "${feedback}"`);
        }
        const evolutionResult = {
          resolver: targetResolver,
          feedback: feedback,
          status: 'evolution_requested',
          timestamp: new Date().toISOString(),
          workflow: this.context.workflow_name
        };
        if (process.env.OLANG_EVOLUTION_API_KEY) {
          evolutionResult.status = 'advanced_evolution_enabled';
          evolutionResult.message = 'Advanced evolution service would process this request';
        }
        if (step.saveAs) {
          this.context[step.saveAs] = evolutionResult;
        }
        break;
      }

     // âœ… NEW: Escalation (Timeout-Based Alerts)
case 'escalation': {
  const escalationId = `escalation_${crypto.randomUUID()}`;
  
  const escalationState = {
    id: escalationId,
    levels: step.levels,
    currentLevel: 0,
    acknowledged: false,
    startedAt: Date.now()
  };
  
  if (this.redisClient) {
    await this.redisClient.setex(
      `escalation_state:${escalationId}`,
      3600,
      JSON.stringify(escalationState)
    );
  }
  
  console.log(`[ESCALATION] Starting escalation with ${step.levels?.length || 0} levels`);
  
  for (let i = 0; i < step.levels.length; i++) {
    const level = step.levels[i];
    const delay = i === 0 ? 0 : (level.timeout || 0);
    
    setTimeout(async () => {
      try {
        if (this.redisClient) {
          const currentState = await this.redisClient.get(`escalation_state:${escalationId}`);
          if (currentState) {
            const state = JSON.parse(currentState);
            if (state.acknowledged) {
              console.log(`[ESCALATION] ${escalationId} acknowledged, skipping level ${i + 1}`);
              return;
            }
          }
        }
        
        console.log(`[ESCALATION] Executing level ${i + 1} for ${escalationId}`);
        
        if (!level.steps || level.steps.length === 0) {
          console.warn(`[ESCALATION] Level ${i + 1} has no steps!`);
          return;
        }
        
        for (const rawStep of level.steps) {
          // âœ… Parse raw step string into step object
          let parsedStep;
          
          if (typeof rawStep === 'string') {
            // Handle "Ask ..." steps
            if (rawStep.startsWith('Ask ')) {
              const actionRaw = rawStep;
              parsedStep = {
                type: 'action',
                actionRaw: actionRaw,
                saveAs: null
              };
            }
            // Handle "Save as ..." steps
            else if (rawStep.startsWith('Save as ')) {
              const saveAs = rawStep.replace('Save as ', '').trim();
              parsedStep = {
                type: 'calculate',
                expression: `context.__resolver_${level.steps.indexOf(rawStep) - 1}`,
                saveAs: saveAs
              };
            }
            else {
              console.warn(`[ESCALATION] Unknown step format: ${rawStep}`);
              continue;
            }
          } else {
            // Already a parsed step object
            parsedStep = rawStep;
          }
          
          console.log(`[ESCALATION] Executing parsed step:`, parsedStep);
          
          try {
            await this.executeStep(parsedStep, agentResolver);
            console.log(`[ESCALATION] Step completed successfully`);
          } catch (err) {
            console.error(`[ESCALATION] Level ${i + 1} step failed:`, err.message);
          }
        }
        
        if (this.redisClient) {
          const currentState = await this.redisClient.get(`escalation_state:${escalationId}`);
          if (currentState) {
            const state = JSON.parse(currentState);
            state.currentLevel = i + 1;
            await this.redisClient.setex(
              `escalation_state:${escalationId}`,
              3600,
              JSON.stringify(state)
            );
          }
        }
        
        this._createAuditEntry('escalation_level_executed', {
          escalation_id: escalationId,
          level: i + 1,
          severity: 'warning'
        });
      } catch (err) {
        console.error(`[ESCALATION] Error in level ${i + 1}:`, err.message);
      }
    }, delay);
  }
  
  this.context.escalation_id = escalationId;
  
  this._createAuditEntry('escalation_started', {
    escalation_id: escalationId,
    total_levels: step.levels.length,
    severity: 'info'
  });
  
  break;
}
          // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // IF / ELSE-IF / ELSE
      //
      // Governance Features:
      //   1. Exclusive Branching: Only one branch executes (if -> else-if -> else).
      //   2. Semantic Validation: Checks symbols in conditions before evaluation.
      //   3. Auditability: Logs which condition was evaluated and which branch fired.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

               case 'if': {
        const stepLabel = step.label || 'unnamed_if_block';
        
        console.log(`\nðŸŽ¯ [RUNTIME] â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`);
        console.log(`ðŸŽ¯ [RUNTIME] IF BLOCK START: ${stepLabel}`);
        console.log(`ðŸŽ¯ [RUNTIME] Condition: "${step.condition}"`);
        console.log(`ðŸŽ¯ [RUNTIME] Body steps: ${step.body?.length || 0}`);
        console.log(`ðŸŽ¯ [RUNTIME] Else-if branches: ${step.elseIf?.length || 0}`);
        console.log(`ðŸŽ¯ [RUNTIME] Else branch: ${step.elseBranch ? 'yes' : 'no'}`);
        console.log(`ðŸŽ¯ [RUNTIME] â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`);
        
        // 1. Validate all symbols referenced in the main condition
        const condSymbols = step.condition ? step.condition.match(/\{([^\}]+)\}/g) || [] : [];
        console.log(`ðŸ” [RUNTIME] Condition symbols: ${JSON.stringify(condSymbols)}`);
        
        let symbolsValid = true;
        
        for (const sym of condSymbols) {
          const key = sym.replace(/[{}]/g, '');
          console.log(`ðŸ” [RUNTIME] Validating symbol: "${key}" â†’ value: ${JSON.stringify(this.context[key])}`);
          if (!this._requireSemantic(key, 'if condition')) {
            symbolsValid = false;
            console.log(`âŒ [RUNTIME] Symbol "${key}" is INVALID`);
          } else {
            console.log(`âœ… [RUNTIME] Symbol "${key}" is valid`);
          }
        }

        if (!symbolsValid) {
          console.log(`âš ï¸  [RUNTIME] IF BLOCK SKIPPED - Invalid symbols in condition`);
          this._createAuditEntry('condition_skipped', {
            step_label: stepLabel,
            condition: step.condition,
            reason: 'One or more symbols missing in context',
            severity: 'warn'
          });
          break;
        }

        // 2. Evaluate main if condition
        const mainPassed = this.evaluateCondition(step.condition, this.context);
        console.log(`ðŸŽ¯ [RUNTIME] Main condition evaluated: ${mainPassed}`);

        this._createAuditEntry('condition_evaluated', {
          step_label: stepLabel,
          condition: step.condition,
          passed: mainPassed,
          branch: 'if',
          severity: 'info'
        });

        if (mainPassed) {
          console.log(`âœ… [RUNTIME] IF BRANCH MATCHED! Executing ${step.body?.length || 0} body steps...`);
          if (step.body && Array.isArray(step.body)) {
            for (let i = 0; i < step.body.length; i++) {
              const s = step.body[i];
              console.log(`\nâš™ï¸  [RUNTIME] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
              console.log(`âš™ï¸  [RUNTIME] Executing body step ${i+1}/${step.body.length}`);
              console.log(`âš™ï¸  [RUNTIME]   type: ${s.type}`);
              console.log(`âš™ï¸  [RUNTIME]   saveAs: ${s.saveAs || 'NONE'}`);
              console.log(`âš™ï¸  [RUNTIME]   actionRaw: ${(s.actionRaw || '').substring(0, 80)}`);
              console.log(`âš™ï¸  [RUNTIME]   expression: ${(s.expression || '').substring(0, 80)}`);
              
              s._parentLabel = stepLabel;
              s._branch = 'if';
              
              await this.executeStep(s, agentResolver);
              
              if (s.saveAs) {
                const savedValue = this.context[s.saveAs];
                console.log(`ðŸ’¾ [RUNTIME] After execution: context.${s.saveAs} = ${JSON.stringify(savedValue)}`);
                if (savedValue === undefined) {
                  console.log(`âŒâŒâŒ [RUNTIME] CRITICAL! saveAs="${s.saveAs}" but context.${s.saveAs} is UNDEFINED!`);
                } else if (typeof savedValue === 'object' && Object.keys(savedValue).length === 0) {
                  console.log(`âš ï¸  [RUNTIME] WARNING! saveAs="${s.saveAs}" but value is empty object {}`);
                } else {
                  console.log(`âœ…âœ…âœ… [RUNTIME] SUCCESS! Variable "${s.saveAs}" saved correctly`);
                }
              } else {
                console.log(`âš ï¸  [RUNTIME] Step has no saveAs - nothing will be saved to context`);
              }
            }
          } else {
            console.log(`âš ï¸  [RUNTIME] IF branch matched but step.body is empty or not an array!`);
          }
          console.log(`âœ… [RUNTIME] IF BLOCK COMPLETE`);
          break; // Exit after successful if
        }

        console.log(`âž¡ï¸  [RUNTIME] Main condition failed, checking else-if branches...`);
        
        // 3. else-if chain â€” stop at first match
        if (step.elseIf && Array.isArray(step.elseIf)) {
          let elseIfFired = false;
          for (let branchIdx = 0; branchIdx < step.elseIf.length; branchIdx++) {
            const branch = step.elseIf[branchIdx];
            console.log(`\nðŸ” [RUNTIME] Checking else-if branch ${branchIdx + 1}/${step.elseIf.length}`);
            console.log(`ðŸ” [RUNTIME] Else-if condition: "${branch.condition}"`);
            
            // Validate symbols for else-if branch
            const branchSymbols = branch.condition ? branch.condition.match(/\{([^\}]+)\}/g) || [] : [];
            let branchSymbolsValid = true;
            for (const sym of branchSymbols) {
              const key = sym.replace(/[{}]/g, '');
              if (!this._requireSemantic(key, 'else-if condition')) {
                branchSymbolsValid = false;
              }
            }

            if (!branchSymbolsValid) {
               console.log(`âš ï¸  [RUNTIME] Else-if ${branchIdx + 1} skipped - invalid symbols`);
               this._createAuditEntry('condition_skipped', {
                step_label: stepLabel,
                condition: branch.condition,
                reason: 'One or more symbols missing in context',
                severity: 'warn'
              });
              continue; // Skip this else-if, try next
            }

            const branchPassed = this.evaluateCondition(branch.condition, this.context);
            console.log(`ðŸ” [RUNTIME] Else-if ${branchIdx + 1} evaluated: ${branchPassed}`);

            this._createAuditEntry('condition_evaluated', {
              step_label: stepLabel,
              condition: branch.condition,
              passed: branchPassed,
              branch: 'else-if',
              severity: 'info'
            });

            if (branchPassed) {
              console.log(`âœ… [RUNTIME] ELSE-IF ${branchIdx + 1} MATCHED! Executing ${branch.body?.length || 0} steps...`);
              if (branch.body && Array.isArray(branch.body)) {
                for (let i = 0; i < branch.body.length; i++) {
                  const s = branch.body[i];
                  console.log(`\nâš™ï¸  [RUNTIME] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
                  console.log(`âš™ï¸  [RUNTIME] Executing else-if step ${i+1}/${branch.body.length}`);
                  console.log(`âš™ï¸  [RUNTIME]   type: ${s.type}`);
                  console.log(`âš™ï¸  [RUNTIME]   saveAs: ${s.saveAs || 'NONE'}`);
                  console.log(`âš™ï¸  [RUNTIME]   actionRaw: ${(s.actionRaw || '').substring(0, 80)}`);
                  
                  s._parentLabel = stepLabel;
                  s._branch = 'else-if';
                  await this.executeStep(s, agentResolver);
                  
                  if (s.saveAs) {
                    const savedValue = this.context[s.saveAs];
                    console.log(`ðŸ’¾ [RUNTIME] After execution: context.${s.saveAs} = ${JSON.stringify(savedValue)}`);
                  }
                }
              }
              elseIfFired = true;
              break;
            }
          }
          if (elseIfFired) {
            console.log(`âœ… [RUNTIME] ELSE-IF BLOCK COMPLETE`);
            break;
          }
        }

        console.log(`âž¡ï¸  [RUNTIME] No else-if matched, checking else branch...`);
        
        // 4. else fallback
        if (step.elseBranch && Array.isArray(step.elseBranch)) {
          console.log(`âœ… [RUNTIME] ELSE BRANCH EXECUTING (${step.elseBranch.length} steps)...`);
          this._createAuditEntry('condition_evaluated', {
            step_label: stepLabel,
            condition: 'else',
            passed: true,
            branch: 'else',
            severity: 'info'
          });
          for (let i = 0; i < step.elseBranch.length; i++) {
            const s = step.elseBranch[i];
            console.log(`\nâš™ï¸  [RUNTIME] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€`);
            console.log(`âš™ï¸  [RUNTIME] Executing else step ${i+1}/${step.elseBranch.length}`);
            console.log(`âš™ï¸  [RUNTIME]   type: ${s.type}`);
            console.log(`âš™ï¸  [RUNTIME]   saveAs: ${s.saveAs || 'NONE'}`);
            console.log(`âš™ï¸  [RUNTIME]   actionRaw: ${(s.actionRaw || '').substring(0, 80)}`);
            
            s._parentLabel = stepLabel;
            s._branch = 'else';
            await this.executeStep(s, agentResolver);
            
            if (s.saveAs) {
              const savedValue = this.context[s.saveAs];
              console.log(`ðŸ’¾ [RUNTIME] After execution: context.${s.saveAs} = ${JSON.stringify(savedValue)}`);
            }
          }
          console.log(`âœ… [RUNTIME] ELSE BLOCK COMPLETE`);
        } else {
          console.log(`âš ï¸  [RUNTIME] No else branch defined`);
        }

        console.log(`ðŸŽ¯ [RUNTIME] IF BLOCK END\n`);
        break;
      }

       // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // PARALLEL
      //
      // Bugs fixed:
      //   1. Shared this.context race condition â€” all branches wrote to the same
      //      object concurrently. Branch 2 restoring the snapshot overwrote whatever
      //      branch 1 had just saved, so result_a was lost by the time it was read.
      //      Fix: each branch gets its own context via Object.create(this), which
      //      prototype-links to the parent (sharing allowedResolvers, auditLog,
      //      events, verbose) but has its own context property that shadows the
      //      parent's. Branches never touch this.context directly.
      //
      //   2. Promise.all â†’ silent failure swallowing. A single rejection cancelled
      //      all siblings. Fix: buildStepPromise catches internally and returns a
      //      structured outcome, so Promise.all always resolves with the full set.
      //
      //   3. timed_out not always written. Fix: always written after settlement â€”
      //      true on timeout, false on clean completion.
      //
      //   4. Losing Promise.race branch kept mutating this.context after the
      //      workflow moved on. Fix: branches write to branchRuntime.context only;
      //      this.context is only touched during the final merge step.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      case 'parallel': {
        const { steps, timeout } = step;

        if (!steps || !Array.isArray(steps) || steps.length === 0) {
          this.addWarning('Parallel step contains no sub-steps. Skipping.');
          break;
        }

        // Snapshot context before any branch runs.
        // Every branch reads from this â€” not from each other.
        const contextSnapshot = { ...this.context };

        // Build one promise per sub-step.
        //
        // Each branch runs against a prototype-linked clone of the runtime.
        // Object.create(this) shares: allowedResolvers, auditLog, events,
        // verbose, resources, agentMap â€” everything a step needs to execute.
        // But branchRuntime.context is its own property that shadows this.context,
        // so concurrent writes never collide.
        //
        // Errors are caught here and returned as structured outcomes so that
        // Promise.all always resolves with the full result set â€” one failure
        // does not cancel sibling branches.
        const buildStepPromise = async (s, index) => {
          const branchRuntime = Object.create(this);
          branchRuntime.context = { ...contextSnapshot };

          try {
            await branchRuntime.executeStep(s, agentResolver);

            const saveKey = s.saveAs || null;
            const value   = saveKey ? branchRuntime.context[saveKey] : undefined;

            return {
              status:   'fulfilled',
              index,
              saveAs:   saveKey,
              value,
              stepType: s.type
            };
          } catch (error) {
            return {
              status:   'rejected',
              index,
              reason:   error.message || String(error),
              stepType: s.type
            };
          }
        };

        const runAllSteps = () =>
          Promise.all(steps.map((s, i) => buildStepPromise(s, i)));

        let settledResults;

        if (timeout !== undefined && timeout > 0) {
          // Race: all steps vs timeout sentinel.
          // runAllSteps never rejects (errors caught inside buildStepPromise),
          // so Promise.race resolves with either the results array or null.
          const timeoutPromise = new Promise(resolve =>
            setTimeout(() => resolve(null), timeout)
          );

          settledResults = await Promise.race([runAllSteps(), timeoutPromise]);

          if (settledResults === null) {
            // Timeout won. Restore snapshot + mark timed_out.
            // Do NOT merge partial results â€” we cannot know which branches
            // completed cleanly before the cutoff.
            this.context = { ...contextSnapshot, timed_out: true };

            this.emit('parallel_timeout', {
              duration:    timeout,
              steps_count: steps.length
            });

            if (this.verbose) {
              console.log(`â° Parallel execution timed out after ${timeout}ms`);
            }

            this._createAuditEntry('parallel_timeout', {
              timeout_ms:  timeout,
              steps_count: steps.length,
              severity:    'warn'
            });

            break;
          }

        } else {
          settledResults = await runAllSteps();
        }

        // Merge results back into this.context.
        // Start from the snapshot so pre-parallel state is the clean base,
        // then layer each branch's saveAs result on top.
        this.context = { ...contextSnapshot, timed_out: false };

        for (const outcome of settledResults) {
          if (outcome.status === 'fulfilled') {
            const { saveAs, value } = outcome;
            if (saveAs !== null && value !== undefined) {
              this.context[saveAs] = value;
            }
          } else {
            const { reason, index } = outcome;
            this.addWarning(`Parallel step [index ${index}] failed: ${reason}`);

            this.emit('parallel_step_failed', {
              index,
              reason,
              stepType: outcome.stepType
            });

            this._createAuditEntry('parallel_step_failed', {
              step_index: index,
              reason,
              severity:   'high'
            });
          }
        }

        break;
      }

           // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // ESCALATION
      //
      // Governance Features:
      //   1. Scope Safety: Fixes ReferenceError by declaring levelSteps in outer scope.
      //   2. Auditability: Logs level start, completion, timeout, and final outcome.
      //   3. Determinism: Ensures timed-out levels don't corrupt context.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      case 'escalation': {
        const { levels } = step;
        const { parseBlock } = require('../parser');

        let finalResult = null;
        let completedLevel = null;

        for (const level of levels) {
          // Fix: Declare levelSteps in outer block scope to avoid ReferenceError
          // in the timed-out branch.
          const levelSteps = parseBlock(level.steps);

          this._createAuditEntry('escalation_level_started', {
            level: level.levelNumber,
            timeout_ms: level.timeout,
            steps_count: levelSteps.length,
            severity: 'info'
          });

          if (level.timeout === 0) {
            // Immediate level â€” execute sequentially
            for (const levelStep of levelSteps) {
              await this.executeStep(levelStep, agentResolver);
            }

            // Check if result was saved
            if (levelSteps.length > 0) {
              const lastStep = levelSteps[levelSteps.length - 1];
              if (lastStep.saveAs && this.context[lastStep.saveAs] !== undefined) {
                finalResult = this.context[lastStep.saveAs];
                completedLevel = level.levelNumber;

                this._createAuditEntry('escalation_level_completed', {
                  level: level.levelNumber,
                  timed_out: false,
                  severity: 'info'
                });
                break; // Escalation complete
              }
            }

          } else {
            // Timed level
            const timeoutPromise = new Promise(resolve =>
              setTimeout(() => resolve({ timedOut: true }), level.timeout)
            );

            const levelPromise = (async () => {
              for (const levelStep of levelSteps) {
                await this.executeStep(levelStep, agentResolver);
              }
              return { timedOut: false };
            })();

            const result = await Promise.race([timeoutPromise, levelPromise]);

            if (!result.timedOut) {
              // Level completed within time
              if (levelSteps.length > 0) {
                const lastStep = levelSteps[levelSteps.length - 1];
                if (lastStep.saveAs && this.context[lastStep.saveAs] !== undefined) {
                  finalResult = this.context[lastStep.saveAs];
                  completedLevel = level.levelNumber;

                  this._createAuditEntry('escalation_level_completed', {
                    level: level.levelNumber,
                    timed_out: false,
                    severity: 'info'
                  });
                  break; // Escalation complete
                }
              }
            } else {
              // Level timed out
              this._createAuditEntry('escalation_level_timeout', {
                level: level.levelNumber,
                timeout_ms: level.timeout,
                severity: 'warn'
              });

              if (this.verbose) {
                console.log(
                  `â° Escalation level ${level.levelNumber} timed out ` +
                  `after ${level.timeout}ms â€” trying next level`
                );
              }
              // Continue to next level
            }
          }
        }

        // Final context state
        this.context.escalation_completed = finalResult !== null;
        this.context.timed_out = finalResult === null;
        if (completedLevel !== null) {
          this.context.escalation_level = completedLevel;
        }

        this._createAuditEntry('escalation_outcome', {
          completed: finalResult !== null,
          completed_at_level: completedLevel,
          timed_out: finalResult === null,
          severity: finalResult !== null ? 'info' : 'warn'
        });

        break;
      }

case 'connect': {
  if (!step.resource || !step.endpoint) {
    this.addWarning('Connect step missing "resource" or "endpoint". Skipping.');
    break;
  }

  // Only validate URL format for url-type connects.
  // Resolver-type endpoints are package names (@o-lang/kyc-resolver)
  // and are not valid URLs â€” do not run them through new URL().
if (!step.targetType || step.targetType === 'url') {
  try {
    new URL(step.endpoint);
  } catch (e) {
    this.addWarning(`Connect: Invalid endpoint URL for "${step.resource}": ${step.endpoint}`);
    break;
  }
}

  this.resources[step.resource] = step.endpoint;

  this._createAuditEntry('resource_connected', {
    resource:         step.resource,
    target_type:      step.targetType || 'url',
    endpoint_masked:  step.endpoint.replace(/\/\/[^@]+@/, '//***@'),
    severity:         'info'
  });

  if (this.verbose) {
    console.log(`ðŸ”— Connected "${step.resource}" â†’ ${step.endpoint}`);
  }
  break;
}
       // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // AGENT_USE
      // Maps a logical agent name (e.g., "support_bot") to a registered resource.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case 'agent_use': {
        if (!step.logicalName || !step.resource) {
          this.addWarning('Agent_use step missing "logicalName" or "resource". Skipping.');
          break;
        }

        // Optional: Validate that the resource was previously connected
        if (!this.resources[step.resource]) {
          this.addWarning(`Agent_use: Resource "${step.resource}" has not been connected yet.`);
        }

        this.agentMap[step.logicalName] = step.resource;

        // âœ… AUDIT LOG: Agent Mapping
        this._createAuditEntry('agent_mapped', {
          logical_name: step.logicalName,
          resource: step.resource,
          severity: 'info'
        });

        if (this.verbose) {
          console.log(`ðŸ¤– Mapped agent "${step.logicalName}" to resource "${step.resource}"`);
        }
        break;
      }
           // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // DEBRIEF
      //
      // Governance Features:
      //   1. Semantic Validation: Ensures all {symbols} exist before emitting.
      //   2. Interpolation: Agents receive resolved values, not raw templates.
      //   3. Auditability: Every debrief is logged for compliance tracing.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      case 'debrief': {
        const messageTemplate = step.message;
        
        // 1. Validate all referenced symbols exist in context
        if (messageTemplate && messageTemplate.includes('{')) {
          const symbolMatches = messageTemplate.match(/\{([^\}]+)\}/g) || [];
          
          // Check every symbol. _requireSemantic will emit 'semantic_violation' 
          // if a symbol is missing, but we also need to stop execution here.
          const allPresent = symbolMatches.every(sym => {
            const key = sym.replace(/[{}]/g, '');
            return this._requireSemantic(key, 'debrief');
          });

          if (!allPresent) {
            if (this.verbose) {
              console.log(`â­ï¸  Debrief skipped â€” one or more symbols missing in context`);
            }
            // Break early. Do not emit incomplete data.
            break;
          }
        }

        // 2. Interpolate â€” agent receives the real value, not the template
        const interpolatedMessage = this._safeInterpolate(
          messageTemplate,
          this.context,
          'debrief message'
        );

        // 3. Audit trail â€” every agent message must be traceable
        this._createAuditEntry('debrief_emitted', {
          agent: step.agent,
          message_length: interpolatedMessage ? interpolatedMessage.length : 0,
          symbols_resolved: (messageTemplate.match(/\{([^\}]+)\}/g) || []).length,
          severity: 'info'
        });

        this.emit('debrief', {
          agent: step.agent,
          message: interpolatedMessage
        });

        if (this.verbose) {
          console.log(`ðŸ“¨ Debrief â†’ agent "${step.agent}": ${interpolatedMessage}`);
        }
        break;
      }


      case 'prompt': {
        if (this.verbose) {
          console.log(`â“ Prompt: ${step.question}`);
        }
        break;
      }

       // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // EMIT
      //
      // Governance Features:
      //   1. Semantic Validation: Stops at first missing symbol to reduce noise.
      //   2. Auditability: External events are logged with payload metadata.
      //   3. Consistency: Uses same interpolation logic as debrief.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      case 'emit': {
        const payloadTemplate = step.payload;
        
        // Extract unique symbols from the payload template
        const symbols = [...new Set(payloadTemplate.match(/\{([^\}]+)\}/g) || [])];

        // Validate all symbols, stop at first missing one
        const allPresent = symbols.every(sym => {
          const key = sym.replace(/[{}]/g, '');
          return this._requireSemantic(key, 'emit');
        });

        if (!allPresent) {
          if (this.verbose) {
            console.log(`â­ï¸  Skipped emit due to missing semantic symbols`);
          }
          break;
        }

        // Interpolate the payload
        const payload = this._safeInterpolate(
          payloadTemplate,
          this.context,
          'emit payload'
        );

        // âœ… AUDIT LOG: External event emission
        this._createAuditEntry('event_emitted', {
          event: step.event,
          payload_length: payload ? payload.length : 0,
          symbols_resolved: symbols.length,
          severity: 'info'
        });

        this.emit(step.event, {
          payload,
          workflow: this.context.workflow_name || 'unknown',
          timestamp: new Date().toISOString()
        });

        if (this.verbose) {
          console.log(`ðŸ“¤ Emit event "${step.event}" with payload: ${payload}`);
        }
        break;
      }

            // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // PERSIST
      //
      // Governance Features:
      //   1. Data Integrity: Prevents silent corruption of objects into "[object Object]".
      //   2. Auditability: Logs path, format, and variable name (without raw values).
      //   3. Safety: Validates semantic existence before attempting I/O.
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

          case 'persist': {
        const fs = require('fs');
        const path = require('path');

        // 1. Semantic Guard: Ensure the variable exists in context
        if (!step.variable || !this._requireSemantic(step.variable, 'persist')) {
          if (this.verbose) {
            console.log(`â­ï¸  Skipped persist for undefined "${step.variable}"`);
          }
          break;
        }

        const sourceValue = this.context[step.variable];
        
        // âœ… NEW: Interpolate variables in target path (e.g., {patient_id}_{session_id})
        let targetPath = step.target;
        if (targetPath.includes('{')) {
          targetPath = targetPath.replace(/\{([^\}]+)\}/g, (_, varPath) => {
            const value = this.getNested(this.context, varPath.trim());
            return value !== undefined ? String(value) : 'unknown';
          });
        }
        
        // Resolve absolute path to prevent directory traversal attacks
        const outputPath = path.resolve(process.cwd(), targetPath);
        const outputDir = path.dirname(outputPath);

        // Ensure directory exists
        if (!fs.existsSync(outputDir)) {
          try {
            fs.mkdirSync(outputDir, { recursive: true });
          } catch (e) {
            this.addWarning(`persist: failed to create directory "${outputDir}": ${e.message}`);
            break;
          }
        }

        // 2. Serialize with safe fallback for object â†’ non-JSON targets
        let content;
        const isObject = sourceValue !== null && typeof sourceValue === 'object';
        let formatUsed = 'string';

        if (targetPath.endsWith('.json')) {
          content = JSON.stringify(sourceValue, null, 2);
          formatUsed = 'json';
        } else if (isObject) {
          this.addWarning(
            `persist: "${step.variable}" is an object but target "${targetPath}" is not .json. ` +
            `Writing as JSON to prevent data loss.`
          );
          content = JSON.stringify(sourceValue, null, 2);
          formatUsed = 'json-fallback';
        } else {
          content = String(sourceValue);
          formatUsed = 'string';
        }

        // 3. Write with error surfacing
        try {
          fs.writeFileSync(outputPath, content, 'utf8');
        } catch (e) {
          this.addWarning(`persist: failed to write "${step.variable}" to "${targetPath}": ${e.message}`);
          this._createAuditEntry('persist_failed', {
            variable: step.variable,
            target: targetPath,
            error: e.message,
            severity: 'high'
          });
          break;
        }

        // 4. Audit log
        this._createAuditEntry('context_persisted', {
          variable: step.variable,
          target: targetPath,
          format: formatUsed,
          value_type: isObject ? 'object' : typeof sourceValue,
          byte_length: Buffer.byteLength(content, 'utf8'),
          severity: 'info'
        });

        if (this.verbose) {
          console.log(`ðŸ’¾ Persisted "${step.variable}" to ${targetPath} (${formatUsed})`);
        }
        break;
      }

      case 'persist-db': {
        if (!this.dbClient) {
          this.addWarning(`DB persistence skipped (no DB configured). Set OLANG_DB_TYPE env var.`);
          break;
        }
        if (!this._requireSemantic(step.variable, 'persist-db')) {
          if (this.verbose) {
            console.log(`â­ï¸ Skipped DB persist for undefined "${step.variable}"`);
          }
          break;
        }
        const sourceValue = this.context[step.variable];
        try {
          switch (this.dbClient.type) {
            case 'postgres':
            case 'mysql':
              if (this.dbClient.type === 'postgres') {
                await this.dbClient.client.query(
                  `INSERT INTO "${step.collection}" (workflow_name, data, created_at) VALUES ($1, $2, NOW())`,
                  [this.context.workflow_name || 'unknown', JSON.stringify(sourceValue)]
                );
              } else {
                await this.dbClient.client.execute(
                  `INSERT INTO ?? (workflow_name, data, created_at) VALUES (?, ?, NOW())`,
                  [step.collection, this.context.workflow_name || 'unknown', JSON.stringify(sourceValue)]
                );
              }
              break;
            case 'mongodb':
              const db = this.dbClient.client.db(process.env.DB_NAME || 'olang');
              await db.collection(step.collection).insertOne({
                workflow_name: this.context.workflow_name || 'unknown',
                sourceValue,
                created_at: new Date()
              });
              break;
            case 'sqlite':
              const stmt = this.dbClient.client.prepare(
                `INSERT INTO ${step.collection} (workflow_name, data, created_at) VALUES (?, ?, ?)`
              );
              stmt.run(
                this.context.workflow_name || 'unknown',
                JSON.stringify(sourceValue),
                new Date().toISOString()
              );
              break;
          }
          if (this.verbose) {
            console.log(`ðŸ—„ï¸  Persisted "${step.variable}" to DB collection ${step.collection}`);
          }
        } catch (e) {
          this.addWarning(`DB persist failed for "${step.variable}": ${e.message}`);
        }
        break;
      }
    }

    if (this.verbose) {
      console.log(`\n[Step: ${step.type} | saveAs: ${step.saveAs || 'N/A'}]`);
      console.log(JSON.stringify(this.context, null, 2));
    }
  }
  

async executeWorkflow(workflow, inputs, agentResolver) {
  if (workflow.type !== 'workflow') {
    throw new Error(`Unknown workflow type: ${workflow.type}`);
  }

  this.context = {
    ...inputs,
    workflow_name: workflow.name
  };

  // âœ… NEW: Validate Inputs BEFORE any step runs
  // In redact mode: PII tokens are replaced in place, execution continues.
  // In block mode (default): throws on any PII or financial intent match.
  this._validateInputs(inputs);

  // âœ… AUDIT LOG: Workflow start (ENHANCED with governance metadata)
  const governanceHash = this._generateGovernanceProfileHash(workflow);

  this._createAuditEntry('workflow_started', {
    workflow_id: `${workflow.name}@${workflow.version || 'unversioned'}`, // âœ… Workflow ID
    workflow_name: workflow.name,
    workflow_version: workflow.version || null,
    kernel_version: KERNEL_VERSION,  // âœ… Kernel Version
    runtime_version: KERNEL_VERSION, // âœ… Runtime Version (same as kernel for now)
    governance_profile_hash: governanceHash,  // âœ… Governance Profile Hash
    inputs_count: Object.keys(inputs).length,
    steps_count: workflow.steps.length,
    allowed_resolvers: workflow.allowedResolvers || [],
    pii_mode: this.piiMode, // âœ… NEW v1.3.0 â€” surfaced in audit
    constraints: {
      max_generations: workflow.maxGenerations,
      strict_inputs: process.env.OLANG_STRICT_INPUTS === 'true'
    }
  });

  // Optional strict mode: enforce resolver-originated inputs
  if (process.env.OLANG_STRICT_INPUTS === 'true') {
    if (!inputs.__resolver_origin) {
      throw new Error(
        '[O-Lang SAFETY] Inputs must originate from a certified resolver. ' +
        'Use @o-lang/input-validator to validate external data.'
      );
    }
  }

  const currentGeneration = inputs.__generation || 1;
  if (workflow.maxGenerations !== null && currentGeneration > workflow.maxGenerations) {
    throw new Error(`Workflow generation ${currentGeneration} exceeds Constraint: max_generations = ${workflow.maxGenerations}`);
  }

  this.workflowSteps = workflow.steps;
  this.allowedResolvers = new Set(workflow.allowedResolvers || []);
  const mathPattern =
    /^(Add|Subtract|Multiply|Divide|Sum|Avg|Min|Max|Round|Floor|Ceil|Abs)\b/i;
  for (const step of workflow.steps) {
    if (step.type === 'calculate' || (step.actionRaw && mathPattern.test(step.actionRaw))) {
      this.allowedResolvers.add('builtInMathResolver');
    }
  }

  // âœ… FIX: Track step index during execution
  for (let i = 0; i < workflow.steps.length; i++) {
    this.currentStepIndex = i; // âœ… Track current step index
    const step = workflow.steps[i];
    await this.executeStep(step, agentResolver);
  }

  // âœ… AUDIT LOG: Workflow completion (ENHANCED)
  this._createAuditEntry('workflow_completed', {
    workflow_id: `${workflow.name}@${workflow.version || 'unversioned'}`,
    workflow_name: workflow.name,
    kernel_version: KERNEL_VERSION,
    runtime_version: KERNEL_VERSION,
    governance_profile_hash: governanceHash,
    return_values: workflow.returnValues,
    total_steps: workflow.steps.length,
    execution_summary: {
      warnings: this.__warnings.length,
      disallowed_attempts: this.disallowedAttempts.length
    }
  });

  this.printDisallowedSummary();
  if (this.__warnings.length) {
    console.log(`\n[O-Lang] âš ï¸ Parser/Runtime Warnings (${this.__warnings.length}):`);
    this.__warnings.slice(0, 5).forEach((w, i) => {
      console.log(`${i + 1}. ${w.timestamp} | ${w.message}`);
    });
  }

  // âœ… SEMANTIC VALIDATION: For return values
  const result = {};
  for (const key of workflow.returnValues) {
    if (this._requireSemantic(key, 'return')) {
      result[key] = this.context[key];
    }
  }

  // âœ… NEW: DUAL-HASH FORENSIC ATTACHMENT
  // 1. Compute Data Hash (from __locked ground-truth variables)
  const lockedData = {};
  for (const [key, value] of Object.entries(this.context)) {
    if (value && typeof value === 'object' && value.__locked === true) {
      const { __locked, ...cleanValue } = value; // Strip the hidden property
      lockedData[key] = cleanValue;
    }
  }
  const dataHash = this._hash(this._stableSerialize(lockedData));

  // 2. Compute Narrative Hash (from the final composed response string)
  const narrativeText = result.response || this.context.response || '';
  const narrativeHash = this._hash(narrativeText);

  // 3. Attach to result so the controller can persist it
  result.__audit = {
    executionHash: this.previousHash, 
    merkleRoot: this._calculateMerkleRoot(),
    stepsExecuted: workflow.steps.length,
    dataHash,
    narrativeHash,
    deterministic: true // Initial run is deterministic by definition
  };
  // âœ… FINAL STEP: Deanonymize the result before it leaves the Kernel boundary
  return this._deanonymizeResponse(result, this.context);
}
}

async function execute(workflow, inputs, agentResolver, verbose = false) {
  const rt = new RuntimeAPI({ verbose });
  return rt.executeWorkflow(workflow, inputs, agentResolver);
}

module.exports = { execute, RuntimeAPI };







