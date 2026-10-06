// src/core.js
import { runWorkflow } from "./olang.js";
import { store } from "./store.js";
import { calculateBilling, createInvoice, processPayment } from "./billing.js";

export async function createExecution(contractId, inputs) {
  const contract = store.getContract(contractId);
  if (!contract) throw new Error(`Contract ${contractId} not found`);

  const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const workflowName = contractId;

  try {
    const executionOptions = { contract };

    // ✅ DYNAMIC CAPABILITY RESOLUTION
    const workflow = WORKFLOWS[workflowName];
    const requiredCapabilities = workflow.requiredCapabilities || [];

    if (requiredCapabilities.length > 0) {
      console.log(`[GRaaS Core] 🔍 Resolving ${requiredCapabilities.length} capabilities...`);

      const resolutionResponse = await fetch(
        `${process.env.GRAAS_GATEWAY_URL}/v1/capabilities/resolve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.GRAAS_API_KEY
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
      console.log(`[GRaaS Core] ✅ All capabilities resolved`);

      // ✅ BUILD THE CHAIN with failover support
      executionOptions._chain = [];
      
      for (const cap of requiredCapabilities) {
        const agents = resolution[cap];
        
        // Add all agents for this capability (for failover)
        for (const agent of agents) {
          executionOptions._chain.push({
            resolverName: cap,
            manifest: {
              agentId: agent.agentId,
              capability: cap,
              protocol: "http",
              endpoint: agent.endpoint,
              trustedPubkey: agent.pubkey,
              inputMap: {
                claimId: "claimId",
                claim_data: "claim_data"
              },
              match: "exact",
              returnField: "result",
              timeout_ms: 30000,
              retries: 2
            }
          });
        }
      }

      // ✅ GRaaS session config
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

  // ✅ BILLING LOGIC
  if (execution.billable) {
    const billing = await calculateBilling(execution, contract);
    execution.billing = billing;
    
    const certificate = createResultCertificate(execution, contract);
    execution.certificateId = certificate.certificateId;
    store.saveExecution(execution);
    store.saveCertificate(certificate);
    
    // Record metering
    store.incrementMeter(contract.providerId, execution.contractId, billing.totalAmount);
    
    // Queue invoice if provider has billing enabled
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
  // Queue this billing item for the next monthly invoice
  const invoiceQueue = store.getInvoiceQueue(providerId) || [];
  invoiceQueue.push({
    ...billing,
    queuedAt: new Date().toISOString()
  });
  store.saveInvoiceQueue(providerId, invoiceQueue);
}