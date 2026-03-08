#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE = "https://solodit.cyfrin.io/api/v1/solodit";
const SOLODIT_BASE = "https://solodit.cyfrin.io";
const API_KEY = process.env.SOLODIT_API_KEY;

if (!API_KEY) {
  console.error(`Error: SOLODIT_API_KEY not set.

To set up:
  curl -fsSL https://raw.githubusercontent.com/marchev/solodit-skills/main/install.sh | sh

Or manually:
  # Claude Code
  claude mcp add --scope user --transport stdio solodit \\
    --env SOLODIT_API_KEY=sk_your_key \\
    -- npx -y @marchev/claudit

  # Codex CLI
  codex mcp add solodit \\
    --env SOLODIT_API_KEY=sk_your_key \\
    -- npx -y @marchev/claudit

Get your key at: https://solodit.cyfrin.io → Profile → API Keys`);
  process.exit(1);
}

// ── Rate Limiter ────────────────────────────────────────────────────────────

class RateLimiter {
  private remaining: number = 20;
  private resetAt: number = 0;

  update(headers: Headers): void {
    const rem = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (rem !== null) this.remaining = parseInt(rem, 10);
    if (reset !== null) this.resetAt = parseInt(reset, 10) * 1000;
  }

  async waitIfNeeded(): Promise<void> {
    if (this.remaining <= 1 && this.resetAt > Date.now()) {
      const waitMs = this.resetAt - Date.now() + 500;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  status(): { remaining: number; resetAt: number } {
    return { remaining: this.remaining, resetAt: this.resetAt };
  }
}

const rateLimiter = new RateLimiter();

// ── Cache ───────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class SimpleCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }
}

const cache = new SimpleCache();
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 min

// Index findings by ID for fast lookup by get_finding
const findingsById = new SimpleCache();
const FINDINGS_TTL = 30 * 60 * 1000; // 30 min

function indexFindings(findings: FindingData[]): void {
  for (const f of findings) {
    findingsById.set(f.id, f, FINDINGS_TTL);
  }
}

// ── API Client ──────────────────────────────────────────────────────────────

interface SoloditFilters {
  keywords?: string;
  impact?: string[];
  firms?: { value: string }[];
  tags?: { value: string }[];
  protocol?: string;
  protocolCategory?: { value: string }[];
  forked?: { value: string }[];
  languages?: { value: string }[];
  user?: string;
  minFinders?: string;
  maxFinders?: string;
  reported?: { value: string };
  reportedAfter?: string;
  qualityScore?: number;
  rarityScore?: number;
  sortField?: string;
  sortDirection?: string;
}

interface SoloditRequest {
  page: number;
  pageSize: number;
  filters?: SoloditFilters;
}

interface FindingData {
  id: string;
  slug: string;
  title: string;
  content: string;
  summary: string | null;
  impact: string;
  quality_score: number;
  general_score: number;
  report_date: string | null;
  firm_name: string | null;
  protocol_name: string | null;
  finders_count: number;
  source_link: string | null;
  github_link: string | null;
  // NOTE: Some Solodit API responses omit these relationship arrays.
  // Treat missing/null values as "no tags/finders" instead of crashing.
  issues_issue_finders?: Array<{
    wardens_warden?: { handle: string | null } | null;
  }> | null;
  issues_issuetagscore?: Array<{
    tags_tag?: { title: string | null } | null;
  }> | null;
  protocols_protocol: {
    name: string | null;
    protocols_protocolcategoryscore: Array<{
      protocols_protocolcategory: { title: string };
      score: number;
    }>;
  } | null;
  auditfirms_auditfirm: { name: string | null } | null;
  contest_prize_txt: string | null;
  sponsor_name: string | null;
}

interface SoloditResponse {
  findings: FindingData[];
  metadata: {
    totalResults: number;
    currentPage: number;
    pageSize: number;
    totalPages: number;
    elapsed: number;
  };
  rateLimit: {
    limit: number;
    remaining: number;
    reset: number;
  };
}

async function callSoloditAPI(body: SoloditRequest): Promise<SoloditResponse> {
  await rateLimiter.waitIfNeeded();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const res = await fetch(`${API_BASE}/findings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cyfrin-API-Key": API_KEY!,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    rateLimiter.update(res.headers);

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401) {
        throw new Error(
          `Invalid API key. Get a new one at: https://solodit.cyfrin.io → Profile → API Keys`
        );
      }
      if (res.status === 429) {
        throw new Error(
          `Rate limited. Limit resets at ${new Date(rateLimiter.status().resetAt).toISOString()}. Try again shortly.`
        );
      }
      throw new Error(
        `Solodit API error (${res.status}): ${errBody.slice(0, 200)}`
      );
    }

    return (await res.json()) as SoloditResponse;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - Solodit API did not respond within 30 seconds');
    }
    throw error;
  }
}

// ── Formatters ──────────────────────────────────────────────────────────────

function findingUrl(slug: string): string {
  return `${SOLODIT_BASE}/issues/${slug}`;
}

function formatFindingSummary(f: FindingData): string {
  const tags = (f.issues_issuetagscore ?? [])
    .map((t) => t?.tags_tag?.title ?? null)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join(", ");
  const finders = (f.issues_issue_finders ?? [])
    .map((fi) => fi?.wardens_warden?.handle ?? null)
    .filter((h): h is string => typeof h === "string" && h.length > 0)
    .join(", ");

  const url = findingUrl(f.slug);
  let out = `### #${f.id} [${f.impact}] ${f.title}\n`;
  out += `${url}\n`;
  out += `**Firm:** ${f.firm_name || "Unknown"} | **Protocol:** ${f.protocol_name || "Unknown"} | **Quality:** ${f.quality_score}/5 | **Rarity:** ${f.general_score}/5\n`;
  if (tags) out += `**Tags:** ${tags}\n`;
  if (finders) out += `**Finders:** ${finders} (${f.finders_count} total)\n`;
  if (f.report_date) out += `**Date:** ${f.report_date}\n`;

  // Content snippet — break at last paragraph boundary before ~500 chars
  if (f.content) {
    if (f.content.length <= 500) {
      out += `\n${f.content.trim()}\n`;
    } else {
      const chunk = f.content.slice(0, 500);
      const paraBreak = chunk.lastIndexOf("\n\n");
      const lineBreak = chunk.lastIndexOf("\n");
      const breakAt =
        paraBreak > 100 ? paraBreak : lineBreak > 100 ? lineBreak : 500;
      out += `\n${f.content.slice(0, breakAt).trim()}...\n`;
    }
  }

  return out;
}

function formatFindingFull(f: FindingData): string {
  // Helper to escape pipe characters that break Markdown tables
  const esc = (s: string | undefined | null) => (s || "Unknown").replace(/\|/g, "\\|");

  const tags = (f.issues_issuetagscore ?? [])
    .map((t) => t?.tags_tag?.title ?? null)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join(", ");
  const finders = (f.issues_issue_finders ?? [])
    .map((fi) => fi?.wardens_warden?.handle ?? null)
    .filter((h): h is string => typeof h === "string" && h.length > 0)
    .join(", ");

  let categories = "";
  if (f.protocols_protocol?.protocols_protocolcategoryscore?.length) {
    categories = f.protocols_protocol.protocols_protocolcategoryscore
      .map((c) => c.protocols_protocolcategory.title)
      .join(", ");
  }

  const url = findingUrl(f.slug);
  let out = `# [${f.impact}] ${f.title}\n${url}\n\n`;
  out += `| Field | Value |\n|-------|-------|\n`;
  out += `| Severity | ${f.impact} |\n`;
  out += `| Firm | ${esc(f.firm_name)} |\n`;
  out += `| Protocol | ${esc(f.protocol_name)} |\n`;
  if (categories) out += `| Categories | ${esc(categories)} |\n`;
  out += `| Quality | ${f.quality_score}/5 |\n`;
  out += `| Rarity | ${f.general_score}/5 |\n`;
  if (tags) out += `| Tags | ${esc(tags)} |\n`;
  if (finders) out += `| Finders | ${esc(finders)} (${f.finders_count}) |\n`;
  if (f.report_date) out += `| Date | ${f.report_date} |\n`;
  if (f.contest_prize_txt) out += `| Prize Pool | ${esc(f.contest_prize_txt)} |\n`;
  if (f.sponsor_name) out += `| Sponsor | ${esc(f.sponsor_name)} |\n`;
  out += `| Solodit | ${url} |\n`;
  if (f.github_link) out += `| GitHub | ${f.github_link} |\n`;
  out += `\n---\n\n`;
  out += f.content || "(no content)";
  return out;
}
// ── MCP Server ──────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const server = new McpServer({
  name: "solodit",
  version: pkg.version,
});

// Tool 1: search_findings
server.tool(
  "search_findings",
  "Search Solodit's 20k+ smart contract security findings from real audits. Returns severity, firm, protocol, tags, quality score, content snippet, and Solodit URL for each finding. IMPORTANT: Each result includes a Solodit URL — always include it when presenting results to the user.",
  {
    keywords: z
      .string()
      .optional()
      .describe("Text search in title and content"),
    severity: z
      .array(z.string())
      .optional()
      .describe('Filter by severity: "HIGH", "MEDIUM", "LOW", "GAS" (case-insensitive)'),
    firms: z
      .array(z.string())
      .optional()
      .describe(
        'Audit firm names (e.g., ["Sherlock", "Code4rena", "Trail of Bits"])'
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Vulnerability tags (e.g., ["Reentrancy", "Oracle", "Flash Loan"])'
      ),
    language: z
      .string()
      .optional()
      .describe('Programming language (e.g., "Solidity", "Rust", "Cairo")'),
    protocol: z
      .string()
      .optional()
      .describe("Protocol name (partial match)"),
    reported: z
      .enum(["30", "60", "90", "alltime"])
      .optional()
      .describe("Time period filter"),
    sort_by: z
      .enum(["Recency", "Quality", "Rarity"])
      .optional()
      .describe("Sort order (default: Recency)"),
    sort_direction: z
      .enum(["Desc", "Asc"])
      .optional()
      .describe("Sort direction (default: Desc)"),
    page: z.number().int().min(1).optional().describe("Page number (default 1)"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results per page (default 10, max 100). Use 'page' to paginate."),
    advanced_filters: z
      .object({
        quality_score: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe("Minimum quality score (0-5)"),
        rarity_score: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe("Minimum rarity score (0-5)"),
        user: z
          .string()
          .optional()
          .describe("Finder/auditor handle (partial match)"),
        min_finders: z.number().int().optional().describe("Minimum finders"),
        max_finders: z.number().int().optional().describe("Maximum finders"),
        reported_after: z
          .string()
          .optional()
          .describe(
            "ISO date string for findings after this date (overrides top-level 'reported' filter)"
          ),
        protocol_category: z
          .array(z.string())
          .optional()
          .describe(
            'Protocol categories (e.g., ["DeFi", "Lending", "DEX"])'
          ),
        forked: z
          .array(z.string())
          .optional()
          .describe("Forked protocol names"),
      })
      .optional()
      .describe("Advanced filters for niche queries"),
  },
  async (params) => {
    const page = params.page ?? 1;
    const pageSize = params.page_size ?? 10;

    // Build API filters
    const filters: SoloditFilters = {};

    if (params.keywords) filters.keywords = params.keywords;
    if (params.severity) filters.impact = params.severity.map(s => s.toUpperCase());
    if (params.firms)
      filters.firms = params.firms.map((v) => ({ value: v }));
    if (params.tags) filters.tags = params.tags.map((v) => ({ value: v }));
    if (params.language)
      filters.languages = [{ value: params.language }];
    if (params.protocol) filters.protocol = params.protocol;
    if (params.reported)
      filters.reported = { value: params.reported };
    if (params.sort_by) {
      filters.sortField = params.sort_by;
      filters.sortDirection = params.sort_direction ?? "Desc";
    }

    // Advanced filters
    const adv = params.advanced_filters;
    if (adv) {
      if (adv.quality_score !== undefined)
        filters.qualityScore = adv.quality_score;
      if (adv.rarity_score !== undefined)
        filters.rarityScore = adv.rarity_score;
      if (adv.user) filters.user = adv.user;
      if (adv.min_finders !== undefined)
        filters.minFinders = String(adv.min_finders);
      if (adv.max_finders !== undefined)
        filters.maxFinders = String(adv.max_finders);
      if (adv.reported_after) {
        // reported_after requires reported="after"; overrides top-level reported
        filters.reported = { value: "after" };
        filters.reportedAfter = adv.reported_after;
      }
      if (adv.protocol_category)
        filters.protocolCategory = adv.protocol_category.map((v) => ({
          value: v,
        }));
      if (adv.forked)
        filters.forked = adv.forked.map((v) => ({ value: v }));
    }

    const body: SoloditRequest = { page, pageSize, filters };
    const cacheKey = JSON.stringify(body);
    const cached = cache.get<SoloditResponse>(cacheKey);

    let data: SoloditResponse;
    if (cached) {
      data = cached;
    } else {
      data = await callSoloditAPI(body);
      cache.set(cacheKey, data, SEARCH_CACHE_TTL);
      indexFindings(data.findings);
    }

    const { metadata, rateLimit } = data;

    let output = `**${metadata.totalResults} findings found** (page ${metadata.currentPage}/${metadata.totalPages}, ${pageSize}/page)\n`;
    if (rateLimit.remaining <= 5) {
      output += `**Warning:** Rate limit low — ${rateLimit.remaining}/${rateLimit.limit} remaining\n`;
    }
    output += `\n---\n\n`;

    if (data.findings.length === 0) {
      output += "No findings match your query. Try broadening your filters.";
    } else {
      for (const f of data.findings) {
        output += formatFindingSummary(f) + "\n---\n\n";
      }
    }

    return { content: [{ type: "text" as const, text: output }] };
  }
);

// Tool 2: get_finding
server.tool(
  "get_finding",
  "Get full details for a specific Solodit finding by its numeric ID (preferred), URL, or slug. Returns complete markdown content and all metadata.",
  {
    identifier: z
      .string()
      .describe(
        "Finding numeric ID (e.g., '64195'), Solodit URL, or finding slug. Prefer numeric ID from search results."
      ),
  },
  async (params) => {
    let slug = params.identifier;

    // Check if identifier is a numeric ID — instant lookup from cache
    const numericId = slug.replace(/^#/, "").trim();
    if (/^\d+$/.test(numericId)) {
      const cached = findingsById.get<FindingData>(numericId);
      if (cached) {
        return {
          content: [{ type: "text" as const, text: formatFindingFull(cached) }],
        };
      }
      // Not in cache — fall through to keyword search using ID
    }

    // Extract slug from URL if needed
    if (slug.includes("solodit.cyfrin.io/issues/")) {
      const match = slug.match(/\/issues\/([^/?#]+)/);
      if (match) slug = match[1];
    }

    // Convert slug to search keywords — use first ~8 meaningful words
    const words = slug.replace(/-/g, " ").trim().split(/\s+/);
    const keywords = words.slice(0, 8).join(" ");

    // Search for the finding
    const data = await callSoloditAPI({
      page: 1,
      pageSize: 20,
      filters: { keywords },
    });
    indexFindings(data.findings);

    // Try to match by slug or ID
    let finding = data.findings.find((f) => f.slug === slug || f.id === numericId);
    let inexactMatch = false;

    // If no exact match, retry with fewer keywords
    if (!finding) {
      const shortKeywords = words.slice(0, 5).join(" ");
      const retry = await callSoloditAPI({
        page: 1,
        pageSize: 20,
        filters: { keywords: shortKeywords },
      });
      indexFindings(retry.findings);
      finding = retry.findings.find((f) => f.slug === slug || f.id === numericId);
      if (!finding && retry.findings.length > 0) {
        finding = retry.findings[0];
        inexactMatch = true;
      }
    }

    if (!finding && data.findings.length > 0) {
      finding = data.findings[0];
      inexactMatch = true;
    }

    if (!finding) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Finding not found for: ${params.identifier}\n\nTry using search_findings with keywords instead.`,
          },
        ],
      };
    }

    let output = "";
    if (inexactMatch) {
      output += `> **Note:** Exact match not found for "${slug}". Showing closest result.\n\n`;
    }
    output += formatFindingFull(finding);

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// Tool 3: get_filter_options
server.tool(
  "get_filter_options",
  "List available filter values for Solodit search (firms, tags, categories, languages). Use this to discover valid values for search_findings filters.",
  {},
  async () => {
    const output = `# Solodit Filter Options

## Severity Levels
HIGH, MEDIUM, LOW, GAS

## Audit Firms (use exact names below)
- Code4rena (12,217)
- Zokyo (3,376)
- OpenZeppelin (3,237)
- Pashov Audit Group (3,002)
- Cantina (2,940)
- Sherlock (2,876)
- Halborn (2,649)
- Quantstamp (2,556)
- MixBytes (2,364)
- OtterSec (2,273)
- Spearbit (2,188)
- TrailOfBits (2,086)
- Cyfrin (1,573)
- ConsenSys (1,381)
- Codehawks (1,234)
- SigmaPrime (982)
- Shieldify (519)
- Immunefi (376)
- Trust Security (262)
- Hexens (228)

## Vulnerability Tags (use exact names below)
- Business Logic (233)
- Validation (126)
- Wrong Math (107)
- Front-Running (106)
- DOS (66)
- Fee On Transfer (65)
- Oracle (59)
- Reentrancy (59)
- Access Control (48)
- Don't update state (47)
- Decimals (45)
- Liquidation (42)
- Overflow/Underflow (42)
- Admin (36)
- Denial-Of-Service (36)
- Slippage (36)
- Missing-Logic (33)
- Rounding (32)
- Stale Price (31)
- ERC4626 (27)
- First Depositor Issue (26)
- Chainlink (25)
- Flash Loan (25)
- Weird ERC20 (25)
- Configuration (24)
- ERC20 (23)
- Missing Check (23)
- Fund Lock (22)
- Uniswap (22)
- Vote (22)

## Protocol Categories (use exact names below)
- Dexes (328)
- CDP (305)
- Services (285)
- Cross Chain (245)
- Yield (119)
- Liquid Staking (102)
- Synthetics (77)
- Staking Pool (61)
- Yield Aggregator (54)
- Payments (53)
- Bridge (50)
- Launchpad (50)
- RWA (44)
- Leveraged Farming (40)
- Indexes (32)
- Liquidity manager (27)
- Options Vault (23)
- Oracle (18)
- Derivatives (17)
- Lending (13)
- Privacy (13)
- Insurance (12)
- NFT Marketplace (12)
- NFT Lending (11)
- Algo-Stables (10)
- RWA Lending (10)
- Gaming (7)
- Prediction Market (4)
- Farm (2)
- Decentralized Stablecoin (1)
- Reserve Currency (1)
- Uncollateralized Lending (1)

## Programming Languages
- Solidity (43,442)
- Rust (2,652)
- Go (1,017)
- Move (651)
- TypeScript (544)
- Vyper (404)
- FunC (229)
- JavaScript (156)
- Cairo (110)
- Dart (89)
- Python (86)
- Circom (59)
- Cosmos (48)
- Sway (23)
- Yul (23)
- Noir (3)
- Tact (3)

## Sort Options
- Recency (default)
- Quality
- Rarity

## Sort Direction
- Desc (default)
- Asc

## Time Periods (reported)
- 30 (last 30 days)
- 60 (last 60 days)
- 90 (last 90 days)
- alltime

## Advanced Filter Fields
- quality_score: 0-5 (minimum quality threshold)
- rarity_score: 0-5 (minimum rarity threshold)
- user: Finder/auditor handle (partial match)
- min_finders / max_finders: Filter by number of finders (solo vs many)
- reported_after: ISO date string
- protocol_category: Array of category names (see Protocol Categories above)
- forked: Array of forked protocol names

*Note: Use the exact values listed above for best results. Counts shown in parentheses indicate the number of findings/protocols available.*`;

    return { content: [{ type: "text" as const, text: output }] };
  }
);

// Tool 4: get_claudit_version
server.tool(
  "get_claudit_version",
  "Returns the currently running version of the Claudit MCP server.",
  {},
  async () => ({
    content: [{ type: "text" as const, text: `Claudit v${pkg.version}` }],
  })
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
