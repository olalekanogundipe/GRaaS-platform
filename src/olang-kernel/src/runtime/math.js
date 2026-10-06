const SafeMath = require('../safe-math');

function getNested(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((o, k) =>
    o && o[k] !== undefined ? o[k] : undefined, obj);
}

const mathFunctions = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
  equals: (a, b) => a === b,
  greater: (a, b) => a > b,
  less: (a, b) => a < b,
  sum: arr => arr.reduce((a, v) => a + v, 0),
  avg: arr => arr.reduce((a, v) => a + v, 0) / arr.length,
  min: arr => Math.min(...arr),
  max: arr => Math.max(...arr),
  increment: a => a + 1,
  decrement: a => a - 1,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs
};

function evaluateMath(expr, context, addWarning) {
  if (typeof expr !== 'string') return expr;
  
  const trimmed = expr.trim();
  
  // ── PASS 1: Handle quoted string literals ────────────────────────────────
  // Quoted strings are always treated as string templates, never arithmetic
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    let inner = trimmed.slice(1, -1);
    inner = inner.replace(/\{([^\}]+)\}/g, (_, path) => {
      const value = getNested(context, path.trim());
      return value !== undefined ? String(value) : `{${path}}`;
    });
    return inner;
  }
  
  // ── PASS 2: Check if raw expression is arithmetic (no variables) ─────────
  if (SafeMath.isArithmetic(trimmed)) {
    const result = SafeMath.evaluate(trimmed);
    if (result.success) {
      const rounded = Math.round(result.result * 10000) / 10000;
      return rounded;
    } else {
      addWarning?.(`[CALCULATE] Math failed: ${result.error}. Falling back.`);
    }
  }
  
  // ── PASS 3: Interpolate variables ────────────────────────────────────────
  let interpolated = trimmed.replace(/\{([^\}]+)\}/g, (_, p) => {
    const v = getNested(context, p.trim());
    if (v === undefined) return '0';
    if (typeof v === 'string') {
      // If the string is numeric, return as number (no quotes)
      if (!isNaN(v) && v.trim() !== '') return v;
      // Otherwise return as quoted string for Function constructor
      return `"${v.replace(/"/g, '\\"')}"`;
    }
    return v;
  });
  
  // ── PASS 4: Check if interpolated result is arithmetic ───────────────────
  if (SafeMath.isArithmetic(interpolated)) {
    const result = SafeMath.evaluate(interpolated);
    if (result.success) {
      const rounded = Math.round(result.result * 10000) / 10000;
      return rounded;
    } else {
      addWarning?.(`[CALCULATE] Post-interpolation math failed: ${result.error}`);
    }
  }
  
  // ── PASS 5: Check if it contains mathFunctions (add, subtract, etc.) ─────
  const hasMathFunction = Object.keys(mathFunctions).some(fn => 
    new RegExp(`\\b${fn}\\s*\\(`, 'i').test(interpolated)
  );
  
  if (hasMathFunction) {
    try {
      const fn = new Function(
        ...Object.keys(mathFunctions),
        `return ${interpolated};`
      );
      return fn(...Object.values(mathFunctions));
    } catch (e) {
      addWarning?.(`Failed to evaluate math "${interpolated}": ${e.message}`);
      return 0;
    }
  }
  
  // ── PASS 6: Not arithmetic, not a function call — return as string ───────
  // Strip quotes if the interpolation produced a quoted string
  if (interpolated.startsWith('"') && interpolated.endsWith('"')) {
    return interpolated.slice(1, -1).replace(/\\"/g, '"');
  }
  
  return interpolated;
}

function evaluateCondition(cond, ctx) {
  cond = cond.trim();
  const eq = cond.match(/^\{(.+)\}\s+equals\s+"(.*)"$/);
  if (eq) return getNested(ctx, eq[1]) == eq[2];
  const gt = cond.match(/^\{(.+)\}\s+greater than\s+(\d+\.?\d*)$/);
  if (gt) return +getNested(ctx, gt[1]) > +gt[2];
  const lt = cond.match(/^\{(.+)\}\s+less than\s+(\d+\.?\d*)$/);
  if (lt) return +getNested(ctx, lt[1]) < +lt[2];
  return Boolean(getNested(ctx, cond.replace(/[{}]/g, '')));
}

module.exports = {
  getNested,
  mathFunctions,
  evaluateMath,
  evaluateCondition
};