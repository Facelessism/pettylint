import { describe, it, expect, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { runLspServer } from "../src/lsp.js";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
}

function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: RpcMessage[] = [];
  let buffer = Buffer.alloc(0);

  output.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/.exec(header);
      if (!match) break;
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      received.push(JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8")));
      buffer = buffer.subarray(bodyStart + length);
    }
  });

  runLspServer(input, output);

  return {
    send: (message: unknown) => input.write(encode(message)),
    received,
    waitForCount: async (count: number, timeoutMs = 500) => {
      const start = Date.now();
      while (received.length < count && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

/** Extracts the diagnostics array from the message at `index`, failing loudly if it is missing. */
function diagnosticsAt(messages: RpcMessage[], index: number): { code?: string }[] {
  const message = messages[index];
  if (!message) throw new Error(`expected an LSP message at index ${index}, got ${messages.length} message(s)`);
  return (message.params as { diagnostics: { code?: string }[] }).diagnostics;
}

describe("LSP server (thin adapter over analyze())", () => {
  let ctx: ReturnType<typeof harness>;

  beforeEach(() => {
    ctx = harness();
  });

  it("responds to initialize with server capabilities", async () => {
    ctx.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null, workspaceFolders: null } });
    await ctx.waitForCount(1);
    expect(ctx.received[0]).toMatchObject({
      id: 1,
      result: { capabilities: { textDocumentSync: 1 } },
    });
  });

  it("publishes diagnostics on didOpen using the same rules as the CLI/Action", async () => {
    ctx.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null } });
    await ctx.waitForCount(1);
    ctx.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///tmp/x.ts", text: "console.log(1);\ndebugger;\n" } },
    });
    await ctx.waitForCount(2);
    expect(diagnosticsAt(ctx.received, 1).map((d) => d.code)).toEqual(["PL001", "PL002"]);
  });

  it("re-analyzes on didChange (full sync) and reflects the new content", async () => {
    ctx.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null } });
    await ctx.waitForCount(1);
    ctx.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///tmp/x.ts", text: "console.log(1);\n" } },
    });
    await ctx.waitForCount(2);
    ctx.send({
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: { textDocument: { uri: "file:///tmp/x.ts" }, contentChanges: [{ text: "const x = 1;\n" }] },
    });
    await ctx.waitForCount(3);
    expect(diagnosticsAt(ctx.received, 2)).toEqual([]);
  });

  it("clears diagnostics on didClose", async () => {
    ctx.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null } });
    await ctx.waitForCount(1);
    ctx.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///tmp/x.ts", text: "debugger;\n" } },
    });
    await ctx.waitForCount(2);
    ctx.send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: "file:///tmp/x.ts" } } });
    await ctx.waitForCount(3);
    expect(diagnosticsAt(ctx.received, 2)).toEqual([]);
  });

  it("ignores files with unsupported extensions rather than erroring", async () => {
    ctx.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null } });
    await ctx.waitForCount(1);
    ctx.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///tmp/notes.txt", text: "debugger;\n" } },
    });
    await ctx.waitForCount(2);
    expect(diagnosticsAt(ctx.received, 1)).toEqual([]);
  });

  it("responds to shutdown with a null result", async () => {
    ctx.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: null } });
    await ctx.waitForCount(1);
    ctx.send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
    await ctx.waitForCount(2);
    expect(ctx.received[1]).toMatchObject({ id: 2, result: null });
  });
});
