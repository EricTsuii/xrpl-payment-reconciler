// Optional smoke test against a public XRPL Testnet endpoint. Not part of CI.
// It only reads: connect, server_info, network ID, validated ledger, ledger
// stream, one ledgerClosed event, disconnect. It never creates or funds a
// wallet, signs or submits anything.
//
// Usage: pnpm test:testnet   (XRPL_PRIMARY_URL and XRPL_NETWORK_ID optional)

import { endpointProblem } from '../src/xrpl/connection-manager.service';
import { XrplLedgerClient } from '../src/xrpl/xrpl-ledger.client';

const url = process.env.XRPL_PRIMARY_URL ?? 'wss://s.altnet.rippletest.net:51233/';
const networkId = Number(process.env.XRPL_NETWORK_ID ?? '1');
const LEDGER_EVENT_TIMEOUT_MS = 30_000;

function step(message: string): void {
  process.stdout.write(`ok  ${message}\n`);
}

async function main(): Promise<void> {
  const client = new XrplLedgerClient(url);
  await client.connect();
  step(`connected to ${new URL(url).host}`);

  try {
    const info = await client.getServerInfo();
    step(`server_info: build ${info.buildVersion}, state ${info.serverState}`);

    const problem = endpointProblem(info, networkId);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    step(`network ID ${String(info.networkId)} matches, validated ledger is fresh`);

    const validated = await client.getValidatedLedgerIndex();
    step(`validated ledger ${validated}`);

    const closed = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no ledgerClosed event within 30 s')),
        LEDGER_EVENT_TIMEOUT_MS,
      );
      client.onLedgerClosed((event) => {
        clearTimeout(timer);
        resolve(event.ledgerIndex);
      });
    });
    await client.subscribeLedger();
    step('subscribed to the ledger stream');
    step(`ledgerClosed ${await closed}`);
  } finally {
    await client.disconnect();
    step('disconnected');
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
