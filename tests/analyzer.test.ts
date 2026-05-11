import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeMintUrl } from "../src/analyzers/detectorUtils.js";
import { MintProjectConfig } from "../src/config/schema.js";

test("direct mint page analyzer saves extracted candidates into config JSON", async () => {
  const script = `
    import { createConfig, writeContract } from "wagmi";
    import { getDefaultWallets } from "@rainbow-me/rainbowkit";
    import { parseEther } from "ethers";
    export const chainId = 8453;
    export const contractAddress = "0x1234567890123456789012345678901234567890";
    export const price = parseEther("0.02");
    export const startTime = "2026-05-12T15:00:00Z";
    export const abi = [{ type: "function", name: "publicMint", inputs: [{ type: "uint256" }], stateMutability: "payable" }];
    writeContract({ address: contractAddress, abi, functionName: "publicMint", args: [1], value: price });
  `;
  const html = `
    <html>
      <body>
        <main>Public sale opens at May 12 2026 15:00 UTC. Mint price: 0.02 ETH.</main>
        <script src="/mint.js"></script>
      </body>
    </html>
  `;

  const server = createServer((request, response) => {
    if (request.url === "/mint.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(script);
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "mint-analyzer-"));
    const outputPath = path.join(outputDir, "config.json");
    const result = await analyzeMintUrl(`http://127.0.0.1:${address.port}/mint`, { outPath: outputPath, verbose: true });
    const saved = JSON.parse(await readFile(outputPath, "utf8")) as MintProjectConfig;

    assert.equal(result.kind, "directMintPage");
    assert.equal(saved.approved, false);
    assert.equal(saved.detection.confidence, "high");
    assert.deepEqual(saved.detection.candidates.contractAddresses, ["0x1234567890123456789012345678901234567890"]);
    assert.ok(saved.detection.candidates.chainIds.includes(8453));
    assert.ok(saved.detection.candidates.mintFunctionNames.includes("publicMint"));
    assert.ok(saved.detection.candidates.abiFragments.some((fragment) => fragment.includes("function publicMint(uint256)")));
    assert.ok(saved.detection.candidates.priceCandidatesEth.includes("0.02"));
    assert.ok(saved.detection.candidates.startTimeCandidates.length > 0);
    assert.ok(saved.detection.candidates.libraryHints.includes("ethers.js"));
    assert.ok(saved.detection.candidates.libraryHints.includes("wagmi"));
    assert.ok(saved.detection.candidates.libraryHints.includes("rainbowkit"));
  } finally {
    server.close();
  }
});
