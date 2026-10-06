// src/billing.js
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Calculate billing for an execution
 * Three-layer pricing: Provider price - Agent cost - Platform commission
 */
export async function calculateBilling(execution, contract) {
  const providerPrice = contract.pricePerResult || 500; // cents
  const platformCommissionRate = contract.commissionRate || 0.20;
  
  // Calculate agent costs from the execution evidence
  const agentCosts = await calculateAgentCosts(execution);
  const totalAgentCost = agentCosts.reduce((sum, cost) => sum + cost.amount, 0);
  
  // Calculate platform commission
  const platformCommission = Math.round(providerPrice * platformCommissionRate);
  
  // Calculate provider net revenue
  const providerNetRevenue = providerPrice - totalAgentCost - platformCommission;
  
  return {
    providerPrice,
    agentCosts,
    totalAgentCost,
    platformCommission,
    providerNetRevenue,
    currency: 'USD',
    calculatedAt: new Date().toISOString()
  };
}

/**
 * Calculate costs for each agent used in the execution
 */
async function calculateAgentCosts(execution) {
  const costs = [];
  
  // Extract agent usage from GRaaS evidence
  const graasEvidence = execution.olangEvidence?.graas;
  if (!graasEvidence?.certificate?.steps) return costs;
  
  for (const step of graasEvidence.certificate.steps) {
    if (step.agentId && step.capability) {
      // Query agent's pricing from Gateway
      const agentPricing = await getAgentPricing(step.agentId, step.capability);
      
      costs.push({
        agentId: step.agentId,
        capability: step.capability,
        amount: agentPricing.unitPrice || 0,
        currency: agentPricing.currency || 'USD',
        timestamp: step.timestamp
      });
    }
  }
  
  return costs;
}

/**
 * Get agent pricing from Gateway registry
 */
async function getAgentPricing(agentId, capability) {
  try {
    const response = await fetch(
      `${process.env.GRAAS_GATEWAY_URL}/v1/agents/${agentId}`,
      {
        headers: { 'x-api-key': process.env.GRAAS_API_KEY }
      }
    );
    
    if (!response.ok) return { unitPrice: 0, currency: 'USD' };
    
    const agent = await response.json();
    return agent.pricing?.[capability] || { unitPrice: 0, currency: 'USD' };
  } catch (error) {
    console.error(`[Billing] Failed to get pricing for ${agentId}:`, error.message);
    return { unitPrice: 0, currency: 'USD' };
  }
}

/**
 * Generate monthly invoice for a provider
 */
export async function generateMonthlyInvoice(providerId, month, year) {
  const provider = store.getProvider(providerId);
  if (!provider) throw new Error(`Provider ${providerId} not found`);
  
  const invoiceQueue = store.getInvoiceQueue(providerId) || [];
  const monthItems = invoiceQueue.filter(item => {
    const itemDate = new Date(item.queuedAt);
    return itemDate.getMonth() === month && itemDate.getFullYear() === year;
  });
  
  if (monthItems.length === 0) {
    return { status: 'no_items', message: 'No billable items for this period' };
  }
  
  const totalAmount = monthItems.reduce((sum, item) => sum + item.providerNetRevenue, 0);
  const platformFees = monthItems.reduce((sum, item) => sum + item.platformCommission, 0);
  
  const invoice = {
    invoiceId: `INV-${providerId}-${year}${String(month + 1).padStart(2, '0')}`,
    providerId,
    providerName: provider.name,
    period: { month, year },
    items: monthItems,
    totalAmount,
    platformFees,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  
  store.saveInvoice(invoice);
  
  // Clear the queue for this period
  const remainingItems = invoiceQueue.filter(item => !monthItems.includes(item));
  store.saveInvoiceQueue(providerId, remainingItems);
  
  return invoice;
}

/**
 * Process payment via Stripe
 */
export async function processPayment(invoice) {
  if (!stripe) {
    console.warn('[Billing] Stripe not configured, skipping payment processing');
    return { status: 'skipped', reason: 'Stripe not configured' };
  }
  
  const provider = store.getProvider(invoice.providerId);
  if (!provider.stripeCustomerId) {
    throw new Error(`Provider ${invoice.providerId} has no Stripe customer ID`);
  }
  
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: invoice.totalAmount,
      currency: 'usd',
      customer: provider.stripeCustomerId,
      metadata: {
        invoiceId: invoice.invoiceId,
        providerId: invoice.providerId
      }
    });
    
    // Update invoice status
    invoice.status = 'paid';
    invoice.paymentIntentId = paymentIntent.id;
    invoice.paidAt = new Date().toISOString();
    store.saveInvoice(invoice);
    
    // Distribute platform fees
    await distributePlatformFees(invoice);
    
    return { status: 'success', paymentIntentId: paymentIntent.id };
  } catch (error) {
    invoice.status = 'payment_failed';
    invoice.paymentError = error.message;
    store.saveInvoice(invoice);
    throw error;
  }
}

/**
 * Distribute platform fees to agent payouts
 */
async function distributePlatformFees(invoice) {
  if (!stripe) return;
  
  for (const item of invoice.items) {
    for (const agentCost of item.agentCosts) {
      // Pay agent via Stripe Connect
      try {
        await stripe.transfers.create({
          amount: agentCost.amount,
          currency: 'usd',
          destination: agentCost.agentId, // Stripe Connect account ID
          transfer_group: invoice.invoiceId
        });
      } catch (error) {
        console.error(`[Billing] Failed to pay agent ${agentCost.agentId}:`, error.message);
      }
    }
  }
}