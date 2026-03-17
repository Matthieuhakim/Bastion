// ── OpenClaw Plugin API (minimal surface — aligned to released runtime) ──────

export interface OpenClawLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface OpenClawService {
  id: string;
  start?: () => void;
  stop?: () => void;
}

export interface OpenClawToolTextContent {
  type: 'text';
  text: string;
}

export interface OpenClawToolResult {
  content: OpenClawToolTextContent[];
  details?: unknown;
}

export interface OpenClawToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string | undefined,
    params: unknown,
  ): Promise<OpenClawToolResult> | OpenClawToolResult;
}

export interface OpenClawPluginApi {
  pluginConfig?: Record<string, unknown>;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerTool(tool: OpenClawToolDefinition): void;
  registerService(service: OpenClawService): void;
  logger: OpenClawLogger;
}

export interface BeforeCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export type BeforeCallResult =
  | {
      params?: Record<string, unknown>;
      block?: boolean;
      blockReason?: string;
    }
  | undefined;

// ── Plugin Config ─────────────────────────────────────────────────────────────

/** Resolves to a secret string at runtime. */
export type SecretValue = string | { $env: string } | { $file: string } | { $exec: string };

export interface InjectionConfig {
  location: 'header' | 'query' | 'body';
  key: string;
}

/**
 * Dot-path mappings from tool args into Bastion policy params.
 * e.g. amount: "body.amount" extracts args.body.amount as a number.
 */
export interface ParamsMapping {
  amount?: string;
  ip?: string;
}

export interface InterceptionRule {
  /**
   * Optional tool name to block for this URL pattern.
   * Example: "web_fetch" to prevent bypassing `bastion_fetch`.
   */
  tool?: string;
  /** Glob pattern for the URL (e.g. "https://api.stripe.com/**"). */
  urlPattern: string;
  /** Bastion credential ID to use for this call. */
  credentialId: string;
  /** Bastion action name (e.g. "stripe.charges"). */
  action: string;
  /** Override default credential injection location. */
  injection?: InjectionConfig;
  /** Extract policy params from tool args. */
  params?: ParamsMapping;
}

export interface BastionPluginConfig {
  /** URL of the Bastion server (e.g. "http://localhost:3000"). */
  serverUrl: string;
  /** Agent secret (bst_... token) — supports SecretRef pattern. */
  agentSecret: SecretValue;
  /** Ordered list of protected routes. First match wins. */
  rules: InterceptionRule[];
  /** Request timeout in ms. Default: 30000. */
  timeout?: number;
}

export interface BastionFetchToolInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface BastionFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown | null;
  url: string;
  _bastion: {
    credentialId: string;
    action: string;
    policyDecision: string;
    durationMs: number;
    hitlRequestId?: string;
  };
}
