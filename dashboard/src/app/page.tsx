// dashboard/src/app/page.tsx
"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import {
  Send, Shield, CheckCircle2, Loader2, Terminal, Search,
  Heart, ChevronLeft, Plus, Sparkles, Play, X, Activity, Lock, DollarSign, Receipt, Globe
} from "lucide-react";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GRAAS_GATEWAY_URL ?? "http://localhost:3000";
const API_KEY = process.env.NEXT_PUBLIC_GRAAS_API_KEY ?? "graas_c8eb26d038e1f1cfdf93eb2bbbf444ca3eadb61c4a6cae59";

type Billing = {
  status: "paid" | "refunded" | string;
  budget?: number;
  payout?: number;
  platformFee?: number;
  refunded?: number;
};

type Message = {
  role: "user" | "agent" | "system";
  content: string;
  steps?: string[];
  billing?: Billing;
};

type Kind = "agent";

type Item = {
  id: string;
  kind: Kind;
  name: string;
  emoji: string;
  description: string;
  tags: string[];
  capability: string;
  updated: string;
  runs: string;
  likes: number;
  status: "Running" | "Sleeping" | "Pending Approval";
  isGlobal?: boolean;
  homePlatform?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EXAMPLES = [
  "Check claim CLM-999 for fraud, amount $15,000, applicant John Doe.",
  "Investigate CLM-123, $15k, John Doe.",
  "Review claim CLM-450 for duplicate submissions.",
];

/* ───────────────────────── Small components ───────────────────────── */

function ItemRow({ item, onOpen }: { item: Item; onOpen: (i: Item) => void }) {
  return (
    <button
      onClick={() => onOpen(item)}
      className="w-full text-left rounded-xl border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition px-4 py-3 flex items-start gap-3"
    >
      <div className="w-10 h-10 shrink-0 rounded-lg bg-gradient-to-br from-yellow-100 to-orange-100 flex items-center justify-center text-xl">
        {item.emoji}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm truncate">{item.name}</span>
          {item.isGlobal && (
            <span className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 border bg-blue-50 text-blue-700 border-blue-200 flex items-center gap-1">
              <Globe className="w-2.5 h-2.5" /> Hosted on {item.homePlatform}
            </span>
          )}
          <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${
            item.status === "Running" ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-50 text-gray-500 border-gray-200"
          }`}>
            {item.status}
          </span>
        </div>
        <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">{item.description}</p>
        <div className="flex items-center gap-2 text-[11px] text-gray-500 mt-1">
          <span className="bg-gray-100 rounded px-1.5 py-0.5 font-medium text-gray-600">Agent</span>
          <span>{item.updated}</span>
          <span>•</span>
          <span>{item.runs} runs</span>
          <span>•</span>
          <span className="flex items-center gap-0.5">
            <Heart className="w-3 h-3" />
            {item.likes} rep
          </span>
        </div>
      </div>
    </button>
  );
}

/* ───────────────────────── Page ───────────────────────── */

export default function Dashboard() {
  // Navigation / Search
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [feedTab, setFeedTab] = useState<"local" | "global">("local");
  const [selected, setSelected] = useState<Item | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Backend data
  const [localAgents, setLocalAgents] = useState<Item[]>([]);
  const [globalAgents, setGlobalAgents] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  // Workspace chat
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Fetch Local Agents
  useEffect(() => {
    const fetchLocal = async () => {
      try {
        const url = `${GATEWAY_URL}/v1/agents/leaderboard?limit=50`;
        const res = await fetch(url);
        const data = await res.json();
        const mapped: Item[] = (data.leaderboard || []).map((a: any) => ({
          id: a.agentId,
          kind: "agent" as Kind,
          name: a.agentId,
          emoji: a.agentId.includes("fraud") ? "🛡️" : a.agentId.includes("research") ? "🔍" : a.agentId.includes("claim") ? "📋" : "🤖",
          description: `Autonomous agent. Capabilities: ${(a.capabilities || ["general"]).join(", ")}.`,
          tags: a.capabilities || ["general"],
          capability: (a.capabilities && a.capabilities.length > 0) ? a.capabilities[0] : "general",
          updated: a.lastSeen ? "Active" : "Recently",
          runs: (a.totalExecutions || 0).toString(),
          likes: a.reputation || 0,
          status: a.status === "active" ? "Running" : "Pending Approval",
          isGlobal: false
        }));
        setLocalAgents(mapped);
      } catch (err) {
        console.error("❌ Failed to fetch local agents:", err);
      }
    };
    fetchLocal();
  }, []);

  // Fetch Global Agents
  useEffect(() => {
    const fetchGlobal = async () => {
      try {
        const res = await fetch(`${GATEWAY_URL}/v1/agents/global?limit=50`);
        const data = await res.json();
        
        // 🛡️ DOUBLE-CHECK FILTER: Ensure infrastructure accounts never reach the UI
        const mapped: Item[] = (data.agents || [])
          .filter((a: any) => a.agentId !== 'olang-kernel' && a.agentId !== 'graas-platform')
          .map((a: any) => ({
            id: a.agentId,
            kind: "agent" as Kind,
            name: a.agentId,
            emoji: a.agentId.includes("fraud") ? "🛡️" : a.agentId.includes("research") ? "🔍" : a.agentId.includes("claim") ? "📋" : "🤖",
            description: `Global agent. Capabilities: ${(a.capabilities || ["general"]).join(", ")}.`,
            tags: a.capabilities || ["general"],
            capability: (a.capabilities && a.capabilities.length > 0) ? a.capabilities[0] : "general",
            updated: a.lastSeen ? "Active" : "Recently",
            runs: (a.totalExecutions || 0).toString(),
            likes: a.reputation || 0,
            status: "Running",
            isGlobal: true,
            homePlatform: a.homePlatform
          }));
        setGlobalAgents(mapped);
      } catch (err) {
        console.error("❌ Failed to fetch global agents:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchGlobal();
  }, []);

  // "/" focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        searchRef.current?.blur();
        if (selected) setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, liveSteps]);

  const currentFeed = feedTab === "local" ? localAgents : globalAgents;
  
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return currentFeed.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.tags.some((t) => t.toLowerCase().includes(q))
    );
  }, [currentFeed, query]);

  const openItem = (item: Item) => {
    setSelected(item);
    setQuery("");
    setSearchFocused(false);
    setInput("");
    setLiveSteps([]);
    setMessages([
      {
        role: "agent",
        content: `👋 Hello! I am **${item.name}**.${item.isGlobal ? ` I am hosted on the **${item.homePlatform}** network.` : ""}\n\nMy primary capability is: **${item.capability}**.\n\nPlease provide the details for the task you'd like me to execute.`,
      },
    ]);
  };

  const runRequest = async (text: string) => {
    const userMessage = text.trim();
    if (!userMessage || isProcessing || !selected) return;

    setInput("");
    setIsProcessing(true);
    setLiveSteps([]);
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);

    const collected: string[] = [];
    const addStep = (step: string) => {
      collected.push(step);
      setLiveSteps([...collected]);
    };
    const capability = selected.capability ?? "general";

    try {
      addStep("📥 Received user request. Parsing intent...");
      await sleep(500);
      if (selected.isGlobal) {
        addStep(`🌐 Routing to global agent on ${selected.homePlatform}...`);
      } else {
        addStep(`🔍 Preparing to execute capability '${capability}'...`);
      }
      await sleep(600);
      addStep(`🤝 Delegating task (Budget: 5 CR)...`);
      await sleep(500);
      addStep("🔒 Locking 5 CR in escrow...");

      const res = await fetch(`${GATEWAY_URL}/v1/delegate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          fromAgent: "research-agent", 
          toCapability: capability,
          targetAgentId: selected.isGlobal ? selected.id : undefined, // 🌐 Pass target ID for global agents
          payload: { claimId: "CLM-AUTO", applicant: "User Request", amount: 15000, details: userMessage },
          executionId: `exec-${Date.now()}`,
          delegationDepth: 0,
          budget: 5.0,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delegation failed");

      await sleep(400);
      addStep("✅ Task completed by agent.");
      await sleep(400);
      addStep(`🛡️ Hallucination Validation: ${data.hallucinationValidation.verdict} (Score: ${data.hallucinationValidation.hallucinationScore}/100)`);

      if (data.billing?.status === "paid") {
        addStep(`💰 Payment released: ${data.billing.payout} CR to agent, ${data.billing.platformFee} CR Platform Fee.`);
      } else {
        addStep(`💰 Escrow refunded: ${data.billing?.refunded} CR (Task failed validation).`);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: data.result?.message || "Analysis complete. See execution log and billing details below.",
          steps: [...collected],
          billing: data.billing,
        },
      ]);
    } catch (error: any) {
      setMessages((prev) => [...prev, { role: "system", content: `Failed to process request: ${error.message}` }]);
    } finally {
      setLiveSteps([]);
      setIsProcessing(false);
    }
  };

  /* ───────── Navbar (shared) ───────── */
  const suggestions = results.slice(0, 6);

  const navbar = (
    <nav className="shrink-0 z-30 bg-white border-b border-gray-200">
      <div className="px-4 h-14 flex items-center gap-4">
        <button onClick={() => { setSelected(null); setQuery(""); }} className="flex items-center gap-2 shrink-0">
          <div className="w-8 h-8 rounded-full bg-[#FFD21E] flex items-center justify-center">
            <Shield className="w-4 h-4 text-gray-900" />
          </div>
          <span className="font-bold text-lg tracking-tight hidden sm:block">GRaaS</span>
        </button>

        <div className="relative flex-1 max-w-xl">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
            placeholder="Search agents by name or capability"
            className="w-full pl-9 pr-10 py-2 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD21E] focus:border-[#FFD21E] placeholder:text-gray-400"
          />
          {query ? (
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
              <X className="w-4 h-4" />
            </button>
          ) : (
            <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-gray-400 border border-gray-200 rounded px-1.5">/</kbd>
          )}

          {searchFocused && query.trim() && (
            <div className="absolute left-0 right-0 top-full mt-2 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden z-40">
              {suggestions.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-500">No matches for “{query}”</div>
              ) : (
                suggestions.map((s) => (
                  <button key={s.id} onMouseDown={(e) => e.preventDefault()} onClick={() => openItem(s)} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-left">
                    <span className="text-lg">{s.emoji}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{s.name}</div>
                      <div className="text-xs text-gray-500">Agent</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <button className="hidden sm:flex items-center gap-1.5 text-sm font-medium border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50">
            <Plus className="w-4 h-4" /> Register Agent
          </button>
        </div>
      </div>
    </nav>
  );

  /* ───────── Workspace view (full screen chat) ───────── */
  if (selected) {
    return (
      <div className="h-screen flex flex-col bg-white text-gray-900 font-sans antialiased">
        {navbar}
        <header className="shrink-0 border-b border-gray-200 bg-gradient-to-b from-gray-50 to-white px-4 pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => setSelected(null)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <div className="flex items-center gap-2 text-lg">
              <span>{selected.emoji}</span>
              <span className="font-bold">{selected.name}</span>
            </div>
            {selected.isGlobal && (
              <span className="flex items-center gap-1 text-xs font-medium border border-blue-200 rounded-md px-2 py-1 text-blue-700 bg-blue-50">
                <Globe className="w-3 h-3" /> Global: {selected.homePlatform}
              </span>
            )}
            <span className="flex items-center gap-1 text-xs font-medium border border-gray-200 rounded-md px-2 py-1 text-gray-600 bg-white">
              <Heart className="w-3 h-3" /> {selected.likes} rep
            </span>
            <span className="flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 bg-green-50 text-green-700 border border-green-200">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              {selected.status}
            </span>
          </div>
          <div className="flex gap-1 mt-3 -mb-px text-sm font-medium">
            {[{ icon: Play, label: "App", active: true }, { icon: Terminal, label: "Logs" }, { icon: Receipt, label: "Billing" }].map(({ icon: Icon, label, active }) => (
              <button key={label} className={`flex items-center gap-2 px-4 py-2 border-b-2 ${active ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_300px]">
          <section className="flex flex-col min-h-0">
            <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-4 md:px-10 py-6 space-y-5 bg-gray-50/50">
              <div className="max-w-3xl mx-auto space-y-5">
                {messages.map((msg, idx) => (
                  <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[90%] rounded-2xl px-4 py-3 ${msg.role === "user" ? "bg-gray-900 text-white rounded-br-md" : msg.role === "system" ? "bg-red-50 text-red-700 border border-red-200 rounded-bl-md" : "bg-white text-gray-800 border border-gray-200 rounded-bl-md shadow-sm"}`}>
                      <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                      {msg.steps && msg.steps.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-gray-100 space-y-2">
                          <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                            <Terminal className="w-3.5 h-3.5" /> Execution log
                          </div>
                          {msg.steps.map((step, sIdx) => (
                            <div key={sIdx} className="flex items-start gap-2 text-xs font-mono text-gray-600 bg-gray-50 px-2.5 py-2 rounded-lg border border-gray-100">
                              <CheckCircle2 className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" /> <span>{step}</span>
                            </div>
                          ))}
                          {msg.billing && (
                            <div className="mt-3 p-3 bg-[#FFF9DB] border border-[#FFD21E]/60 rounded-lg">
                              <p className="text-[11px] font-semibold text-yellow-800 uppercase tracking-wider mb-2">Billing receipt</p>
                              <div className="grid grid-cols-2 gap-1.5 text-xs">
                                <div className="text-gray-600">Total budget</div>
                                <div className="text-right font-mono font-semibold">{msg.billing.budget} CR</div>
                                <div className="text-gray-600">Agent payout</div>
                                <div className="text-right font-mono font-semibold text-green-600">+{msg.billing.payout} CR</div>
                                <div className="text-gray-600">Platform fee (10%)</div>
                                <div className="text-right font-mono font-semibold text-yellow-700">+{Number(msg.billing.platformFee ?? 0).toFixed(2)} CR</div>
                                <div className="text-gray-600">Status</div>
                                <div className={`text-right font-mono font-semibold capitalize ${msg.billing.status === "paid" ? "text-green-600" : "text-red-600"}`}>{msg.billing.status}</div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isProcessing && liveSteps.length > 0 && (
                  <div className="flex justify-start">
                    <div className="w-full max-w-[90%] bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
                      <div className="flex items-center gap-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[#FFD21E]" /> Live execution
                      </div>
                      <div className="space-y-2">
                        {liveSteps.map((step, sIdx) => {
                          const isLast = sIdx === liveSteps.length - 1;
                          return (
                            <div key={sIdx} className="flex items-start gap-2 text-xs font-mono text-gray-600">
                              {isLast ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[#FFD21E] mt-0.5 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />}
                              <span>{step}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="shrink-0 border-t border-gray-200 bg-white p-4">
              <div className="max-w-3xl mx-auto">
                {messages.length === 1 && !isProcessing && (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {EXAMPLES.map((ex) => (
                      <button key={ex} onClick={() => runRequest(ex)} className="text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-full px-3 py-1.5 text-left">
                        {ex}
                      </button>
                    ))}
                  </div>
                )}
                <form onSubmit={(e) => { e.preventDefault(); runRequest(input); }} className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Describe the task to execute…"
                    disabled={isProcessing}
                    className="flex-1 px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#FFD21E] focus:border-[#FFD21E] placeholder:text-gray-400 disabled:bg-gray-50"
                  />
                  <button type="submit" disabled={isProcessing || !input.trim()} className="px-5 py-2.5 bg-gray-900 hover:bg-black disabled:bg-gray-200 disabled:text-gray-400 text-white text-sm font-semibold rounded-lg flex items-center gap-2">
                    {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Run
                  </button>
                </form>
              </div>
            </div>
          </section>

          <aside className="hidden lg:block border-l border-gray-200 bg-white p-4 space-y-4 overflow-y-auto">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">About</h3>
              <p className="text-sm text-gray-600 leading-relaxed">{selected.description}</p>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Status</h3>
              <div className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-gray-600"><Activity className="w-4 h-4" /> Gateway</span>
                  <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">Online</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-gray-600"><DollarSign className="w-4 h-4" /> Escrow</span>
                  <span className="text-xs font-medium text-yellow-800 bg-[#FFF9DB] border border-[#FFD21E]/60 rounded-full px-2 py-0.5">Active</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-gray-600"><Lock className="w-4 h-4" /> Verification</span>
                  <span className="text-xs font-medium text-gray-700 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5">Cryptographic</span>
                </div>
              </div>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Capabilities</h3>
              <div className="flex flex-wrap gap-1.5">
                {selected.tags.map((t) => (
                  <span key={t} className="text-xs font-medium text-gray-700 bg-gray-100 rounded-md px-2 py-1">{t}</span>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  /* ───────── Home view (full screen, 3 columns) ───────── */
  const searching = query.trim().length > 0;

  return (
    <div className="h-screen flex flex-col bg-white text-gray-900 font-sans antialiased">
      {navbar}
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[240px_1fr] xl:grid-cols-[260px_1fr_340px] bg-gray-50/40">
        {/* Left sidebar */}
        <aside className="hidden md:block border-r border-gray-200 bg-white p-5 overflow-y-auto">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-300 to-pink-400" />
            <div>
              <div className="text-xs text-gray-500">👋 Welcome to GRaaS!</div>
              <div className="font-bold">User Workspace</div>
            </div>
          </div>
          <ul className="text-sm space-y-1 mb-6">
            {["Profile", "Executions", "Settings", "Billing"].map((l) => (
              <li key={l} className="px-2 py-1.5 rounded-md text-gray-700 hover:bg-gray-100 cursor-pointer">{l}</li>
            ))}
          </ul>
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Resources</h3>
            <ul className="text-sm space-y-1">
              {["Getting Started", "Documentation", "Agent SDK"].map((l) => (
                <li key={l} className="px-2 py-1.5 rounded-md text-gray-700 hover:bg-gray-100 cursor-pointer">{l}</li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Center */}
        <main className="overflow-y-auto">
          <div className="max-w-3xl mx-auto p-5 space-y-5">
            {searching ? (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold">{results.length} result{results.length === 1 ? "" : "s"} for “{query}”</h2>
                  <button onClick={() => setQuery("")} className="text-sm text-gray-500 hover:text-gray-900">Clear search</button>
                </div>
                {results.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">No agents match your search.</div>
                ) : (
                  <div className="space-y-2.5">{results.map((r) => (<ItemRow key={r.id} item={r} onOpen={openItem} />))}</div>
                )}
              </>
            ) : (
              <>
                <div className="flex gap-1 border-b border-gray-200 text-sm font-medium overflow-x-auto">
                  <button onClick={() => setFeedTab("local")} className={`px-4 py-2.5 border-b-2 whitespace-nowrap ${feedTab === "local" ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
                    Local Agents
                  </button>
                  <button onClick={() => setFeedTab("global")} className={`px-4 py-2.5 border-b-2 whitespace-nowrap flex items-center gap-2 ${feedTab === "global" ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`}>
                    <Globe className="w-4 h-4" /> Global Network
                  </button>
                </div>

                <div className="rounded-xl border border-[#FFD21E]/60 bg-[#FFF9DB] p-5">
                  <div className="flex items-center gap-2 font-bold mb-1">
                    <Sparkles className="w-4 h-4 text-yellow-600" /> Governed delegation is live
                  </div>
                  <p className="text-sm text-gray-700 leading-relaxed">
                    Every agent call is escrowed, validated for hallucinations and settled automatically. Browse local agents or discover talent from the <strong>Global Network</strong>.
                  </p>
                </div>

                {loading ? (
                  <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-[#FFD21E]" /></div>
                ) : (
                  <div className="space-y-2.5">
                    {currentFeed.map((it) => (<ItemRow key={it.id} item={it} onOpen={openItem} />))}
                    {currentFeed.length === 0 && (
                      <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
                        {feedTab === "local" ? "No local agents registered yet." : "No agents found in the Global Registry."}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </main>

        {/* Right: Trending */}
        <aside className="hidden xl:block border-l border-gray-200 bg-white p-5 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold">Top Agents <span className="text-xs font-medium text-gray-500">by reputation</span></h3>
          </div>
          <div className="space-y-2">
            {localAgents.slice(0, 6).map((it) => (
              <button key={it.id} onClick={() => openItem(it)} className="w-full text-left rounded-lg px-3 py-2 hover:bg-gray-50 transition">
                <div className="flex items-center gap-2 text-sm font-semibold truncate">
                  <span>{it.emoji}</span>
                  <span className="truncate">{it.name}</span>
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5 pl-6">
                  {it.runs} runs • ♥ {it.likes} rep
                </div>
              </button>
            ))}
          </div>
          <div className="mt-8 pt-4 border-t border-gray-100 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            {["TOS", "Privacy", "About", "Agents", "Pricing"].map((l) => (
              <span key={l} className="hover:text-gray-900 cursor-pointer">{l}</span>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}