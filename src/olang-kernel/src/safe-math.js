// src/safe-math.js — Zero-dependency arithmetic evaluator
// Implements: +, -, *, /, parentheses, decimals, order of operations

class SafeMath {
  /**
   * Check if expression is arithmetic
   */
  static isArithmetic(expr) {
    if (typeof expr !== 'string') return false;
    const trimmed = expr.trim();
    if (trimmed.length === 0) return false;
    
    // Must contain at least one operator
    if (!/[+\-*/]/.test(trimmed)) return false;
    
    // Must only contain allowed characters (digits, operators, parentheses, decimals, whitespace)
    return /^[\d\s+\-*/().]+$/.test(trimmed);
  }

  /**
   * Evaluate arithmetic expression
   */
  static evaluate(expr) {
    try {
      const tokens = this.tokenize(expr);
      const ctx = { pos: 0 };
      const result = this.parseExpression(tokens, ctx);
      
      if (result.error) {
        return { success: false, error: result.error };
      }
      
      if (ctx.pos < tokens.length) {
        return { success: false, error: 'Unexpected tokens after expression' };
      }
      
      if (!isFinite(result.value)) {
        return { success: false, error: 'Result is not finite' };
      }
      
      return { success: true, result: result.value };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Tokenize expression into numbers and operators
   */
  static tokenize(expr) {
    const tokens = [];
    let i = 0;
    
    while (i < expr.length) {
      const char = expr[i];
      
      // Skip whitespace
      if (/\s/.test(char)) {
        i++;
        continue;
      }
      
      // Number (including decimals)
      if (/[0-9.]/.test(char)) {
        let num = '';
        let decimalCount = 0;
        
        while (i < expr.length && /[0-9.]/.test(expr[i])) {
          if (expr[i] === '.') decimalCount++;
          if (decimalCount > 1) throw new Error('Invalid number: multiple decimal points');
          num += expr[i++];
        }
        
        const value = parseFloat(num);
        if (isNaN(value)) throw new Error(`Invalid number: ${num}`);
        tokens.push({ type: 'number', value });
        continue;
      }
      
      // Operators and parentheses
      if ('+-*/()'.includes(char)) {
        tokens.push({ type: 'operator', value: char });
        i++;
        continue;
      }
      
      throw new Error(`Unexpected character: ${char}`);
    }
    
    return tokens;
  }

  /**
   * Parse expression (handles + and -)
   */
  static parseExpression(tokens, ctx) {
    let left = this.parseTerm(tokens, ctx);
    if (left.error) return left;
    
    while (ctx.pos < tokens.length) {
      const op = tokens[ctx.pos];
      if (!op || (op.value !== '+' && op.value !== '-')) break;
      
      ctx.pos++;
      const right = this.parseTerm(tokens, ctx);
      if (right.error) return right;
      
      left = {
        value: op.value === '+' ? left.value + right.value : left.value - right.value
      };
    }
    
    return left;
  }

  /**
   * Parse term (handles * and /)
   */
  static parseTerm(tokens, ctx) {
    let left = this.parseFactor(tokens, ctx);
    if (left.error) return left;
    
    while (ctx.pos < tokens.length) {
      const op = tokens[ctx.pos];
      if (!op || (op.value !== '*' && op.value !== '/')) break;
      
      ctx.pos++;
      const right = this.parseFactor(tokens, ctx);
      if (right.error) return right;
      
      if (op.value === '/' && right.value === 0) {
        return { error: 'Division by zero' };
      }
      
      left = {
        value: op.value === '*' ? left.value * right.value : left.value / right.value
      };
    }
    
    return left;
  }

  /**
   * Parse factor (handles numbers and parentheses)
   */
  static parseFactor(tokens, ctx) {
    const token = tokens[ctx.pos];
    
    if (!token) {
      return { error: 'Unexpected end of expression' };
    }
    
    // Number
    if (token.type === 'number') {
      ctx.pos++;
      return { value: token.value };
    }
    
    // Parenthesized expression
    if (token.value === '(') {
      ctx.pos++;
      const result = this.parseExpression(tokens, ctx);
      
      if (tokens[ctx.pos]?.value !== ')') {
        return { error: 'Missing closing parenthesis' };
      }
      
      ctx.pos++;
      return result;
    }
    
    // Unary minus
    if (token.value === '-') {
      ctx.pos++;
      const factor = this.parseFactor(tokens, ctx);
      if (factor.error) return factor;
      return { value: -factor.value };
    }
    
    return { error: `Unexpected token: ${token.value}` };
  }
}

module.exports = SafeMath;