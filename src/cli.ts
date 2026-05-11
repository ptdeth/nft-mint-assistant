import { Command } from "commander";

import { analyzeMintUrl } from "./analyzers/detectorUtils.js";
import { MintProjectConfig } from "./config/schema.js";
import { loadMintConfig } from "./config/loadConfig.js";
import { dryRunMintConfig, DryRunSummary, executeMintConfig, MintExecutionSummary } from "./chains/evmExecutor.js";
import { supportedChainsSummary } from "./chains/chainRegistry.js";
import { createLogger } from "./logs/logger.js";

const logger = createLogger("cli");

export async function runCli(): Promise<void> {
  const program = new Command();

  program
    .name("nft-mint-assistant")
    .description("Safety-first NFT mint assistant for user-controlled EVM wallets.")
    .version("0.1.0");

  program
    .command("analyze")
    .requiredOption("--url <url>", "NFT mint page URL or OpenSea collection URL")
    .option("--out <path>", "Path for generated project config JSON")
    .option("--verbose", "Print extracted analyzer candidates")
    .description("Analyze a URL and prepare a draft mint config. Execution is never performed.")
    .action(async (options: { url: string; out?: string; verbose?: boolean }) => {
      await runAction(async () => {
        const analyzeOptions = {
          ...(options.out ? { outPath: options.out } : {}),
          verbose: options.verbose ?? false
        };
        const result = await analyzeMintUrl(options.url, analyzeOptions);
        logger.info({ confidence: result.confidence, outputPath: result.outputPath }, "analysis complete");
        if (options.verbose) {
          printAnalyzeVerboseSummary(result.config);
        }
        console.log(JSON.stringify(result, null, 2));
      });
    });

  program
    .command("dryrun")
    .requiredOption("--config <path>", "Path to a mint project config JSON")
    .description("Validate config, estimate gas, check balances, and print a no-send transaction summary.")
    .action(async (options: { config: string }) => {
      await runAction(async () => {
        const config = await loadMintConfig(options.config);
        logger.info({ project: config.projectName, chainId: config.chainId }, "config loaded");
        const summary = await dryRunMintConfig(config);
        printDryRunSummary(summary);
      });
    });

  program
    .command("mint")
    .requiredOption("--config <path>", "Path to an approved mint project config JSON")
    .description("Execute approved mint transactions with safety limits and transaction logging.")
    .action(async (options: { config: string }) => {
      await runAction(async () => {
        const config = await loadMintConfig(options.config);
        logger.warn({ project: config.projectName }, "mint execution requested");
        const summary = await executeMintConfig(config);
        printMintExecutionSummary(summary);
      });
    });

  program
    .command("chains")
    .description("List supported EVM chains.")
    .action(() => {
      console.table(supportedChainsSummary());
    });

  await program.parseAsync(process.argv);
}

function printAnalyzeVerboseSummary(config: MintProjectConfig): void {
  const candidates = config.detection.candidates;
  console.log("");
  console.log("Analyzer Candidates");
  console.log("===================");
  console.log(`Contracts: ${candidates.contractAddresses.length > 0 ? candidates.contractAddresses.join(", ") : "none"}`);
  console.log(`Chain IDs: ${candidates.chainIds.length > 0 ? candidates.chainIds.join(", ") : "none"}`);
  console.log(`Mint functions: ${candidates.mintFunctionNames.length > 0 ? candidates.mintFunctionNames.join(", ") : "none"}`);
  console.log(`ABI fragments: ${candidates.abiFragments.length}`);
  console.log(`ETH prices: ${candidates.priceCandidatesEth.length > 0 ? candidates.priceCandidatesEth.join(", ") : "none"}`);
  console.log(`Start times: ${candidates.startTimeCandidates.length > 0 ? candidates.startTimeCandidates.join(" | ") : "none"}`);
  console.log(`Libraries: ${candidates.libraryHints.length > 0 ? candidates.libraryHints.join(", ") : "none"}`);
  console.log(`Sources: ${candidates.sourceUrls.length > 0 ? candidates.sourceUrls.join(", ") : "none"}`);
}

async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error("");
    console.error("Command failed");
    console.error("==============");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function printDryRunSummary(summary: DryRunSummary): void {
  console.log("");
  console.log("EVM Dry Run Summary");
  console.log("===================");
  console.log(`Project: ${summary.projectName}`);
  console.log(`Source: ${summary.sourceUrl}`);
  console.log(`Chain: ${summary.chain.name} (${summary.chain.chainId})`);
  console.log(`Contract: ${summary.contractAddress}`);
  console.log(`Function: ${summary.mintFunction}`);
  console.log(`Args: ${JSON.stringify(summary.args)}`);
  console.log(`Quantity: ${summary.quantity}`);
  console.log(`Tx value: ${summary.valueEth} ETH`);
  console.log(`Detection confidence: ${summary.confidence}`);
  console.log(`Approved now: ${summary.approved ? "yes" : "no"}`);
  console.log("");
  console.log("Wallet checks");
  console.log("-------------");

  for (const wallet of summary.wallets) {
    console.log(`${wallet.label} (${wallet.address})`);
    console.log(`  Balance: ${wallet.balanceEth} ETH`);
    console.log(`  Estimated gas: ${wallet.estimatedGasUnits ?? "unavailable"}`);
    console.log(`  Gas price used: ${wallet.gasPriceGwei ?? "unavailable"} gwei`);
    console.log(`  Estimated gas cost: ${wallet.estimatedGasCostEth ?? "unavailable"} ETH`);
    console.log(`  Estimated total cost: ${wallet.estimatedTotalCostEth ?? "unavailable"} ETH`);
    console.log(`  Sufficient balance: ${wallet.hasSufficientBalance ? "yes" : "no"}`);
    console.log(`  Static call: ${wallet.staticCall.ok ? "ok" : "not ok"} - ${wallet.staticCall.message}`);
  }

  console.log("");
  console.log("Totals");
  console.log("------");
  console.log(`Wallets checked: ${summary.totals.walletCount}`);
  console.log(`Estimated total spend: ${summary.totals.estimatedTotalSpendEth} ETH`);

  if (summary.warnings.length > 0) {
    console.log("");
    console.log("Warnings");
    console.log("--------");
    for (const warning of summary.warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log("");
  console.log(`Can proceed to manual approval: ${summary.canProceedToApproval ? "yes" : "no"}`);
  console.log("No transaction was sent.");
}

function printMintExecutionSummary(summary: MintExecutionSummary): void {
  console.log("");
  console.log("Mint Execution Summary");
  console.log("======================");
  console.log(`Project: ${summary.projectName}`);
  console.log(`Chain ID: ${summary.chainId}`);
  console.log(`Contract: ${summary.contractAddress}`);
  console.log(`Transactions sent: ${summary.sentCount}`);
  console.log(`Successful receipts: ${summary.successCount}`);
  console.log(`Stopped because: ${summary.stoppedReason}`);
  console.log(`Log file: ${summary.logPath}`);
  console.log("");
  console.log("Wallet results");
  console.log("--------------");

  for (const wallet of summary.wallets) {
    console.log(`${wallet.label} (${wallet.address})`);
    console.log(`  Attempts: ${wallet.attempts}`);
    console.log(`  Success: ${wallet.success ? "yes" : "no"}`);
    if (wallet.txHash) {
      console.log(`  Tx hash: ${wallet.txHash}`);
    }
    if (wallet.status !== undefined) {
      console.log(`  Receipt status: ${wallet.status}`);
    }
    if (wallet.gasUsed) {
      console.log(`  Gas used: ${wallet.gasUsed}`);
    }
    if (wallet.error) {
      console.log(`  Last error: ${wallet.error}`);
    }
  }
}
