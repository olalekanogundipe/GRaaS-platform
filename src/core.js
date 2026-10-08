import { runWorkflow, getWorkflow } from "./olang.js";
import { store } from "./store.js";
import { calculateBilling } from "./billing.js";

//  CONTRACT MANAGEMENT 
export async function createContract(contractData) {
  const {
    contractId, providerId, name, requiredCapabilities,
    permittedActions, prohibitedActions, pricePerResult,
    commissionRate, agentId, billingEnabled
  } = contractData;

  const existing = store.getContract(contractId);
  if (existing) {
    console.log(`[GRaaS Core]  Contract '${contractId}' exists. Updating...`);
  }

  let provider = store.getProvider(providerId);
  if (!provider) {
    console.log(`[GRaaS Core] Creating default provider: ${providerId}`);
    provider = {
      providerId,
      name: providerId,
      stripeCustomerId: null,
      createdAt: new Date().toISOString()
    };
    store.saveProvider(provider);
  }

  const contract = {
    contractId,
    providerId,
    name,
    requiredCapabilities: requiredCapabilities || [],
    permittedActions: permittedActions || [],
    prohibitedActions: prohibitedActions || [],
    pricePerResult,
    commissionRate: commissionRate || 0.20,
    agentId,
    billingEnabled: billingEnabled !== false,
    status: 'ACTIVE',
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  store.saveContract(contract);
  console.log(`[GRaaS Core]  Contract saved: ${contractId}`);
  console.log(`[GRaaS Core]    Capabilities: ${contract.requiredCapabilities.join(', ')}`);
  console.log(`[GRaaS Core]    Price: $${(pricePerResult / 100).toFixed(2)} | Commission: ${(contract.commissionRate * 100).toFixed(0)}%`);
  return contract;
}

//  EXECUTION 
export async function createExecution(contractId, inputs) {
  const contract = store.getContract(contractId);
  if (!contract) throw new Error(`Contract ${contractId} not found`);

  const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const workflowName = contractId;

  try {
    const executionOptions = { contract };
    const workflow = getWorkflow(workflowName);
    if (!workflow) throw new Error(`Workflow ${workflowName} not found`);

    const requiredCapabilities = contract.requiredCapabilities || [];

    if (requiredCapabilities.length > 0) {
      console.log(`[GRaaS Core]  Resolving ${requiredCapabilities.length} capabilities...`);

      //  CRITICAL IPv4 FIX: Hardcoded fallback to bypass Windows localhost IPv6 bug
      const gatewayUrl = process.env.GRAAS_GATEWAY_URL || "http://127.0.0.1:3000";
      
      const resolutionResponse = await fetch(
        `${gatewayUrl}/v1/capabilities/resolve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.GRAAS_API_KEY || 'dev-key'
          },
          body: JSON.stringify({
            capabilities: requiredCapabilities,
            contractId
          })
        }
      );

      if (!resolutionResponse.ok) {
        const err = await resolutionResponse.json();
        throw new Error(`Governance Violation: ${err.detail || err.error}`);
      }

      const { resolution } = await resolutionResponse.json();
      console.log(`[GRaaS Core]  All capabilities resolved`);

      executionOptions._chain = [];
      for (const cap of requiredCapabilities) {
        const agents = resolution[cap];
        for (const agent of agents) {
          // The kernel records its own steps (read_claim, submit_claim, ...) through the db
          // resolver. Never delegate a capability back to the kernel itself.
          if (agent.agentId === "olang-kernel") continue;
          executionOptions._chain.push({
            resolverName: cap,
            agentId: agent.agentId,
            delegateTo: agent.agentId,
            to: agent.agentId,
            targetAgent: agent.agentId,
            endpoint: agent.endpoint,
            trustedPubkey: agent.pubkey,
            capability: cap,
            manifest: {
              agentId: agent.agentId,
              capability: cap,
              protocol: "http",
              endpoint: agent.endpoint,
              trustedPubkey: agent.pubkey,
              // Paths resolve against the workflow context; claim_data is saved by the read_claim step.
              inputMap: cap === "fraud_check"
                ? { claimId: "claimId", applicant: "claim_data.applicant", amount: "claim_data.amount" }
                : { claimId: "claimId" },
              returnField: "result",
              timeout_ms: 30000,
              retries: 2
            }
          });
        }
      }
      
      executionOptions.graas = {
        contractId: contract.contractId,
        agentId: "olang-kernel",
        apiKey: process.env.GRAAS_API_KEY || 'dev-key'
      };
    }

    const kernelResult = await runWorkflow(workflowName, inputs, executionOptions);

    if (!kernelResult.evidence || !kernelResult.evidence.graas) {
      throw new Error("Governance Violation: Execution lacks GRaaS gateway evidence.");
    }

    const execution = {
      executionId,
      contractId,
      providerId: contract.providerId,
      inputs,
      workflowName,
      olangEvidence: kernelResult.evidence,
      businessResult: kernelResult.result,
      status: "EXECUTED",
      createdAt: new Date().toISOString()
    };

    store.saveExecution(execution);
    return execution;

  } catch (error) {
    const execution = {
      executionId,
      contractId,
      providerId: contract.providerId,
      inputs,
      workflowName,
      status: "GOVERNANCE_BLOCKED",
      error: error.message,
      createdAt: new Date().toISOString()
    };
    store.saveExecution(execution);
    throw error;
  }
}

//  VERIFICATION & BILLING 
export async function verifyExecution(executionId) {
  const execution = store.getExecution(executionId);
  if (!execution) throw new Error(`Execution ${executionId} not found`);
  if (execution.status === "VERIFIED" || execution.status === "HELD_FOR_REVIEW") return execution;

  const contract = store.getContract(execution.contractId);
  const checks = [];
  let passed = true;

  const br = execution.businessResult || {};
  const resultData = br.submission_result || br.result?.submission_result || br.response || br;
  const isCompleted = resultData?.status === "SUCCESS" || resultData?.status === "COMPLETED";
  
  if (!isCompleted) {
    passed = false;
    checks.push({ check: "business_logic_success", passed: false });
  } else {
    checks.push({ check: "business_logic_success", passed: true });
  }

  const graas = execution.olangEvidence?.graas;
  if (graas && graas.certificate) {
    const certStatus = graas.certificate.status;
    if (certStatus === "COMPLETED" || certStatus === "VERIFIED" || certStatus === "HELD_FOR_REVIEW") {
      checks.push({ check: "graas_governance_trace", passed: true });
    } else {
      passed = false;
      checks.push({ check: "graas_governance_trace", passed: false, reason: `Invalid cert status: ${certStatus}` });
    }
  } else {
    passed = false;
    checks.push({ check: "graas_governance_trace", passed: false, reason: "Missing GRaaS evidence" });
  }

  const verification = { passed, checks, verifiedAt: new Date().toISOString() };
  
  if (graas?.certificate?.status === "HELD_FOR_REVIEW") {
    execution.status = "HELD_FOR_REVIEW";
    execution.billable = false;
  } else if (passed) {
    execution.status = "VERIFIED";
    execution.billable = true;
  } else {
    execution.status = "FAILED_VERIFICATION";
    execution.billable = false;
  }

  execution.verification = verification;
  store.saveExecution(execution);

  if (execution.billable) {
    const billing = await calculateBilling(execution, contract);
    execution.billing = billing;
    
    const certificate = createResultCertificate(execution, contract);
    execution.certificateId = certificate.certificateId;
    store.saveExecution(execution);
    store.saveCertificate(certificate);
    
    store.incrementMeter(contract.providerId, execution.contractId, billing.totalAmount);
    
    if (contract.billingEnabled) {
      await queueInvoiceItem(contract.providerId, billing);
    }
  }

  return execution;
}

function createResultCertificate(execution, contract) {
  const graasChainRoot = execution.olangEvidence?.graas?.certificate?.chainRoot;
  const primaryHash = execution.olangEvidence?.executionHash || graasChainRoot || "unknown";

  return {
    certificateId: `cert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    executionId: execution.executionId,
    contractId: execution.contractId,
    providerId: contract.providerId,
    status: "CERTIFIED",
    resultHash: primaryHash,
    chainRoot: graasChainRoot || execution.olangEvidence?.chainRoot || "local-merkle",
    createdAt: new Date().toISOString()
  };
}

async function queueInvoiceItem(providerId, billing) {
  const invoiceQueue = store.getInvoiceQueue(providerId) || [];
  invoiceQueue.push({
    ...billing,
    queuedAt: new Date().toISOString()
  });
  store.saveInvoiceQueue(providerId, invoiceQueue);
}