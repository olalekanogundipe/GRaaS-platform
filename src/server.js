import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import { runWorkflow } from "./olang.js";
import { store } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

console.log("[SERVER] 1. Starting server.js...");
console.log("[SERVER] 2. Express imported");
console.log("[SERVER] 3. Store imported");
console.log("[SERVER] 4. Olang imported");

const app = express();
app.use(express.json());
console.log("[SERVER] 5. Express app configured");

app.post("/seed/contract", async (req, res) => {
  try {
    const { contractId, providerId, name, requiredCapabilities, pricePerResult } = req.body;
    await store.saveContract({
      id: contractId, providerId, name, requiredCapabilities, pricePerResult, commissionRate: 0.2
    });
    res.json({ success: true, message: `Contract ${contractId} seeded` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/executions", async (req, res) => {
  try {
    const { contractId, inputs } = req.body;
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    await store.saveExecution(executionId, { contractId, inputs, status: "PENDING" });
    const result = await runWorkflow(contractId, inputs, {});
    await store.saveExecutionResult(executionId, result);
    res.json({ executionId, status: "COMPLETED" });
  } catch (error) {
    console.error("[SERVER] Execution failed:", error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post("/executions/:id/verify", async (req, res) => {
  try {
    const { id } = req.params;
    const execution = await store.getExecution(id);
    if (!execution) return res.status(404).json({ error: "Execution not found" });
    
    //  THIS IS THE DEBUG LINE: It will print the exact structure to the console!
    console.log(" DEBUG VERIFY - Full execution.result:", JSON.stringify(execution.result, null, 2));
    
    const result = execution.result || {};
    const finalStatus = 
      result?.result?.final_result?.status || 
      result?.result?.status ||
      result?.final_result?.status || 
      result?.status || 
      "UNKNOWN";
      
    const billable = finalStatus === "COMPLETED" || finalStatus === "VERIFIED";
    
    res.json({ executionId: id, status: finalStatus, billable: billable, result: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/invoke", async (req, res) => {
  try {
    const { workflow, inputs, executionId, action, context } = req.body;
    if (workflow) {
      const result = await runWorkflow(workflow, inputs || {}, { executionId });
      return res.json({ success: true, result: result.result || result });
    }
    res.json({ success: true, result: { status: "invoked" } });
  } catch (error) {
    console.error("[GRaaS] Kernel /invoke failed:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[SERVER] 6. Attempting to listen on port ${PORT}...`);
  console.log(` GRaaS Platform MVP v0.2 running on port ${PORT}`);
});
