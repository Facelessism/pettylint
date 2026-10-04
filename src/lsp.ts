#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type Finding, type Severity } from "./core.js";
import { PACKAGE_VERSION } from "./version.js";
import { detectLanguage } from "./languages/registry.js";
import { loadConfig, resolveRulesForFile, isIgnored, type PettyLintConfig, DEFAULT_CONFIG } from "./config.js";

/**
 * A deliberately small Language Server Protocol server: it speaks just
 * enough LSP (initialize, didOpen/didChange/didClose, diagnostics) to let
 * an editor show PettyLint findings inline as the person types. It is a
 * thin adapter over analyze() — the exact same engine the CLI and the
 * GitHub Action use — and implements no rule logic of its own, per the
 * project's "never create a second rule engine" rule (section 35/61).
 *
 * This intentionally does not implement the full LSP surface (no
 * completions, hovers, code actions, or incremental sync). A richer
 * editor extension can still be built later on top of the same
 * analyze() call; this file exists to prove the shape works, not to be
 * the final word on editor integration.
 */

// ---------------------------------------------------------------------------
// JSON-RPC framing (Content-Length-delimited messages over stdio)
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | undefined;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

class MessageReader {
  private buffer = Buffer.alloc(0);

  /** Feeds newly-received bytes and returns any complete messages now available. */
  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: JsonRpcMessage[] = [];

    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return messages;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        // Unrecoverable framing error: drop everything we have buffered.
        this.buffer = Buffer.alloc(0);
        return messages;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return messages; // wait for more data

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // Malformed body: skip it rather than crashing the server.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function severityToLspSeverity(severity: Severity): 1 | 2 | 3 {
  if (severity === "error") return 1; // Error
  if (severity === "warning") return 2; // Warning
  return 3; // Information (PettyLint's "notice")
}

function findingToDiagnostic(finding: Finding): unknown {
  return {
    range: {
      start: { line: Math.max(0, finding.line - 1), character: Math.max(0, finding.column - 1) },
      end: {
        line: Math.max(0, (finding.endLine ?? finding.line) - 1),
        character: Math.max(0, (finding.endColumn ?? finding.column) - 1),
      },
    },
    severity: severityToLspSeverity(finding.severity),
    code: finding.ruleId,
    source: "pettylint",
    message: finding.message,
  };
}

function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return fileURLToPath(uri); // handles Windows drive letters and percent-encoding
  } catch {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function runLspServer(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  const reader = new MessageReader();
  let workspaceRoot: string | null = null;
  let config: PettyLintConfig = DEFAULT_CONFIG;

  function send(message: JsonRpcMessage): void {
    output.write(encodeMessage(message));
  }

  function publishDiagnostics(uri: string, diagnostics: unknown[]): void {
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  }

  function analyzeAndPublish(uri: string, text: string): void {
    const filePath = uriToPath(uri);
    if (!detectLanguage(filePath)) {
      publishDiagnostics(uri, []);
      return;
    }
    const relativePath = workspaceRoot ? path.relative(workspaceRoot, filePath) : path.basename(filePath);
    if (isIgnored(config, relativePath.split(path.sep).join("/"))) {
      publishDiagnostics(uri, []);
      return;
    }
    const ruleConfig = resolveRulesForFile(config, relativePath.split(path.sep).join("/"));
    const result = analyze([{ filePath, text }], { ruleConfig });
    publishDiagnostics(uri, result.findings.map(findingToDiagnostic));
  }

  function handle(message: JsonRpcMessage): void {
    const { method, id, params } = message;
    if (method === undefined) return; // a response to a request we never send; ignore

    switch (method) {
      case "initialize": {
        const p = params as { rootUri?: string | null; workspaceFolders?: { uri: string }[] | null };
        const rootUri = p.rootUri ?? p.workspaceFolders?.[0]?.uri ?? null;
        workspaceRoot = rootUri ? uriToPath(rootUri) : null;
        try {
          config = workspaceRoot ? loadConfig(workspaceRoot) : DEFAULT_CONFIG;
        } catch (err) {
          send({
            jsonrpc: "2.0",
            method: "window/showMessage",
            params: { type: 2, message: `PettyLint: ${(err as Error).message} — using default configuration.` },
          });
          config = DEFAULT_CONFIG;
        }
        send({
          jsonrpc: "2.0",
          id,
          result: {
            capabilities: {
              textDocumentSync: 1, // full document sync
            },
            serverInfo: { name: "pettylint-lsp", version: PACKAGE_VERSION },
          },
        });
        return;
      }
      case "initialized":
        return; // notification, no response
      case "shutdown":
        send({ jsonrpc: "2.0", id, result: null });
        return;
      case "exit":
        process.exit(0);
        return; // unreachable, satisfies control-flow analysis
      case "textDocument/didOpen": {
        const p = params as { textDocument: { uri: string; text: string } };
        analyzeAndPublish(p.textDocument.uri, p.textDocument.text);
        return;
      }
      case "textDocument/didChange": {
        const p = params as { textDocument: { uri: string }; contentChanges: { text: string }[] };
        const fullText = p.contentChanges[p.contentChanges.length - 1]?.text ?? "";
        analyzeAndPublish(p.textDocument.uri, fullText);
        return;
      }
      case "textDocument/didClose": {
        const p = params as { textDocument: { uri: string } };
        publishDiagnostics(p.textDocument.uri, []);
        return;
      }
      default:
        // Unknown request: respond with "method not found" only if it expected a reply.
        if (id !== undefined) {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
        return;
    }
  }

  input.on("data", (chunk: Buffer) => {
    for (const message of reader.push(chunk)) handle(message);
  });
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  runLspServer();
}
